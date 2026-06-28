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
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";

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

/** Build the `git log` argv for the rebase range (exported for argv coverage). */
export const buildRebasePlanArgs = (
  upstream: string,
): ReadonlyArray<string> => [
  "log",
  "-z",
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
 * Validate an authored step list (REQ-P5-IR-005); returns an error message, or null
 * when valid. A single `kept[0]` check covers both "first row not squash/fixup" and
 * "every squash/fixup has a preceding non-drop" (anything after kept[0] does). Empty
 * reword/squash messages are rejected here, NOT papered over with `--allow-empty-message`.
 */
export const validateRebasePlan = (
  steps: ReadonlyArray<RebaseStep>,
): string | null => {
  const kept = steps.filter((s) => s.action !== "drop");
  if (kept.length === 0) return "the rebase plan drops every commit";
  if (kept[0].action === "squash" || kept[0].action === "fixup")
    return "the first commit cannot be a squash or fixup";
  for (const step of steps) {
    if (step.action === "reword" && isBlank(step.message))
      return "a reworded commit needs a non-empty message";
    if (step.action === "squash" && isBlank(step.message))
      return "a squashed commit needs a non-empty message";
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
 *   squash group → base + `fixup`(s) + ONE amend-exec with the combined message
 *   edit         → `edit <oid>` (pauses; trailing fixups apply on continue)
 *   drop         → omitted
 * Replay order is the step order, top-to-bottom. Message bytes live in sidecar files
 * (paths from `msgPath`), single-quote-escaped into the `exec` line — no commit
 * message, oid, or author string ever reaches a shell.
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
    const followers: RebaseStep[] = [];
    while (
      j < kept.length &&
      (kept[j].action === "fixup" || kept[j].action === "squash")
    ) {
      followers.push(kept[j]);
      j += 1;
    }
    lines.push(`${base.action === "edit" ? "edit" : "pick"} ${base.oid}`);
    for (const f of followers) lines.push(`fixup ${f.oid}`);
    const squashes = followers.filter((f) => f.action === "squash");
    if (squashes.length > 0) {
      // The combined message is authored on the last squash (its UI seed covers all).
      amendExec(squashes[squashes.length - 1].message ?? "");
    } else if (base.action === "reword") {
      amendExec(base.message ?? "");
    }
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
    } else {
      // In progress, no conflict, not an `edit` pause: a failed exec-amend or an
      // externally-introduced break/failed exec. Steer the UI to Abort, not a plain
      // Continue (which would skip the failed exec and silently drop the amend).
      stopReason = "execFailed";
      detail = inMerge ? lastDoneLine(mergeDir) : undefined;
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
    if (!status.inProgress) {
      // Completed (or never started): the sidecar is no longer referenced.
      yield* Effect.sync(() =>
        rmSync(sidecar, { recursive: true, force: true }),
      );
      if (result.exitCode !== 0)
        return yield* Effect.fail(
          gitError("gitFailed", "git rebase failed", decodeUtf8(result.stderr)),
        );
    }
    return status;
  });
