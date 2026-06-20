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
import { gitError } from "./errors";
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";
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

    // "carry" (default / undefined): try a clean switch; git carries the WD changes if safe.
    yield* runGitOk({ cwd, args: ["switch", safeTarget], env, read: false });
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
