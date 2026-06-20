// Per-repository mutation lock registry (docs/spec/02 REQ-ARCH-030..034; 14 §3.2;
// NF-LOCK-1).
//
// Every MUTATING operation must serialize per `repoId` via an `Effect.Semaphore(1)`
// shared across all callers/tabs on that `repoId`. Phase 1 is entirely READ-ONLY
// (P1-X-1) so nothing acquires the lock yet — this stands up the registry + the
// `withRepoLock` helper so P2 mutations drop in without re-plumbing. Reads NEVER take
// the lock. Acquisition is interruptible and finally-guaranteed by `Semaphore`
// itself (REQ-ARCH-033/034).

import { type RepoId } from "@cbranch/rpc-contract";
import { type Effect, Semaphore } from "effect";

export interface RepoLockRegistry {
  /**
   * Run `effect` while holding the single mutation permit for `repoId` (queue/FIFO
   * by default — NF-LOCK-2). The same permit is shared across all callers for that
   * `repoId`, so concurrent mutations on one repo execute one at a time.
   */
  readonly withRepoLock: (
    repoId: RepoId,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Number of distinct repositories that currently have a lock (introspection/tests). */
  readonly size: () => number;
}

/** Create an in-memory per-`repoId` lock registry (one `Semaphore(1)` per repo). */
export const makeRepoLockRegistry = (): RepoLockRegistry => {
  const locks = new Map<string, Semaphore.Semaphore>();

  const semaphoreFor = (repoId: RepoId): Semaphore.Semaphore => {
    let sem = locks.get(repoId);
    if (sem === undefined) {
      sem = Semaphore.makeUnsafe(1);
      locks.set(repoId, sem);
    }
    return sem;
  };

  return {
    withRepoLock:
      (repoId: RepoId) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        semaphoreFor(repoId).withPermits(1)(effect),
    size: () => locks.size,
  };
};
