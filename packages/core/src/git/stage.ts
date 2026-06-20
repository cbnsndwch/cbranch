import { type GitError } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { gitError } from "./errors";
import { runGit, runGitOk } from "./run-git";

const asVoid = <E>(eff: Effect.Effect<unknown, E>): Effect.Effect<void, E> =>
  Effect.map(eff, () => undefined as void);

const checkIsEmptyRepo = (cwd: string): Effect.Effect<boolean, GitError> =>
  Effect.map(
    runGit({ cwd, args: ["rev-parse", "--verify", "HEAD"] }),
    (r) => r.exitCode !== 0,
  );

export const stageFiles = (
  cwd: string,
  paths: ReadonlyArray<string>,
  all: boolean,
): Effect.Effect<void, GitError> => {
  const args = all ? ["add", "-A"] : ["add", "--", ...paths];
  return asVoid(runGitOk({ cwd, args, read: false }));
};

export const unstageFiles = (
  cwd: string,
  paths: ReadonlyArray<string>,
  all: boolean,
): Effect.Effect<void, GitError> =>
  Effect.flatMap(checkIsEmptyRepo(cwd), (empty) => {
    if (all) {
      // Empty repo has no HEAD; nothing can be staged so treat as no-op.
      if (empty) return Effect.succeed(undefined as void);
      return asVoid(runGitOk({ cwd, args: ["reset", "-q"], read: false }));
    }
    if (empty) {
      return asVoid(
        runGitOk({
          cwd,
          args: ["rm", "--cached", "--", ...paths],
          read: false,
        }),
      );
    }
    return asVoid(
      runGitOk({
        cwd,
        args: ["restore", "--staged", "--", ...paths],
        read: false,
      }),
    );
  });

export const discardFiles = (
  cwd: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<void, GitError> =>
  asVoid(
    runGitOk({
      cwd,
      args: ["restore", "--worktree", "--", ...paths],
      read: false,
    }),
  );

export const deleteUntracked = (
  cwd: string,
  paths: ReadonlyArray<string>,
): Effect.Effect<void, GitError> =>
  asVoid(runGitOk({ cwd, args: ["clean", "-f", "--", ...paths], read: false }));

export const resetTo = (
  cwd: string,
  mode: "soft" | "mixed" | "hard",
  target: string,
): Effect.Effect<void, GitError> => {
  if (target.startsWith("-")) {
    return Effect.fail(
      gitError(
        "gitFailed",
        "invalid target: refusing argument beginning with '-'",
      ),
    );
  }
  return asVoid(
    runGitOk({ cwd, args: ["reset", `--${mode}`, target], read: false }),
  );
};
