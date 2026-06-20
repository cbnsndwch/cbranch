// Branch lifecycle operations: create, switch, rename, delete, set-upstream.
// (docs/spec/07 REQ-P3-BR-010..051)

import {
  BranchInfo,
  type BranchSwitchStrategy,
  type GitError,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { branchList } from "./branches";
import { assertNoLeadingDash, runGitOk } from "./run-git";

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

// REQ-P3-BR-020/021/022/023/024
export const branchSwitch = (
  cwd: string,
  target: string,
  strategy?: BranchSwitchStrategy,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeTarget = yield* assertNoLeadingDash(target, "switch target");

    if (strategy === "stash") {
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
      yield* runGitOk({ cwd, args: ["stash", "pop"], env, read: false });
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
