// Worktree operations (docs/spec/07 REQ-P3-WT-*)

import { normalize } from "node:path";

import { type GitError, WorktreeInfo } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { gitError } from "./errors";
import { decodeUtf8, runGitOk } from "./run-git";

function parseWorktrees(stdout: string): WorktreeInfo[] {
  const records = stdout.split("\n\n").filter(Boolean);
  return records.map((block, idx) => {
    const lines = block.split("\n").filter(Boolean);
    let path = "";
    let headOid: string | undefined;
    let branch: string | undefined;
    const isMain = idx === 0;
    let isBare = false;
    let isDetached = false;
    let isLocked = false;
    let isPrunable = false;
    let lockReason: string | undefined;
    let prunableReason: string | undefined;

    for (const line of lines) {
      if (line.startsWith("worktree ")) path = normalize(line.slice(9));
      else if (line.startsWith("HEAD ")) {
        const oid = line.slice(5);
        // all-zeros means unborn branch (no commits yet)
        if (oid !== "0000000000000000000000000000000000000000") headOid = oid;
      } else if (line.startsWith("branch ")) branch = line.slice(7);
      else if (line === "bare") isBare = true;
      else if (line === "detached") isDetached = true;
      else if (line.startsWith("locked")) {
        isLocked = true;
        lockReason = line.length > 7 ? line.slice(7).trimStart() : undefined;
      } else if (line.startsWith("prunable")) {
        isPrunable = true;
        prunableReason =
          line.length > 9 ? line.slice(9).trimStart() : undefined;
      }
    }

    return new WorktreeInfo({
      path,
      headOid: headOid as WorktreeInfo["headOid"],
      branch,
      isMain,
      isBare,
      isDetached,
      isLocked,
      isPrunable,
      lockReason,
      prunableReason,
    });
  });
}

export const worktreeList = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<readonly WorktreeInfo[], GitError> =>
  Effect.gen(function* () {
    const result = yield* runGitOk({
      cwd,
      args: ["worktree", "list", "--porcelain"],
      env,
    });
    return parseWorktrees(decodeUtf8(result.stdout));
  });

export const worktreeAdd = (
  cwd: string,
  path: string,
  opts: { branch?: string; newBranch?: string; startPoint?: string },
  env?: NodeJS.ProcessEnv,
): Effect.Effect<WorktreeInfo, GitError> =>
  Effect.gen(function* () {
    const args: string[] = ["worktree", "add", "-q"];
    if (opts.newBranch) {
      args.push("-b", opts.newBranch, path);
      if (opts.startPoint) args.push(opts.startPoint);
    } else {
      args.push(path);
      if (opts.branch) args.push(opts.branch);
    }
    yield* runGitOk({ cwd, args, env, read: false });
    const list = yield* worktreeList(cwd, env);
    const normalPath = normalize(path);
    const entry = list.find((w) => w.path === normalPath);
    if (!entry)
      return yield* Effect.fail(
        gitError("gitFailed", "worktree not found after add"),
      );
    return entry;
  });

export const worktreeRemove = (
  cwd: string,
  path: string,
  force?: boolean,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const args: string[] = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(path);
    yield* runGitOk({ cwd, args, env, read: false });
  });

export const worktreePrune = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runGitOk({ cwd, args: ["worktree", "prune"], env, read: false }).pipe(
    Effect.asVoid,
  );
