// Complete commit file tree — `commit.tree` (docs/spec/14-rpc-contract.md §7).
//
// This is deliberately separate from `commit.diff`: `git ls-tree` reads the selected
// commit's tree object and returns every tracked leaf, regardless of whether that path
// changed in the commit. Paths are display-only; no path is resolved or opened.

import { CommitTree, type GitError, type Oid } from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { classifyExit, gitError } from './errors';
import { assertNoLeadingDash, decodeUtf8, runGit } from './run-git';

/** The largest complete tree the RPC will return; over the cap fails, never truncates. */
export const COMMIT_TREE_PATH_CAP = 10_000;

/** Bound captured `ls-tree` bytes as well as path count (long paths can be expensive). */
export const COMMIT_TREE_OUTPUT_CAP = 4 * 1024 * 1024;

/** Parse NUL-delimited `git ls-tree -z --name-only` output, rejecting an overlarge tree. */
export const parseCommitTreePaths = (
    stdout: Buffer,
    maxPaths = COMMIT_TREE_PATH_CAP,
): ReadonlyArray<string> | null => {
    const paths: string[] = [];
    for (const path of decodeUtf8(stdout).split('\0')) {
        if (path === '') continue;
        paths.push(path);
        if (paths.length > maxPaths) return null;
    }
    return paths;
};

/** Read all tracked file paths for an immutable commit tree, with defensive output caps. */
export const commitTree = (
    cwd: string,
    oid: Oid,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<CommitTree, GitError> =>
    Effect.gen(function* () {
        const rev = yield* assertNoLeadingDash(oid, 'commit id');
        const result = yield* runGit({
            cwd,
            args: ['ls-tree', '-r', '-z', '--name-only', rev],
            env,
            maxStdoutBytes: COMMIT_TREE_OUTPUT_CAP,
        });
        if (result.stdoutLimitExceeded)
            return yield* Effect.fail(
                gitError(
                    'resultTooLarge',
                    `commit tree exceeds the ${COMMIT_TREE_OUTPUT_CAP / 1024 / 1024} MiB output limit`,
                ),
            );
        if (result.exitCode !== 0)
            return yield* Effect.fail(
                classifyExit(result.exitCode, decodeUtf8(result.stderr)),
            );

        const paths = parseCommitTreePaths(result.stdout);
        if (paths === null)
            return yield* Effect.fail(
                gitError(
                    'resultTooLarge',
                    `commit tree exceeds the ${COMMIT_TREE_PATH_CAP} path limit`,
                ),
            );
        return new CommitTree({ paths });
    });
