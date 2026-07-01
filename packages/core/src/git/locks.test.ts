import { type RepoId } from '@cbranch/rpc-contract';
import { RepoId as RepoIdBrand } from '@cbranch/rpc-contract';
import { Deferred, Effect, Fiber, Stream } from 'effect';
import { describe, expect, test } from 'vitest';

import { run } from '../testing/effect-run';
import { makeRepoLockRegistry } from './locks';

const id = (s: string): RepoId => RepoIdBrand.make(s.padEnd(64, '0'));

describe('makeRepoLockRegistry (NF-LOCK-1; REQ-P3-XC-001 fail-fast)', () => {
    test('fails fast with repoLocked when the same repo is already locked', async () => {
        await run(
            Effect.gen(function* () {
                const registry = makeRepoLockRegistry();
                const held = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                // Hold the lock on repo "a" until we release it.
                const holder = yield* Effect.forkChild(
                    registry.withRepoLock(id('a'))(
                        Effect.gen(function* () {
                            yield* Deferred.succeed(held, undefined);
                            yield* Deferred.await(release);
                        }),
                    ),
                );
                yield* Deferred.await(held);
                // A concurrent mutation on the same repo must NOT queue — it fails fast.
                const err = yield* Effect.flip(
                    registry.withRepoLock(id('a'))(Effect.void),
                );
                expect(err.code).toBe('repoLocked');
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(holder);
            }),
        );
    });

    test('allows operations on different repoIds to proceed concurrently', async () => {
        await run(
            Effect.gen(function* () {
                const registry = makeRepoLockRegistry();
                const heldA = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const holder = yield* Effect.forkChild(
                    registry.withRepoLock(id('a'))(
                        Effect.gen(function* () {
                            yield* Deferred.succeed(heldA, undefined);
                            yield* Deferred.await(release);
                        }),
                    ),
                );
                yield* Deferred.await(heldA);
                // While "a" is held, a DIFFERENT repo still acquires (does not fail).
                yield* registry.withRepoLock(id('b'))(Effect.void);
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(holder);
                expect(registry.size()).toBe(2);
            }),
        );
    });

    test('releasing the lock lets a later operation acquire it', async () => {
        await run(
            Effect.gen(function* () {
                const registry = makeRepoLockRegistry();
                yield* registry.withRepoLock(id('a'))(Effect.void);
                // Lock is free again — a subsequent op succeeds rather than reporting locked.
                yield* registry.withRepoLock(id('a'))(Effect.void);
                expect(registry.size()).toBe(1);
            }),
        );
    });

    test('withRepoLockStream fails fast when the repo is already locked', async () => {
        await run(
            Effect.gen(function* () {
                const registry = makeRepoLockRegistry();
                const held = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                const holder = yield* Effect.forkChild(
                    registry.withRepoLock(id('a'))(
                        Effect.gen(function* () {
                            yield* Deferred.succeed(held, undefined);
                            yield* Deferred.await(release);
                        }),
                    ),
                );
                yield* Deferred.await(held);
                const locked = registry.withRepoLockStream(id('a'))(
                    Stream.fromIterable([1, 2, 3]),
                );
                const err = yield* Effect.flip(Stream.runCollect(locked));
                expect(err.code).toBe('repoLocked');
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(holder);
            }),
        );
    });

    test("withRepoLockStream holds the lock for the stream's whole lifetime", async () => {
        await run(
            Effect.gen(function* () {
                const registry = makeRepoLockRegistry();
                const started = yield* Deferred.make<void>();
                const release = yield* Deferred.make<void>();
                // A gated stream: it signals once the lock is held, then waits to finish.
                const gated = Stream.fromEffect(
                    Effect.gen(function* () {
                        yield* Deferred.succeed(started, undefined);
                        yield* Deferred.await(release);
                        return 1;
                    }),
                );
                const fiber = yield* Effect.forkChild(
                    Stream.runCollect(
                        registry.withRepoLockStream(id('a'))(gated),
                    ),
                );
                yield* Deferred.await(started);
                // The lock is held for the duration of the stream — a concurrent op fails.
                const err = yield* Effect.flip(
                    registry.withRepoLock(id('a'))(Effect.void),
                );
                expect(err.code).toBe('repoLocked');
                yield* Deferred.succeed(release, undefined);
                yield* Fiber.join(fiber);
                // Once the stream completes the lock is released again.
                yield* registry.withRepoLock(id('a'))(Effect.void);
            }),
        );
    });
});
