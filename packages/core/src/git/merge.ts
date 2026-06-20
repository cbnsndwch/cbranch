// Merge operations (docs/spec/07 REQ-P3-MG-001..007)

import { type GitError, MergeResult, type MergeMode, Oid } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";

// REQ-P3-MG-001..006
export const mergeCreate = (
  cwd: string,
  ref: string,
  strategy: MergeMode,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<MergeResult, GitError> =>
  Effect.gen(function* () {
    const safeRef = yield* assertNoLeadingDash(ref, "merge ref");

    if (strategy === "squash") {
      // REQ-P3-MG-004: stage only, no commit
      yield* runGitOk({ cwd, args: ["merge", "--squash", safeRef], env, read: false });
      return new MergeResult({ mode: "squash", staged: true });
    }

    if (strategy === "no-ff") {
      // REQ-P3-MG-003: always create a merge commit
      yield* runGitOk({ cwd, args: ["merge", "--no-ff", "--no-edit", safeRef], env, read: false });
      const headRaw = yield* runGitOk({ cwd, args: ["rev-parse", "HEAD"], env });
      const commitOid = decodeUtf8(headRaw.stdout).trim() as Oid;
      return new MergeResult({ mode: "merge", commitOid });
    }

    // "ff" strategy: attempt fast-forward only; detect result from git output
    const raw = yield* runGit({ cwd, args: ["merge", "--ff", safeRef], env, read: false });

    if (raw.exitCode !== 0) {
      // git merge failed — surface the error
      return yield* Effect.fail({
        _tag: "GitError" as const,
        code: "gitFailed",
        message: decodeUtf8(raw.stderr).trim() || "merge failed",
      } as GitError);
    }

    const out = decodeUtf8(raw.stdout).trim();

    if (out.includes("Already up to date") || out.includes("Already up-to-date")) {
      return new MergeResult({ mode: "alreadyUpToDate" });
    }

    // Fast-forward: HEAD moved to the new tip
    const headRaw = yield* runGitOk({ cwd, args: ["rev-parse", "HEAD"], env });
    const newTipOid = decodeUtf8(headRaw.stdout).trim() as Oid;
    return new MergeResult({ mode: "fastForward", newTipOid });
  });

// REQ-P3-MG-007
export const mergeAbort = (cwd: string, env?: NodeJS.ProcessEnv): Effect.Effect<void, GitError> =>
  runGitOk({ cwd, args: ["merge", "--abort"], env, read: false }).pipe(Effect.asVoid);
