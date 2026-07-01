// Merge operations (docs/spec/07 REQ-P3-MG-001..007)

import {
    type GitError,
    MergeResult,
    type MergeMode,
    Oid,
} from '@cbranch/rpc-contract';
import { Effect } from 'effect';

import { gitError } from './errors';
import {
    assertNoLeadingDash,
    decodeUtf8,
    type GitResult,
    runGit,
    runGitOk,
} from './run-git';

const isAlreadyUpToDate = (out: string): boolean =>
    out.includes('Already up to date') || out.includes('Already up-to-date');

/** HEAD as a full Oid. */
const headOid = (
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
): Effect.Effect<Oid, GitError> =>
    runGitOk({ cwd, args: ['rev-parse', 'HEAD'], env }).pipe(
        Effect.map(r => decodeUtf8(r.stdout).trim() as Oid),
    );

/** True when HEAD is a merge commit (i.e. it has a second parent). */
const headHasSecondParent = (
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
): Effect.Effect<boolean, GitError> =>
    runGit({
        cwd,
        args: ['rev-parse', '--verify', '--quiet', 'HEAD^2'],
        env,
    }).pipe(Effect.map(r => r.exitCode === 0));

/**
 * Route a failed `git merge` to the right error code. Conflicts (REQ-P3-MG-005)
 * become `mergeConflict` so the caller can hand the in-progress state to the
 * Phase-4 conflict flow; mirrors the stash conflict-aware path. Anything else is
 * a generic `gitFailed` carrying the scrubbed stderr excerpt.
 */
const failMerge = (
    res: GitResult,
    fallback: string,
): Effect.Effect<never, GitError> => {
    const combined = decodeUtf8(res.stdout) + decodeUtf8(res.stderr);
    if (combined.includes('CONFLICT')) {
        return Effect.fail(
            gitError('mergeConflict', 'merge produced conflicts'),
        );
    }
    return Effect.fail(
        gitError('gitFailed', decodeUtf8(res.stderr).trim() || fallback),
    );
};

// REQ-P3-MG-001..006
export const mergeCreate = (
    cwd: string,
    ref: string,
    strategy: MergeMode,
    message?: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<MergeResult, GitError> =>
    Effect.gen(function* () {
        const safeRef = yield* assertNoLeadingDash(ref, 'merge ref');

        if (strategy === 'squash') {
            // REQ-P3-MG-004: stage the combined result, create no commit.
            const res = yield* runGit({
                cwd,
                args: ['merge', '--squash', safeRef],
                env,
                read: false,
            });
            if (res.exitCode !== 0)
                return yield* failMerge(res, 'squash failed');
            return new MergeResult({ mode: 'squash', staged: true });
        }

        if (strategy === 'no-ff') {
            // REQ-P3-MG-003: always create a merge commit. An explicit message lets the
            // user edit it; otherwise fall back to git's default merge message.
            const args = ['merge', '--no-ff'];
            const trimmed = message?.trim();
            if (trimmed) args.push('-m', trimmed);
            else args.push('--no-edit');
            args.push(safeRef);

            const res = yield* runGit({ cwd, args, env, read: false });
            if (res.exitCode !== 0)
                return yield* failMerge(res, 'merge failed');
            const commitOid = yield* headOid(cwd, env);
            return new MergeResult({ mode: 'merge', commitOid });
        }

        if (strategy === 'ff-only') {
            // REQ-P3-MG-006: strict fast-forward. When it is not a fast-forward, report
            // `nonFastForward` so the caller can offer to re-run as --no-ff.
            const res = yield* runGit({
                cwd,
                args: ['merge', '--ff-only', safeRef],
                env,
                read: false,
            });
            if (res.exitCode !== 0) {
                const combined =
                    decodeUtf8(res.stdout) + decodeUtf8(res.stderr);
                if (combined.includes('CONFLICT')) {
                    return yield* Effect.fail(
                        gitError('mergeConflict', 'merge produced conflicts'),
                    );
                }
                return yield* Effect.fail(
                    gitError(
                        'nonFastForward',
                        'cannot fast-forward; a merge commit would be required',
                    ),
                );
            }
            const out = decodeUtf8(res.stdout);
            if (isAlreadyUpToDate(out)) {
                return new MergeResult({ mode: 'alreadyUpToDate' });
            }
            const newTipOid = yield* headOid(cwd, env);
            return new MergeResult({ mode: 'fastForward', newTipOid });
        }

        // strategy === "ff": fast-forward when possible, otherwise a merge commit
        // (git's default). REQ-P3-MG-002: only report `fastForward` when HEAD truly
        // moved without a merge commit — otherwise a created merge commit would be
        // mislabeled as a fast-forward.
        const res = yield* runGit({
            cwd,
            args: ['merge', '--ff', safeRef],
            env,
            read: false,
        });
        if (res.exitCode !== 0) return yield* failMerge(res, 'merge failed');

        const out = decodeUtf8(res.stdout);
        if (isAlreadyUpToDate(out)) {
            return new MergeResult({ mode: 'alreadyUpToDate' });
        }

        const tip = yield* headOid(cwd, env);
        const isMergeCommit = yield* headHasSecondParent(cwd, env);
        return isMergeCommit
            ? new MergeResult({ mode: 'merge', commitOid: tip })
            : new MergeResult({ mode: 'fastForward', newTipOid: tip });
    });

// REQ-P3-MG-007
export const mergeAbort = (
    cwd: string,
    env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
    runGitOk({ cwd, args: ['merge', '--abort'], env, read: false }).pipe(
        Effect.asVoid,
    );
