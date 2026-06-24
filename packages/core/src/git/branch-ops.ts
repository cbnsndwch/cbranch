// Branch lifecycle operations: create, switch, rename, delete, set-upstream.
// (docs/spec/07 REQ-P3-BR-010..051)

import { realpathSync } from "node:fs";
import { normalize } from "node:path";

import {
  BranchInfo,
  type BranchSwitchStrategy,
  type GitError,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { branchList } from "./branches";
import { classifyExit, gitError } from "./errors";
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";
import { parseStatusOutput } from "./status";
import { worktreeList } from "./worktrees";

// Compare two worktree paths for identity, resolving symlinks and (on win32)
// drive-letter case so the current-vs-another label stays correct cross-platform
// (git reports the resolved real path; `normalize` alone does neither).
function sameWorktreePath(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return normalize(a) === normalize(b);
  }
}

// Return the BranchInfo for the named branch from a fresh listing.
function lookupBranch(
  cwd: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<BranchInfo, GitError> {
  return Effect.flatMap(branchList(cwd, env), (listing) => {
    const found = listing.localBranches.find((b) => b.name === name);
    if (!found)
      return Effect.fail({
        _tag: "GitError" as const,
        code: "gitFailed",
        message: `branch not found: ${name}`,
      } as GitError);
    return Effect.succeed(found);
  });
}

// REQ-P3-BR-010/011/012/013
export const branchCreate = (
  cwd: string,
  name: string,
  startPoint?: string,
  setUpstream?: boolean,
  switchAfter?: boolean,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<BranchInfo, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "branch name");

    // Surface the SPECIFIC reason a create is refused, DETERMINISTICALLY (an exit
    // code + a porcelain listing, never localized stderr prose — NF-GIT-3), and
    // never leave a partial branch behind (REQ-P3-BR-013):
    //   - `check-ref-format` rejects a malformed name -> invalidRefName
    //   - the local-branch listing detects a collision -> refExists
    const fmt = yield* runGit({
      cwd,
      args: ["check-ref-format", `refs/heads/${safeName}`],
      env,
      read: false,
    });
    if (fmt.exitCode !== 0) {
      return yield* Effect.fail(
        gitError("invalidRefName", `'${safeName}' is not a valid branch name`),
      );
    }
    const existing = yield* branchList(cwd, env);
    if (existing.localBranches.some((b) => b.name === safeName)) {
      return yield* Effect.fail(
        gitError("refExists", `a branch named '${safeName}' already exists`),
      );
    }

    const args: string[] = switchAfter
      ? ["switch", "-c", safeName]
      : ["branch", safeName];

    if (startPoint) {
      const safeStart = yield* assertNoLeadingDash(startPoint, "start point");
      args.push(safeStart);
    }

    // --track sets upstream when start point is a remote-tracking ref (REQ-P3-BR-012)
    if (setUpstream) args.push("--track");

    yield* runGitOk({ cwd, args, env, read: false });
    return yield* lookupBranch(cwd, safeName, env);
  });

// The working-tree paths a plain `git switch <target>` would refuse to overwrite,
// derived from machine state instead of git's localized "would be overwritten" stderr
// (NF-GIT-3). Git refuses on two sets, both reproduced here: (1) tracked paths locally
// modified AND differing between HEAD and the target, and (2) untracked worktree files
// that collide with the target tree (an exact blob path, or a file whose name is a
// directory in the target). Empty when nothing collides or the target can't be resolved
// — then the caller surfaces git's own exit verbatim. Note: an unresolvable DWIM
// remote-tracking short name (no local ref yet) yields an empty overlap, so a dirty
// DWIM switch degrades to gitFailed; that path is currently unreachable from the UI
// (remote-branch switch is gated), so resolving the short name is left as a follow-up.
function dirtySwitchOverlap(
  cwd: string,
  target: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string[], GitError> {
  return Effect.gen(function* () {
    // `-uall` enumerates untracked files individually — an entirely-untracked directory
    // otherwise collapses to a single `dir/` entry that can't match a target blob path.
    const status = yield* Effect.map(
      runGitOk({
        cwd,
        args: [
          "status",
          "--porcelain=v2",
          "-z",
          "--branch",
          "--untracked-files=all",
        ],
        env,
      }),
      (r) => parseStatusOutput(r.stdout),
    );

    // An unmerged index makes git refuse a switch on the index-resolution check, BEFORE
    // any would-be-overwritten check — so a conflict is never a genuine dirty-overwrite.
    // Leave such failures to git's verbatim exit (the carry/stash/discard remedies all
    // fail on an unmerged index, so a dirtyWorkingTree dialog would be a dead end).
    if (status.entries.some((e) => e.isConflicted)) return [];

    const dirtyTracked = new Set<string>();
    const untracked: string[] = [];
    for (const e of status.entries) {
      if (e.isIgnored) continue;
      if (e.isUntracked) {
        untracked.push(e.path);
        continue;
      }
      dirtyTracked.add(e.path);
      if (e.origPath !== undefined) dirtyTracked.add(e.origPath);
    }

    const overlap = new Set<string>();

    // (1) tracked changes to paths that differ between HEAD and the target. `--no-renames`
    // matches git's plain switch, which does NO rename detection — it independently deletes
    // the old path and adds the new — so a locally-modified rename SOURCE is still caught.
    if (dirtyTracked.size > 0) {
      const diff = yield* runGit({
        cwd,
        args: [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          "HEAD",
          target,
          "--",
        ],
        env,
      });
      if (diff.exitCode === 0)
        for (const p of decodeUtf8(diff.stdout).split("\0"))
          if (p.length > 0 && dirtyTracked.has(p)) overlap.add(p);
    }

    // (2) untracked files colliding with the target tree. The whole target tree is listed
    // once (no pathspec), so a large untracked set can't overflow the command line; a path
    // collides as an exact blob (`inTarget`) or when its name is a target directory
    // (`targetDirs`, e.g. untracked file `foo` vs target `foo/bar`).
    if (untracked.length > 0) {
      const tree = yield* runGit({
        cwd,
        args: ["ls-tree", "-r", "--name-only", "-z", target],
        env,
      });
      if (tree.exitCode === 0) {
        const inTarget = new Set<string>();
        const targetDirs = new Set<string>();
        for (const e of decodeUtf8(tree.stdout).split("\0")) {
          if (e.length === 0) continue;
          inTarget.add(e);
          for (let i = e.indexOf("/"); i !== -1; i = e.indexOf("/", i + 1))
            targetDirs.add(e.slice(0, i));
        }
        for (const p of untracked)
          if (inTarget.has(p) || targetDirs.has(p)) overlap.add(p);
      }
    }

    return [...overlap];
  });
}

// REQ-P3-BR-020/021/023/024
export const branchSwitch = (
  cwd: string,
  target: string,
  strategy?: BranchSwitchStrategy,
  reapply?: boolean,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeTarget = yield* assertNoLeadingDash(target, "switch target");

    if (strategy === "stash") {
      // (a) stash the WD, switch, and OPTIONALLY re-apply afterward (BR-023). When
      // `reapply` is false the stash is left on the stack for the user to apply later.
      yield* runGitOk({
        cwd,
        args: [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          "cbranch-auto-stash",
        ],
        env,
        read: false,
      });
      yield* runGitOk({ cwd, args: ["switch", safeTarget], env, read: false });
      if (reapply !== false) {
        // A failing `stash pop` after switch is a conflict — classify it so the
        // in-progress state can be routed to the conflict flow (mirrors stash.ts).
        const popped = yield* runGit({
          cwd,
          args: ["stash", "pop"],
          env,
          read: false,
        });
        if (popped.exitCode !== 0) {
          const stderr = decodeUtf8(popped.stderr);
          if (
            stderr.includes("CONFLICT") ||
            decodeUtf8(popped.stdout).includes("CONFLICT")
          ) {
            return yield* Effect.fail(
              gitError(
                "mergeConflict",
                "re-applying the stash produced conflicts",
              ),
            );
          }
          return yield* Effect.fail(
            gitError("gitFailed", "stash pop failed after switch", { stderr }),
          );
        }
      }
      return;
    }

    if (strategy === "discard") {
      yield* runGitOk({
        cwd,
        args: ["switch", "--discard-changes", safeTarget],
        env,
        read: false,
      });
      return;
    }

    // "carry" (default / undefined): try a clean switch; git carries the WD changes if
    // safe. A plain switch is refused exactly when local changes would be overwritten;
    // classify that refusal from machine state (NF-GIT-3) into a typed `dirtyWorkingTree`
    // carrying the offending paths, so the client offers carry/stash/discard by error
    // CODE instead of matching git's localized stderr. Other failures surface verbatim.
    const switched = yield* runGit({
      cwd,
      args: ["switch", safeTarget],
      env,
      read: false,
    });
    if (switched.exitCode === 0) return;
    const overlap = yield* dirtySwitchOverlap(cwd, safeTarget, env);
    if (overlap.length > 0) {
      return yield* Effect.fail(
        gitError(
          "dirtyWorkingTree",
          "local changes to these paths would be overwritten; stash, carry, or discard",
          { paths: overlap },
        ),
      );
    }
    return yield* Effect.fail(
      classifyExit(switched.exitCode, decodeUtf8(switched.stderr)),
    );
  });

// REQ-P3-BR-022: check out an arbitrary commit/tag into a detached HEAD. The
// caller is responsible for warning the user that the resulting state is detached.
export const branchCheckoutDetached = (
  cwd: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeRef = yield* assertNoLeadingDash(ref, "detach target");
    yield* runGitOk({
      cwd,
      args: ["switch", "--detach", safeRef],
      env,
      read: false,
    });
  });

// REQ-P3-BR-030/031
export const branchRename = (
  cwd: string,
  oldName: string,
  newName: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeOld = yield* assertNoLeadingDash(oldName, "branch name");
    const safeNew = yield* assertNoLeadingDash(newName, "new branch name");
    yield* runGitOk({
      cwd,
      args: ["branch", "-m", safeOld, safeNew],
      env,
      read: false,
    });
  });

// REQ-P3-BR-040/041
export const branchDelete = (
  cwd: string,
  name: string,
  force: boolean,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "branch name");

    // Refuse to delete a branch that is checked out in ANY worktree — the active
    // one or a linked one — and report WHICH worktree holds it (REQ-P3-BR-041).
    // git refuses these itself, but parsing `worktree list --porcelain` lets us
    // name the holding path deterministically without matching localized stderr.
    // Every attached worktree (including the main one) emits a `branch` line, so
    // a single lookup covers both the current-branch and other-worktree cases.
    const fullRef = `refs/heads/${safeName}`;
    const worktrees = yield* worktreeList(cwd, env);
    const holder = worktrees.find((w) => w.branch === fullRef);
    if (holder) {
      const here = sameWorktreePath(holder.path, cwd);
      const where = here
        ? `the current worktree (${holder.path})`
        : `another worktree (${holder.path})`;
      return yield* Effect.fail(
        gitError(
          "gitFailed",
          `cannot delete branch '${safeName}': it is checked out in ${where}`,
          {
            reason: "branchCheckedOutElsewhere",
            conflictWorktreePath: holder.path,
          },
        ),
      );
    }

    const flag = force ? "-D" : "-d";
    yield* runGitOk({
      cwd,
      args: ["branch", flag, safeName],
      env,
      read: false,
    });
  });

// REQ-P3-BR-050/051
export const branchSetUpstream = (
  cwd: string,
  name: string,
  upstream: string | undefined,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "branch name");
    if (upstream === undefined || upstream === "") {
      yield* runGitOk({
        cwd,
        args: ["branch", "--unset-upstream", safeName],
        env,
        read: false,
      });
    } else {
      const safeUpstream = yield* assertNoLeadingDash(upstream, "upstream ref");
      yield* runGitOk({
        cwd,
        args: ["branch", "--set-upstream-to", safeUpstream, safeName],
        env,
        read: false,
      });
    }
  });
