// Stash operations (docs/spec/07 REQ-P3-ST-*)

import {
  type DiffFile as DiffFileType,
  type GitError,
  StashEntry,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import {
  buildDiffFiles,
  parseNameStatus,
  parseNumstat,
  parsePatch,
} from "./diff";
import { gitError } from "./errors";
import { decodeUtf8, runGit, runGitOk } from "./run-git";

// ── helpers ────────────────────────────────────────────────────────────────────

/** Extract the `N` from a ref string like `stash@{3}`. Returns -1 on parse failure. */
function parseStashIndex(ref: string): number {
  const m = ref.match(/\{(\d+)\}/);
  return m ? parseInt(m[1] ?? "0", 10) : -1;
}

/** Extract the source branch name from a stash subject line. */
function parseBranchFromSubject(subject: string): string {
  if (subject.startsWith("WIP on ")) {
    const rest = subject.slice(7);
    const colon = rest.indexOf(":");
    return colon >= 0 ? rest.slice(0, colon) : rest;
  }
  if (subject.startsWith("On ")) {
    const rest = subject.slice(3);
    const colon = rest.indexOf(":");
    return colon >= 0 ? rest.slice(0, colon) : rest;
  }
  return "unknown";
}

// ── stashList ─────────────────────────────────────────────────────────────────

// Format: tab-separated fields per line — refname, subject, full commit OID.
// Using tab (%x09) avoids any NUL/escape issues in the file source.
const STASH_FORMAT = "%gd%x09%gs%x09%H";

/** Parse `git stash list --format=<STASH_FORMAT>` output. */
function parseStashList(stdout: string): StashEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const ref = parts[0] ?? "";
      const subject = parts[1] ?? "";
      const headOid = parts[2] ?? "";
      const index = parseStashIndex(ref);
      const branch = parseBranchFromSubject(subject);
      // The message is the meaningful part after "WIP on <branch>: " or "On <branch>: "
      let message = subject;
      const colonSpace = subject.indexOf(": ");
      if (colonSpace >= 0) message = subject.slice(colonSpace + 2);

      return new StashEntry({
        index,
        ref,
        message,
        branch,
        headOid: headOid as StashEntry["headOid"],
        subject,
      });
    });
}

export const stashList = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<readonly StashEntry[], GitError> =>
  Effect.gen(function* () {
    const result = yield* runGitOk({
      cwd,
      args: ["stash", "list", `--format=${STASH_FORMAT}`],
      env,
    });
    return parseStashList(decodeUtf8(result.stdout));
  });

// ── stashPush ─────────────────────────────────────────────────────────────────

export interface StashPushOpts {
  readonly message?: string;
  readonly includeUntracked?: boolean;
  readonly keepIndex?: boolean;
  readonly stagedOnly?: boolean;
}

export const stashPush = (
  cwd: string,
  opts?: StashPushOpts,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<StashEntry, GitError> =>
  Effect.gen(function* () {
    const args = ["stash", "push"];
    if (opts?.message) args.push("-m", opts.message);
    if (opts?.includeUntracked) args.push("-u");
    if (opts?.keepIndex) args.push("-k");
    if (opts?.stagedOnly) args.push("--staged");

    yield* runGitOk({ cwd, args, env, read: false });

    // The new stash is now at stash@{0}
    const list = yield* stashList(cwd, env);
    const top = list[0];
    if (!top) {
      return yield* Effect.fail(
        gitError("gitFailed", "stash push succeeded but stash list is empty"),
      );
    }
    return top;
  });

// ── stashShow ─────────────────────────────────────────────────────────────────

/**
 * Run the three aligned diff outputs (name-status, numstat, patch) over a single
 * rev-pair and assemble them into ordered {@link DiffFileType}s. Mirrors the triple
 * used by every other {@link buildDiffFiles} caller so all three stay
 * one-entry-per-file aligned (DM-060).
 */
const showDiffFiles = (
  cwd: string,
  diffArgs: ReadonlyArray<string>,
  rev: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv | undefined,
): Effect.Effect<readonly DiffFileType[], GitError> =>
  Effect.gen(function* () {
    const [ns, num, patch] = yield* Effect.all([
      runGitOk({
        cwd,
        args: [...diffArgs, "-z", "--name-status", "--no-renames", ...rev],
        env,
      }),
      runGitOk({
        cwd,
        args: [...diffArgs, "-z", "--numstat", "--no-renames", ...rev],
        env,
      }),
      runGitOk({ cwd, args: [...diffArgs, "-p", "--no-renames", ...rev], env }),
    ]);
    return buildDiffFiles(
      parseNameStatus(ns.stdout),
      parseNumstat(num.stdout),
      parsePatch(decodeUtf8(patch.stdout)),
    );
  });

export const stashShow = (
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<readonly DiffFileType[], GitError> =>
  Effect.gen(function* () {
    // Tracked changes: stash@{N}^1 (the commit HEAD was at when stashing) vs
    // stash@{N} (the WIP tree). git keeps untracked files OUT of the WIP tree, so
    // this pair alone omits anything captured with `-u` (REQ-P3-ST-003).
    const tracked = yield* showDiffFiles(cwd, ["diff"], [`${ref}^1`, ref], env);

    // A stash created with `-u` records the captured untracked files as a
    // PARENTLESS third parent commit (stash@{N}^3). An ordinary stash has no such
    // parent, so `rev-parse --verify` exits non-zero — that is DATA ("no untracked
    // content"), not a failure, hence runGit + an exit-code branch rather than
    // runGitOk.
    const untrackedRef = `${ref}^3`;
    const probe = yield* runGit({
      cwd,
      args: ["rev-parse", "--verify", "--quiet", untrackedRef],
      env,
    });
    if (probe.exitCode !== 0) return tracked;

    // Diff the empty tree against the untracked commit (`diff-tree --root` on a
    // parentless commit): every captured untracked file surfaces as Added.
    const untracked = yield* showDiffFiles(
      cwd,
      ["diff-tree", "-r", "--no-commit-id"],
      ["--root", untrackedRef],
      env,
    );

    // Tracked entries first, then untracked; drop any untracked path already
    // present among the tracked entries. git keeps the two sets disjoint, so this
    // dedup is defensive — it only guarantees a sane, stable, one-per-path order.
    const seen = new Set(tracked.map((f) => f.newPath));
    const merged: DiffFileType[] = [...tracked];
    for (const f of untracked) {
      if (!seen.has(f.newPath)) merged.push(f);
    }
    return merged;
  });

// ── stashApply / stashPop ─────────────────────────────────────────────────────

const runStashConflictAware = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv | undefined,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const result = yield* runGit({ cwd, args, env, read: false });
    if (result.exitCode === 0) return;
    const stderr = decodeUtf8(result.stderr);
    const stdout = decodeUtf8(result.stdout);
    if (stderr.includes("CONFLICT") || stdout.includes("CONFLICT")) {
      return yield* Effect.fail(
        gitError("mergeConflict", "stash apply produced conflicts"),
      );
    }
    return yield* Effect.fail(
      gitError("gitFailed", `git ${args[1]} failed`, { stderr }),
    );
  });

export const stashApply = (
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runStashConflictAware(cwd, ["stash", "apply", ref], env);

export const stashPop = (
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runStashConflictAware(cwd, ["stash", "pop", ref], env);

// ── stashDrop / stashClear ────────────────────────────────────────────────────

export const stashDrop = (
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runGitOk({ cwd, args: ["stash", "drop", ref], env, read: false }).pipe(
    Effect.asVoid,
  );

export const stashClear = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runGitOk({ cwd, args: ["stash", "clear"], env, read: false }).pipe(
    Effect.asVoid,
  );
