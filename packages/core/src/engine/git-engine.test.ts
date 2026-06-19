import { join } from "node:path";

import { type RepoId } from "@cbranch/rpc-contract";
import { Oid as OidBrand, RepoId as RepoIdBrand } from "@cbranch/rpc-contract";
import { Effect, Exit, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type GitEngineApi, makeGitEngine } from "../index";
import { runScoped } from "../testing/effect-run";
import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";

let ws: FixtureWorkspace;
let cfgSeq = 0;
const newCfg = (): string => join(ws.root, `engine-config-${cfgSeq++}.json`);

const withEngine = <A, E>(configPath: string, f: (engine: GitEngineApi) => Effect.Effect<A, E>): Promise<A> =>
  runScoped(Effect.flatMap(makeGitEngine({ configPath }), f));

beforeAll(async () => {
  ws = await createFixtureWorkspace();
});
afterAll(async () => {
  await ws.cleanup();
});

describe("GitEngine repo.* (P1, core-A)", () => {
  test("open returns identity + state and records the repo in the recent list (AC-1)", async () => {
    const repo = await ws.createRepo("openme");
    const oid = await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const cfg = newCfg();

    const { handle, recents } = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        const h = yield* e.open(repo.dir);
        const list = yield* e.recentList();
        return { handle: h, recents: list };
      }),
    );

    expect(handle.repoId).toMatch(/^[0-9a-f]{64}$/);
    expect(handle.state.headOid).toBe(oid);
    expect(handle.state.currentBranch).toBe("main");
    expect(recents).toHaveLength(1);
    expect(recents[0]?.repoId).toBe(handle.repoId);
    expect(recents[0]?.name).toBe("openme");
  });

  test("recent list orders most-recent-first and dedupes; remove drops it (AC-3)", async () => {
    const a = await ws.createRepo("repoA");
    const b = await ws.createRepo("repoB");
    await a.commit({ message: "a" });
    await b.commit({ message: "b" });
    const cfg = newCfg();

    const order = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        yield* e.open(a.dir);
        yield* e.open(b.dir);
        yield* e.open(a.dir); // re-open A → back to the top
        const recents = yield* e.recentList();
        return recents.map((r) => r.name);
      }),
    );
    expect(order).toEqual(["repoA", "repoB"]);

    // Removal persists to the shared config; a fresh engine sees it gone.
    const bId = await withEngine(cfg, (e) =>
      Effect.map(e.recentList(), (r) => r.find((x) => x.name === "repoB")?.repoId),
    );
    const after = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        yield* e.recentRemove(bId as RepoId);
        return yield* e.recentList();
      }),
    );
    expect(after.map((r) => r.name)).toEqual(["repoA"]);
  });

  test("a failed open does not modify the recent list (AC-2)", async () => {
    const good = await ws.createRepo("good");
    await good.commit({ message: "init" });
    const plain = await ws.createPlainDir("notarepo");
    const cfg = newCfg();

    const { failed, recents } = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        yield* e.open(good.dir);
        const exit = yield* Effect.exit(e.open(plain));
        const list = yield* e.recentList();
        return { failed: Exit.isFailure(exit), recents: list };
      }),
    );
    expect(failed).toBe(true);
    expect(recents).toHaveLength(1);
    expect(recents[0]?.name).toBe("good");
  });

  test("state(repoId) resolves an opened repo and rejects an unknown one", async () => {
    const repo = await ws.createRepo("statey");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const cfg = newCfg();

    const { state, unknownErr } = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        const handle = yield* e.open(repo.dir);
        const st = yield* e.state(handle.repoId);
        const errUnknown = yield* Effect.flip(e.state(RepoIdBrand.make("f".repeat(64))));
        return { state: st, unknownErr: errUnknown };
      }),
    );
    expect(state.currentBranch).toBe("main");
    expect(unknownErr.code).toBe("repoUnavailable");
  });

  test("a restarted engine answers state(repoId) via the recent-list fallback", async () => {
    const repo = await ws.createRepo("restart");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const cfg = newCfg();

    const repoId = await withEngine(cfg, (e) => Effect.map(e.open(repo.dir), (h) => h.repoId));
    // Fresh engine, same config — never called open, must resolve via recent list.
    const state = await withEngine(cfg, (e) => e.state(repoId));
    expect(state.currentBranch).toBe("main");
    expect(state.isEmpty).toBe(false);
  });

  test("object-read infra works through the engine (for core-B)", async () => {
    const repo = await ws.createRepo("objread");
    await repo.commit({ message: "init", files: { "a.txt": "hello\n" } });
    const cfg = newCfg();

    const blob = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        const handle = yield* e.open(repo.dir);
        return yield* e.readObject(handle.repoId, "HEAD:a.txt");
      }),
    );
    expect(blob?.data.toString("utf8")).toBe("hello\n");
  });
});

describe("GitEngine core-B stubs are typed and present", () => {
  test("streaming + unary stubs fail with a clear not-implemented error", async () => {
    const repo = await ws.createRepo("stubs");
    await repo.commit({ message: "init" });
    const cfg = newCfg();

    const codes = await withEngine(cfg, (e) =>
      Effect.gen(function* () {
        const handle = yield* e.open(repo.dir);
        const logErr = yield* Effect.flip(Stream.runCollect(e.logStream({ repoId: handle.repoId, limit: 10 })));
        const detailErr = yield* Effect.flip(
          e.commitDetail(handle.repoId, handle.state.headOid ?? OidBrand.make("0".repeat(40))),
        );
        return { logErr: logErr.code, detailErr: detailErr.code };
      }),
    );
    expect(codes.logErr).toBe("gitFailed");
    expect(codes.detailErr).toBe("gitFailed");
  });
});
