import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runScoped } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureRepo,
  type FixtureWorkspace,
} from "../testing/fixtures";
import { makeCatFilePool } from "./cat-file-pool";

let ws: FixtureWorkspace;
let repo: FixtureRepo;
let headOid: string;

beforeAll(async () => {
  ws = await createFixtureWorkspace();
  repo = await ws.createRepo("objs");
  headOid = await repo.commit({
    message: "init",
    files: { "a.txt": "hello\n" },
  });
});
afterAll(async () => {
  await ws.cleanup();
});

describe("makeCatFilePool (REQ-ARCH-020; object reads)", () => {
  test("objectInfo + readObject resolve a commit and a blob, and report missing", async () => {
    const out = await runScoped(
      Effect.gen(function* () {
        const pool = yield* makeCatFilePool(repo.dir);
        const commitInfo = yield* pool.objectInfo(headOid);
        const blob = yield* pool.readObject("HEAD:a.txt");
        const missing = yield* pool.objectInfo("0".repeat(40));
        return { commitInfo, blob, missing };
      }),
    );
    expect(out.commitInfo?.type).toBe("commit");
    expect(out.commitInfo?.oid).toBe(headOid);
    expect(out.blob?.type).toBe("blob");
    expect(out.blob?.data.toString("utf8")).toBe("hello\n");
    expect(out.blob?.size).toBe(6);
    expect(out.missing).toBeNull();
  });

  test("several sequential reads stay correctly ordered over one process", async () => {
    const out = await runScoped(
      Effect.gen(function* () {
        const pool = yield* makeCatFilePool(repo.dir);
        const a = yield* pool.readObject("HEAD:a.txt");
        const c = yield* pool.objectInfo("HEAD^{tree}");
        const a2 = yield* pool.readObject("HEAD:a.txt");
        return { a, c, a2 };
      }),
    );
    expect(out.a?.data.toString("utf8")).toBe("hello\n");
    expect(out.c?.type).toBe("tree");
    expect(out.a2?.data.toString("utf8")).toBe("hello\n");
  });

  test("rejects a rev that would inject a git option (NF-SEC-6)", async () => {
    const out = await runScoped(
      Effect.gen(function* () {
        const pool = yield* makeCatFilePool(repo.dir);
        return yield* Effect.flip(pool.readObject("--batch-all-objects"));
      }),
    );
    expect(out.code).toBe("invalidRefName");
  });
});
