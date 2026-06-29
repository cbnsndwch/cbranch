// Interactive rebase (REQ-P5-IR-001..013) — scripted, fully non-interactive.
//
// cbranch never lets git open a terminal editor. `rebaseStart` writes a complete
// `git-rebase-todo` and feeds it to `git rebase -i` through a `GIT_SEQUENCE_EDITOR`
// shim; `reword`/`squash` messages are authored in the UI and baked into the todo as
// `exec git commit --amend -F <msgfile>` lines (GIT_EDITOR is a no-op `true`). State
// is read from git's machine files under the git dir (backend-aware over
// `rebase-merge/` and `rebase-apply/`), never from localized stderr (NF-GIT-3).
//
// Continue/Skip/Abort are the shipped P4 sequencer surface (they resolve `rebase`
// via `detectInProgress`); this module adds only plan / start / status.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type GitError,
  Oid,
  OperationProgress,
  RebasePlan,
  RebaseStatus,
  type RebaseStep,
  type RebaseStopReason,
  RebaseTodoCommit,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { detectInProgress } from "../repo/state";
import { gitError } from "./errors";
import {
  assertNoLeadingDash,
  decodeUtf8,
  isHexOid,
  runGit,
  runGitOk,
} from "./run-git";

/** Unit separator between commit fields (never present in any field). */
const FS = "\x1f";

/** `git log --format` tokens for one todo row — oid, author, date, subject, body. */
export const REBASE_LOG_FORMAT = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join(
  FS,
);

// ── shim path ──────────────────────────────────────────────────────────────────

/**
 * Absolute path to the scripted sequence-editor shim, resolved relative to THIS
 * module so the same `./shims/rebase-seq-editor.mjs` works both in the source tree
 * (vitest) and in the web-server bundle, where `apps/web-server/build.mjs` copies it
 * to `dist/shims/`. Centralized so the engine and the packaging step agree — a
 * divergence escapes lint/typecheck/build/vitest (which all run the source-tree shim).
 */
export const defaultShimPath = (): string =>
  fileURLToPath(new URL("./shims/rebase-seq-editor.mjs", import.meta.url));

/** POSIX single-quote a value for a todo `exec` line (the only string we shell-quote). */
export const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

/**
 * Best-effort removal of the scripted-rebase sidecar (`<gitDir>/cbranch-rebase/`, the
 * authored todo + exec-amend message files). A successful `rebaseStart` clears it inline,
 * but a rebase that stops and is later resolved via the reused Continue/Skip/Abort surface
 * leaves it behind — the engine calls this once that sequencer op ends the rebase.
 *
 * The reap is best-effort and never throws: the engine runs it in an `Effect.tap` AFTER
 * the Continue/Skip/Abort has already succeeded, so a transient EPERM/EBUSY (e.g. an AV
 * scanner or indexer holding a sidecar handle) must not turn that succeeded RPC into a
 * defect. `force: true` already swallows a missing dir; the catch covers the rest.
 */
export const cleanupRebaseSidecar = (gitDir: string): void => {
  try {
    rmSync(join(gitDir, "cbranch-rebase"), { recursive: true, force: true });
  } catch {
    // ignore — see above; leaving the sidecar behind is harmless.
  }
};

// ── plan (read) ──────────────────────────────────────────────────────────────────

/** Parse `git log -z` records into oldest-first rebase todo commits. */
export const parseRebaseTodoCommits = (
  stdout: Buffer,
): ReadonlyArray<RebaseTodoCommit> => {
  const rows: RebaseTodoCommit[] = [];
  for (const record of decodeUtf8(stdout).split("\0")) {
    if (record === "") continue;
    const fields = record.split(FS);
    if (fields.length < 6) continue;
    // body is the last field and may itself contain FS — rejoin the remainder.
    const [oid, authorName, authorEmail, authorDate, subject, ...bodyParts] =
      fields as [string, string, string, string, string, ...string[]];
    rows.push(
      new RebaseTodoCommit({
        oid: Oid.make(oid),
        authorName,
        authorEmail,
        authorDate,
        subject,
        body: bodyParts.join(FS),
      }),
    );
  }
  return rows;
};

/**
 * Build the `git log` argv for the rebase range (exported for argv coverage).
 * `--topo-order` matches `git rebase -i`'s replay order for non-linear ranges, so the
 * planned/replayed step order can never diverge from git's (date order would).
 */
export const buildRebasePlanArgs = (
  upstream: string,
): ReadonlyArray<string> => [
  "log",
  "-z",
  "--topo-order",
  "--reverse",
  "--no-merges",
  `--format=${REBASE_LOG_FORMAT}`,
  `${upstream}..HEAD`,
];

export const rebasePlan = (
  cwd: string,
  upstream: string,
  onto?: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<RebasePlan, GitError> =>
  Effect.gen(function* () {
    yield* assertNoLeadingDash(upstream, "rebase upstream");
    if (onto !== undefined) yield* assertNoLeadingDash(onto, "rebase onto");
    const log = yield* runGitOk({
      cwd,
      args: buildRebasePlanArgs(upstream),
      env,
    });
    return new RebasePlan({
      upstream,
      onto,
      commits: parseRebaseTodoCommits(log.stdout),
    });
  });

// ── todo rewrite (pure) ──────────────────────────────────────────────────────────

const isBlank = (s: string | undefined): boolean =>
  s === undefined || s.trim() === "";

/**
 * For the kept (non-drop) steps, the index into `kept` of the ONE step whose message the
 * combined exec-amend consumes per group: the last squash of the group, or the group's
 * reword base when it has no squash. Exactly these steps must carry a non-empty message
 * (and exactly these are the messages `buildRebaseTodo` writes) — a reword that is folded
 * into a following squash, and the non-last squashes of a group, contribute no message.
 */
const consumedMessageIndices = (
  kept: ReadonlyArray<RebaseStep>,
): ReadonlyArray<number> => {
  const out: number[] = [];
  let i = 0;
  while (i < kept.length) {
    let j = i + 1;
    let lastSquash = -1;
    while (
      j < kept.length &&
      (kept[j].action === "fixup" || kept[j].action === "squash")
    ) {
      if (kept[j].action === "squash") lastSquash = j;
      j += 1;
    }
    if (lastSquash >= 0) out.push(lastSquash);
    else if (kept[i].action === "reword") out.push(i);
    i = j;
  }
  return out;
};

/**
 * Validate an authored step list (REQ-P5-IR-005); returns an error message, or null
 * when valid. A single `kept[0]` check covers both "first row not squash/fixup" and
 * "every squash/fixup has a preceding non-drop" (anything after kept[0] does). Only the
 * messages the rebase actually applies (one per group — see {@link consumedMessageIndices})
 * must be non-empty, so we never demand a message that the todo rewrite then discards;
 * empty ones are rejected here, NOT papered over with `--allow-empty-message`.
 */
export const validateRebasePlan = (
  steps: ReadonlyArray<RebaseStep>,
): string | null => {
  const kept = steps.filter((s) => s.action !== "drop");
  if (kept.length === 0) return "the rebase plan drops every commit";
  if (kept[0].action === "squash" || kept[0].action === "fixup")
    return "the first commit cannot be a squash or fixup";
  for (const idx of consumedMessageIndices(kept)) {
    if (isBlank(kept[idx].message))
      return kept[idx].action === "reword"
        ? "a reworded commit needs a non-empty message"
        : "a squashed commit needs a non-empty message";
  }
  return null;
};

export interface RebaseTodoBuild {
  readonly todo: string;
  readonly msgFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
}

/**
 * Rewrite the authored steps into a fully-scripted todo (REQ-P5-IR-006/007). cbranch
 * never uses git's native `reword`/`squash` verbs (they block on an editor); instead:
 *   pick         → `pick <oid>`
 *   reword       → `pick <oid>` + amend-exec with the new message
 *   fixup        → `fixup <oid>` (discards this commit's own message)
 *   squash group → base + `fixup`(s) + ONE combined amend-exec
 *   edit         → `edit <oid>` (pauses; trailing fixups apply on continue)
 *   drop         → omitted
 * One amend-exec per group carries the group's single message (REQ-P5-IR-007): the LAST
 * squash's message when the group has a squash, else the reword base's message. A reword
 * base that is folded into a following squash is thus a plain `pick` and the squash
 * message wins (the squash's combined message is the final word; validation does not
 * demand the absorbed reword message). Replay order is the step order, top-to-bottom.
 * Message bytes live in sidecar files (paths from `msgPath`), single-quote-escaped into
 * the `exec` line — no commit message, oid, or author string ever reaches a shell.
 */
export const buildRebaseTodo = (
  steps: ReadonlyArray<RebaseStep>,
  msgPath: (k: number) => string,
): RebaseTodoBuild => {
  const kept = steps.filter((s) => s.action !== "drop");
  const lines: string[] = [];
  const msgFiles: { path: string; content: string }[] = [];

  const amendExec = (message: string): void => {
    const path = msgPath(msgFiles.length);
    msgFiles.push({ path, content: message });
    lines.push(`exec git commit --amend -F ${shellSingleQuote(path)}`);
  };

  let i = 0;
  while (i < kept.length) {
    const base = kept[i];
    let j = i + 1;
    let lastSquash = -1;
    const followers: RebaseStep[] = [];
    while (
      j < kept.length &&
      (kept[j].action === "fixup" || kept[j].action === "squash")
    ) {
      if (kept[j].action === "squash") lastSquash = j;
      followers.push(kept[j]);
      j += 1;
    }
    lines.push(`${base.action === "edit" ? "edit" : "pick"} ${base.oid}`);
    for (const f of followers) lines.push(`fixup ${f.oid}`);
    if (lastSquash >= 0) amendExec(kept[lastSquash].message ?? "");
    else if (base.action === "reword") amendExec(base.message ?? "");
    i = j;
  }

  return { todo: `${lines.join("\n")}\n`, msgFiles };
};

// ── status (read) ────────────────────────────────────────────────────────────────

const readText = (...segments: string[]): string | undefined => {
  try {
    return readFileSync(join(...segments), "utf8");
  } catch {
    return undefined;
  }
};
const readFirstLine = (...segments: string[]): string | undefined => {
  const text = readText(...segments);
  if (text === undefined) return undefined;
  const line = text.split("\n", 1)[0]?.trim();
  return line === undefined || line === "" ? undefined : line;
};
const readNum = (...segments: string[]): number | undefined => {
  const line = readFirstLine(...segments);
  if (line === undefined) return undefined;
  const n = Number.parseInt(line, 10);
  return Number.isFinite(n) ? n : undefined;
};
/** The last non-empty line of `rebase-merge/done` — the todo step that stopped. */
const lastDoneLine = (mergeDir: string): string | undefined => {
  const text = readText(mergeDir, "done");
  if (text === undefined) return undefined;
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.length === 0 ? undefined : lines[lines.length - 1];
};

export const rebaseStatus = (
  cwd: string,
  gitDir: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<RebaseStatus, GitError> =>
  Effect.gen(function* () {
    const mergeDir = join(gitDir, "rebase-merge");
    const applyDir = join(gitDir, "rebase-apply");
    const inMerge = existsSync(mergeDir);
    // `rebase-apply/` with an `applying` marker is `git am`, not a rebase.
    const inApply =
      !inMerge &&
      existsSync(applyDir) &&
      !existsSync(join(applyDir, "applying"));
    if (!inMerge && !inApply)
      return new RebaseStatus({ inProgress: false, stopReason: "none" });

    const dir = inMerge ? mergeDir : applyDir;
    const current = inMerge
      ? readNum(mergeDir, "msgnum")
      : readNum(applyDir, "next");
    const total = inMerge
      ? readNum(mergeDir, "end")
      : readNum(applyDir, "last");
    const onto = readFirstLine(dir, "onto");
    const headName = readFirstLine(dir, "head-name");
    const stoppedSha = inMerge
      ? readFirstLine(mergeDir, "stopped-sha")
      : readFirstLine(applyDir, "original-commit");

    const progress =
      current !== undefined && total !== undefined
        ? new OperationProgress({
            current,
            total,
            currentOid:
              stoppedSha !== undefined ? Oid.make(stoppedSha) : undefined,
          })
        : undefined;

    // Stop reason — totalized from machine state, never localized stderr.
    const unmerged = yield* runGitOk({
      cwd,
      args: ["ls-files", "-u", "-z"],
      env,
    });
    const doneVerb = inMerge
      ? lastDoneLine(mergeDir)?.split(/\s+/, 1)[0]
      : undefined;
    let stopReason: RebaseStopReason;
    let detail: string | undefined;
    if (unmerged.stdout.length > 0) {
      stopReason = "conflict";
    } else if (doneVerb === "edit" || doneVerb === "e") {
      stopReason = "edit";
    } else if (doneVerb === "exec" || doneVerb === "x") {
      // A failed `exec`-amend (the `done` step that stopped is the exec itself). Steer the
      // UI to Abort, NOT a plain Continue — which would skip the failed exec and silently
      // drop the amend it carried.
      stopReason = "execFailed";
      detail = lastDoneLine(mergeDir);
    } else {
      // Any other in-progress, conflict-free stop resumes with a plain Continue/Skip: a
      // `break` pause, or an apply-backend stop (no exec/edit there). Not an error.
      stopReason = "none";
    }

    return new RebaseStatus({
      inProgress: true,
      stopReason,
      progress,
      detail,
      onto,
      headName,
    });
  });

// ── start (✎ — caller holds the repo lock) ───────────────────────────────────────

export const rebaseStart = (
  cwd: string,
  gitDir: string,
  upstream: string,
  steps: ReadonlyArray<RebaseStep>,
  onto?: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<RebaseStatus, GitError> =>
  Effect.gen(function* () {
    if (detectInProgress(gitDir) !== "none")
      return yield* Effect.fail(
        gitError("repoLocked", "another operation is already in progress"),
      );
    yield* assertNoLeadingDash(upstream, "rebase upstream");
    if (onto !== undefined) yield* assertNoLeadingDash(onto, "rebase onto");
    const invalid = validateRebasePlan(steps);
    if (invalid !== null)
      return yield* Effect.fail(gitError("gitFailed", invalid));
    // Security: each step oid is written verbatim into the git-rebase-todo (`pick <oid>`),
    // and `oid` is a branded primitive with no charset validation. Reject anything that is
    // not a plain hex object id, so a value like "<hex>\nexec <cmd>" cannot inject an extra
    // `exec` line that `git rebase -i` would run on the host (NF-SEC-6).
    const badOid = steps.find((s) => s.action !== "drop" && !isHexOid(s.oid));
    if (badOid !== undefined)
      return yield* Effect.fail(
        gitError(
          "invalidRefName",
          "a rebase step references an invalid commit id",
        ),
      );

    // Refuse a dirty tree rather than auto-stashing (REQ-P5-IR-013 sibling rule).
    const dirty = yield* runGitOk({
      cwd,
      args: ["status", "--porcelain=v2", "-z", "--untracked-files=no"],
      env,
    });
    if (dirty.stdout.length > 0)
      return yield* Effect.fail(
        gitError("dirtyWorkingTree", "commit or stash your changes first"),
      );

    // Author the scripted todo + message sidecars under <gitDir>/cbranch-rebase/.
    const sidecar = join(gitDir, "cbranch-rebase");
    const todoPath = join(sidecar, "todo");
    const build = buildRebaseTodo(steps, (k) => join(sidecar, `msg-${k}`));
    yield* Effect.try({
      try: () => {
        rmSync(sidecar, { recursive: true, force: true });
        mkdirSync(sidecar, { recursive: true });
        for (const f of build.msgFiles) writeFileSync(f.path, f.content);
        writeFileSync(todoPath, build.todo);
      },
      catch: (e) =>
        gitError("fsError", `failed to prepare the rebase todo: ${String(e)}`),
    });

    const seqEditor = `${shellSingleQuote(process.execPath)} ${shellSingleQuote(
      defaultShimPath(),
    )}`;
    const rebaseEnv: NodeJS.ProcessEnv = {
      ...env,
      GIT_SEQUENCE_EDITOR: seqEditor,
      GIT_EDITOR: "true",
      CBRANCH_REBASE_TODO: todoPath,
    };
    const args = ["rebase", "-i"];
    if (onto !== undefined) args.push("--onto", onto);
    args.push(upstream);
    const result = yield* runGit({ cwd, args, read: false, env: rebaseEnv });

    const status = yield* rebaseStatus(cwd, gitDir, env);
    // The shim drops a marker when (and only when) git accepted our sequence editor —
    // i.e. OUR rebase actually started.
    const ourRebaseRan = existsSync(`${todoPath}.applied`);
    if (status.inProgress) {
      if (!ourRebaseRan) {
        // A foreign `git rebase` occupied the repo in the precheck→spawn window: git
        // exited non-zero and never ran our editor. Don't claim that rebase as our stop.
        yield* Effect.sync(() =>
          rmSync(sidecar, { recursive: true, force: true }),
        );
        return yield* Effect.fail(
          gitError("gitFailed", "git rebase failed", decodeUtf8(result.stderr)),
        );
      }
      // Our rebase stopped (conflict / edit / failed exec): keep the sidecar so the todo's
      // exec-amend message files survive the reused Continue.
      return status;
    }
    // Completed (or never started): the sidecar is no longer referenced.
    yield* Effect.sync(() => rmSync(sidecar, { recursive: true, force: true }));
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        gitError("gitFailed", "git rebase failed", decodeUtf8(result.stderr)),
      );
    return status;
  });
