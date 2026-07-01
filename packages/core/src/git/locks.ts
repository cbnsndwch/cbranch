// Per-repository mutation lock registry (docs/spec/02 REQ-ARCH-030..034; 07 REQ-P3-XC-001;
// 14 §3.2; NF-LOCK-1).
//
// Every MUTATING operation serializes per `repoId`. Per the Phase-3 edge case
// (docs/spec/07 ~line 513 + REQ-P3-XC-001) the lock is FAIL-FAST, not FIFO-queueing:
// a second mutating request for a repo that is already busy reports `repoLocked`
// rather than running in parallel or silently waiting. Streaming mutations
// (pull/push) hold the lock for the WHOLE stream lifetime via `withRepoLockStream`.
// Reads NEVER take the lock.
//
// The lock is a per-repo boolean cell. Try-acquire is a synchronous test-and-set
// inside `Effect.acquireRelease` — JS is single-threaded and Effect fibers do not
// preempt synchronous code, so the check-and-set is atomic and deterministic. The
// release finalizer (registered only on a successful acquire) clears the cell when
// the guarded effect/stream scope closes (REQ-ARCH-033/034).

import { type GitError, type RepoId } from '@cbranch/rpc-contract';
import { Effect, type Scope, Stream } from 'effect';

import { gitError } from './errors';

export interface RepoLockRegistry {
    /**
     * Run `effect` while holding the single mutation permit for `repoId`. FAIL-FAST:
     * if the repo is already locked, fails with `repoLocked` instead of queueing
     * (REQ-P3-XC-001). The permit is released when `effect` completes or is interrupted.
     */
    readonly withRepoLock: (
        repoId: RepoId,
    ) => <A, E, R>(
        effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitError, R>;
    /**
     * Like {@link withRepoLock} but for a streaming mutation: fail-fast acquires the
     * permit and holds it for the stream's ENTIRE lifetime, releasing on completion
     * or interruption (REQ-P3-XC-001 / XC-004). Used by pull/push streams.
     */
    readonly withRepoLockStream: (
        repoId: RepoId,
    ) => <A, E, R>(
        stream: Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E | GitError, R>;
    /** Number of distinct repositories that currently have a lock (introspection/tests). */
    readonly size: () => number;
}

/** Create an in-memory per-`repoId` fail-fast lock registry (one boolean cell per repo). */
export const makeRepoLockRegistry = (): RepoLockRegistry => {
    const cells = new Map<string, { busy: boolean }>();

    const cellFor = (repoId: RepoId): { busy: boolean } => {
        let cell = cells.get(repoId);
        if (cell === undefined) {
            cell = { busy: false };
            cells.set(repoId, cell);
        }
        return cell;
    };

    // A scoped, fail-fast permit: acquire test-and-sets the busy flag (failing with
    // `repoLocked` if already held); the release — registered only when acquire
    // succeeds — clears it when the scope closes.
    const acquire = (
        repoId: RepoId,
    ): Effect.Effect<void, GitError, Scope.Scope> =>
        Effect.acquireRelease(
            Effect.suspend(() => {
                const cell = cellFor(repoId);
                if (cell.busy) {
                    return Effect.fail(
                        gitError(
                            'repoLocked',
                            'another operation is in progress on this repository',
                        ),
                    );
                }
                cell.busy = true;
                return Effect.void;
            }),
            () =>
                Effect.sync(() => {
                    cellFor(repoId).busy = false;
                }),
        );

    return {
        withRepoLock:
            (repoId: RepoId) =>
            <A, E, R>(
                effect: Effect.Effect<A, E, R>,
            ): Effect.Effect<A, E | GitError, R> =>
                Effect.scoped(Effect.flatMap(acquire(repoId), () => effect)),
        withRepoLockStream:
            (repoId: RepoId) =>
            <A, E, R>(
                stream: Stream.Stream<A, E, R>,
            ): Stream.Stream<A, E | GitError, R> =>
                Stream.unwrap(Effect.map(acquire(repoId), () => stream)),
        size: () => cells.size,
    };
};
