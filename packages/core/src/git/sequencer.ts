// Cherry-pick / revert + operation continuation (docs/spec/08; DECISIONS D17). All
// mutate and run under the per-repo lock (held by the engine). Conflict-stop and empty
// are non-error OUTCOMES (SequencerResult), classified purely from machine state
// (`ls-files -u`, `diff --cached --quiet`, marker refs) — never localized stderr
// (NF-GIT-3). `GIT_EDITOR=true` so no step blocks on an editor. Commit ranges are an
// explicit oldest→newest OID list (root-commit safe), never `<oldest>^..<newest>`.

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  type GitError,
  Oid as OidBrand,
  type OperationKind,
  SequencerResult,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { gitError } from "./errors";
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";
import { parseStatusOutput } from "./status";

export interface PickOptions {
  readonly recordOrigin?: boolean;
  readonly mainline?: number;
  readonly noCommit?: boolean;
}
export interface RevertOptions {
  readonly mainline?: number;
  readonly noCommit?: boolean;
  readonly message?: string;
}
export interface ContinueOptions {
  readonly message?: string;
  readonly allowEmpty?: boolean;
}

/** Map an operation kind to the git subcommand whose --continue/--abort/--skip we run. */
const opVerb = (op: OperationKind): string =>
  op === "cherryPick" ? "cherry-pick" : op;

// The kinds whose continue/abort this engine drives (D17): merge, rebase, cherry-pick,
// revert. am/bisect are a Phase-5 surface — guard them out so `opContinue`/`opAbort`
// never silently run `git am`/`git bisect --continue`/`--abort` for a state the UI
// doesn't support (the UI gates continue/skip via canContinue/canSkip, so this is the
// matching engine-side floor).
const isContinuable = (op: OperationKind): boolean =>
  op === "merge" || op === "rebase" || op === "cherryPick" || op === "revert";

/** The marker ref naming the commit an operation stopped on. */
const opHeadRef = (op: OperationKind): string =>
  op === "cherryPick"
    ? "CHERRY_PICK_HEAD"
    : op === "revert"
      ? "REVERT_HEAD"
      : op === "merge"
        ? "MERGE_HEAD"
        : "REBASE_HEAD";

/** Whether the given operation still has on-disk state (git-dir markers). */
const opInProgress = (gitDir: string, op: OperationKind): boolean => {
  const has = (...s: string[]) => existsSync(join(gitDir, ...s));
  if (op === "cherryPick") return has("CHERRY_PICK_HEAD");
  if (op === "revert") return has("REVERT_HEAD");
  if (op === "merge") return has("MERGE_HEAD");
  if (op === "rebase") return has("rebase-merge") || has("rebase-apply");
  return false;
};

/** Non-interactive env so cherry-pick/revert/continue never open an editor. */
const seqEnv = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
});

const revParseQuiet = (
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string | undefined, GitError> =>
  Effect.map(
    runGit({ cwd, args: ["rev-parse", "--verify", "--quiet", ref], env }),
    (r) =>
      r.exitCode === 0 ? decodeUtf8(r.stdout).trim() || undefined : undefined,
  );

const subjectOf = (
  cwd: string,
  oid: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string | undefined, GitError> =>
  Effect.map(
    runGit({ cwd, args: ["log", "-1", "--format=%s", oid], env }),
    (r) =>
      r.exitCode === 0 ? decodeUtf8(r.stdout).trim() || undefined : undefined,
  );

const hasUnmerged = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<boolean, GitError> =>
  Effect.map(
    runGitOk({ cwd, args: ["ls-files", "-u", "-z"], env }),
    (r) => r.stdout.length > 0,
  );

const hasStaged = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<boolean, GitError> =>
  Effect.map(
    runGit({ cwd, args: ["diff", "--cached", "--quiet"], env }),
    (r) => r.exitCode !== 0,
  );

/** The commit an operation stopped on (marker ref → oid + subject). */
const stopCommit = (
  cwd: string,
  op: OperationKind,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<
  { oid?: ReturnType<typeof OidBrand.make>; subject?: string },
  GitError
> =>
  Effect.gen(function* () {
    const oid = yield* revParseQuiet(cwd, opHeadRef(op), env);
    if (oid === undefined) return {};
    const subject = yield* subjectOf(cwd, oid, env);
    return { oid: OidBrand.make(oid), subject };
  });

/**
 * Classify the result of a sequencer command from machine state alone: unmerged index
 * → conflicts; still-in-progress with nothing staged → empty; clean exit → completed
 * (or staged for --no-commit); a non-zero exit that is neither → a real failure.
 */
const classifyAfterRun = (
  cwd: string,
  gitDir: string,
  op: OperationKind,
  exitCode: number | null,
  stderr: string,
  noCommit: boolean,
  committedCount: number,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<SequencerResult, GitError> =>
  Effect.gen(function* () {
    if (exitCode === 0) {
      // --no-commit succeeds with the change staged; the op may still hold a marker
      // (revert -n keeps REVERT_HEAD), so report "staged" without the in-progress check.
      if (noCommit)
        return new SequencerResult({
          outcome: "staged",
          operation: op,
          committed: 0,
        });
      if (!opInProgress(gitDir, op)) {
        const head = yield* revParseQuiet(cwd, "HEAD", env);
        return new SequencerResult({
          outcome: "completed",
          operation: op,
          committed: committedCount,
          newCommitOid: head === undefined ? undefined : OidBrand.make(head),
        });
      }
    }
    if (yield* hasUnmerged(cwd, env)) {
      const cur = yield* stopCommit(cwd, op, env);
      return new SequencerResult({
        outcome: "conflicts",
        operation: op,
        committed: 0,
        currentOid: cur.oid,
        currentSubject: cur.subject,
      });
    }
    if (opInProgress(gitDir, op) && !(yield* hasStaged(cwd, env))) {
      const cur = yield* stopCommit(cwd, op, env);
      return new SequencerResult({
        outcome: "empty",
        operation: op,
        committed: 0,
        currentOid: cur.oid,
        currentSubject: cur.subject,
      });
    }
    return yield* Effect.fail(
      gitError("gitFailed", stderr.trim() || "the operation failed"),
    );
  });

const assertIdle = (op: OperationKind): Effect.Effect<void, GitError> =>
  op === "none"
    ? Effect.void
    : Effect.fail(
        gitError(
          "repoLocked",
          "another operation is already in progress; continue or abort it first",
        ),
      );

/** A single-commit merge selection requires an explicit mainline parent (REQ-CP-004). */
const assertMainline = (
  cwd: string,
  commits: ReadonlyArray<string>,
  mainline: number | undefined,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  commits.length === 1 && mainline === undefined
    ? Effect.flatMap(
        runGit({
          cwd,
          args: ["rev-parse", "--verify", "--quiet", `${commits[0]}^2`],
          env,
        }),
        (r) =>
          r.exitCode === 0
            ? Effect.fail(
                gitError(
                  "gitFailed",
                  "this is a merge commit; choose a mainline parent before proceeding",
                ),
              )
            : Effect.void,
      )
    : Effect.void;

/** Refuse only when picked-commit paths overlap dirty tracked paths (REQ-CP-007). */
const assertNoDirtyOverlap = (
  cwd: string,
  commits: ReadonlyArray<string>,
  mainline: number | undefined,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const status = yield* Effect.map(
      runGitOk({
        cwd,
        args: [
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=no",
        ],
        env,
      }),
      (r) => parseStatusOutput(r.stdout),
    );
    const dirty = new Set<string>();
    for (const e of status.entries) {
      if (e.isUntracked || e.isIgnored) continue;
      dirty.add(e.path);
      if (e.origPath !== undefined) dirty.add(e.origPath);
    }
    if (dirty.size === 0) return;

    const overlap = new Set<string>();
    for (const oid of commits) {
      const args =
        mainline !== undefined
          ? ["diff-tree", "-r", "--name-only", "-z", `${oid}^${mainline}`, oid]
          : ["diff-tree", "-r", "--name-only", "-z", "--no-commit-id", oid];
      const touched = yield* Effect.map(runGitOk({ cwd, args, env }), (r) =>
        decodeUtf8(r.stdout)
          .split("\0")
          .filter((p) => p.length > 0),
      );
      for (const p of touched) if (dirty.has(p)) overlap.add(p);
    }
    if (overlap.size > 0)
      return yield* Effect.fail(
        gitError(
          "dirtyWorkingTree",
          "local changes to these paths would be overwritten; stash or commit first",
          { paths: [...overlap] },
        ),
      );
  });

const validateCommits = (
  commits: ReadonlyArray<string>,
): Effect.Effect<void, GitError> =>
  commits.length === 0
    ? Effect.fail(gitError("gitFailed", "no commits given"))
    : Effect.asVoid(
        Effect.all(commits.map((c) => assertNoLeadingDash(c, "commit"))),
      );

/** cherry-pick a single commit or an oldest→newest list (REQ-CP-001..008). */
export const cherryPick = (
  cwd: string,
  gitDir: string,
  currentOp: OperationKind,
  commits: ReadonlyArray<string>,
  opts: PickOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<SequencerResult, GitError> =>
  Effect.gen(function* () {
    yield* assertIdle(currentOp);
    yield* validateCommits(commits);
    yield* assertMainline(cwd, commits, opts.mainline, env);
    yield* assertNoDirtyOverlap(cwd, commits, opts.mainline, env);

    const args = ["cherry-pick"];
    if (opts.recordOrigin === true) args.push("-x");
    if (opts.mainline !== undefined) args.push("-m", String(opts.mainline));
    if (opts.noCommit === true) args.push("--no-commit");
    args.push(...commits);

    const res = yield* runGit({ cwd, args, env: seqEnv(env), read: false });
    return yield* classifyAfterRun(
      cwd,
      gitDir,
      "cherryPick",
      res.exitCode,
      decodeUtf8(res.stderr),
      opts.noCommit === true,
      commits.length,
      env,
    );
  });

/** revert a single commit or a list (REQ-RV-001..005). */
export const revert = (
  cwd: string,
  gitDir: string,
  currentOp: OperationKind,
  commits: ReadonlyArray<string>,
  opts: RevertOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<SequencerResult, GitError> =>
  Effect.gen(function* () {
    yield* assertIdle(currentOp);
    yield* validateCommits(commits);
    yield* assertMainline(cwd, commits, opts.mainline, env);
    yield* assertNoDirtyOverlap(cwd, commits, opts.mainline, env);

    // git revert has no message flag (-m is mainline), so a custom message is a
    // --no-commit revert followed by `git commit -F -`.
    const customMessage =
      opts.message !== undefined &&
      commits.length === 1 &&
      opts.noCommit !== true;
    const args = ["revert"];
    if (customMessage || opts.noCommit === true) args.push("--no-commit");
    else args.push("--no-edit");
    if (opts.mainline !== undefined) args.push("-m", String(opts.mainline));
    args.push(...commits);

    const res = yield* runGit({ cwd, args, env: seqEnv(env), read: false });
    if (customMessage && res.exitCode === 0) {
      const commitRes = yield* runGit({
        cwd,
        args: ["commit", "-F", "-"],
        env: seqEnv(env),
        read: false,
        stdin: Buffer.from(opts.message ?? "", "utf8"),
      });
      return yield* classifyAfterRun(
        cwd,
        gitDir,
        "revert",
        commitRes.exitCode,
        decodeUtf8(commitRes.stderr),
        false,
        1,
        env,
      );
    }
    return yield* classifyAfterRun(
      cwd,
      gitDir,
      "revert",
      res.exitCode,
      decodeUtf8(res.stderr),
      opts.noCommit === true,
      commits.length,
      env,
    );
  });

/** Continue the in-progress operation (verb from its kind); re-classify the result. */
export const opContinue = (
  cwd: string,
  gitDir: string,
  operation: OperationKind,
  opts: ContinueOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<SequencerResult, GitError> =>
  Effect.gen(function* () {
    if (operation === "none")
      return yield* Effect.fail(
        gitError("gitFailed", "no operation in progress to continue"),
      );
    if (!isContinuable(operation))
      return yield* Effect.fail(
        gitError(
          "gitFailed",
          `continue is not available for the ${operation} operation`,
        ),
      );
    const e = seqEnv(env);
    const message = opts.message;
    const allowEmpty = opts.allowEmpty === true;

    const commitArgs = (): string[] => {
      const a = ["commit"];
      if (allowEmpty) a.push("--allow-empty");
      if (message !== undefined) a.push("-F", "-");
      else a.push("--no-edit");
      return a;
    };
    const commitStdin =
      message !== undefined ? Buffer.from(message, "utf8") : undefined;

    if (operation === "merge") {
      const res = yield* runGit({
        cwd,
        args: commitArgs(),
        env: e,
        read: false,
        stdin: commitStdin,
      });
      return yield* classifyAfterRun(
        cwd,
        gitDir,
        "merge",
        res.exitCode,
        decodeUtf8(res.stderr),
        false,
        1,
        env,
      );
    }

    // cherry-pick / revert / rebase: record the resolution commit if the user asked
    // for a custom message or an empty commit, then resume the sequence. Committing
    // can itself finish a single-commit sequence (clearing the marker), in which case
    // a following `--continue` would error "no … in progress" — so only continue while
    // the operation is still in progress.
    if (allowEmpty || message !== undefined) {
      const pc = yield* runGit({
        cwd,
        args: commitArgs(),
        env: e,
        read: false,
        stdin: commitStdin,
      });
      if (pc.exitCode !== 0 || !opInProgress(gitDir, operation))
        return yield* classifyAfterRun(
          cwd,
          gitDir,
          operation,
          pc.exitCode,
          decodeUtf8(pc.stderr),
          false,
          0,
          env,
        );
    }
    const res = yield* runGit({
      cwd,
      args: [opVerb(operation), "--continue"],
      env: e,
      read: false,
    });
    return yield* classifyAfterRun(
      cwd,
      gitDir,
      operation,
      res.exitCode,
      decodeUtf8(res.stderr),
      false,
      0,
      env,
    );
  });

/** Abort the in-progress operation, restoring the pre-operation state. */
export const opAbort = (
  cwd: string,
  operation: OperationKind,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> => {
  if (operation === "none")
    return Effect.fail(
      gitError("gitFailed", "no operation in progress to abort"),
    );
  if (!isContinuable(operation))
    return Effect.fail(
      gitError(
        "gitFailed",
        `abort is not available for the ${operation} operation`,
      ),
    );
  return Effect.asVoid(
    runGitOk({
      cwd,
      args: [opVerb(operation), "--abort"],
      env: seqEnv(env),
      read: false,
    }),
  );
};

/** Skip the current commit (rebase / cherry-pick / revert only). */
export const opSkip = (
  cwd: string,
  gitDir: string,
  operation: OperationKind,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<SequencerResult, GitError> => {
  if (
    operation !== "rebase" &&
    operation !== "cherryPick" &&
    operation !== "revert"
  )
    return Effect.fail(
      gitError("gitFailed", "skip is not available for this operation"),
    );
  return Effect.flatMap(
    runGit({
      cwd,
      args: [opVerb(operation), "--skip"],
      env: seqEnv(env),
      read: false,
    }),
    (res) =>
      classifyAfterRun(
        cwd,
        gitDir,
        operation,
        res.exitCode,
        decodeUtf8(res.stderr),
        false,
        0,
        env,
      ),
  );
};
