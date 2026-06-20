import { type RepoId } from "@cbranch/rpc-contract";
import { RepoId as RepoIdBrand } from "@cbranch/rpc-contract";
import { Duration, Effect } from "effect";
import { describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import { makeRepoLockRegistry } from "./locks";

const id = (s: string): RepoId => RepoIdBrand.make(s.padEnd(64, "0"));

describe("makeRepoLockRegistry (NF-LOCK-1; scaffold for P2 mutations)", () => {
  test("serializes operations sharing one repoId (max concurrency 1)", async () => {
    const registry = makeRepoLockRegistry();
    const state = { active: 0, maxActive: 0 };
    const work = registry.withRepoLock(id("a"))(
      Effect.gen(function* () {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        yield* Effect.sleep(Duration.millis(20));
        state.active -= 1;
      }),
    );
    await run(Effect.all([work, work, work], { concurrency: "unbounded" }));
    expect(state.maxActive).toBe(1);
  });

  test("allows operations on different repoIds to proceed concurrently", async () => {
    const registry = makeRepoLockRegistry();
    const state = { active: 0, maxActive: 0 };
    const work = (repoId: RepoId) =>
      registry.withRepoLock(repoId)(
        Effect.gen(function* () {
          state.active += 1;
          state.maxActive = Math.max(state.maxActive, state.active);
          yield* Effect.sleep(Duration.millis(20));
          state.active -= 1;
        }),
      );
    await run(Effect.all([work(id("a")), work(id("b")), work(id("c"))], { concurrency: "unbounded" }));
    expect(state.maxActive).toBeGreaterThan(1);
    expect(registry.size()).toBe(3);
  });

  test("reuses existing semaphore when same repoId is locked a second time", async () => {
    const registry = makeRepoLockRegistry();
    // Calling withRepoLock twice for the same repoId exercises the semaphore-reuse path.
    const e1 = registry.withRepoLock(id("x"))(Effect.void);
    const e2 = registry.withRepoLock(id("x"))(Effect.void);
    await run(Effect.all([e1, e2], { concurrency: "unbounded" }));
    expect(registry.size()).toBe(1);
  });
});
