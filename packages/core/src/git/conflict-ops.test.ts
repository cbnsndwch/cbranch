import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runScoped } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  DEFAULT_IDENTITY,
  type FixtureRepo,
  type FixtureWorkspace,
  fixtureDate,
  seedConflict,
} from "../testing/fixtures";
import { makeCatFilePool } from "./cat-file-pool";
import {
  conflictMarkResolved,
  conflictMarkUnresolved,
  conflictResolve,
  conflictSaveMerged,
} from "./conflict-ops";

let ws: FixtureWorkspace;
beforeAll(async () => {
  ws = await createFixtureWorkspace();
});
afterAll(async () => {
  await ws.cleanup();
});

const commitEnv = (seq: number): NodeJS.ProcessEnv => ({
  GIT_AUTHOR_NAME: DEFAULT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: DEFAULT_IDENTITY.email,
  GIT_AUTHOR_DATE: fixtureDate(seq),
  GIT_COMMITTER_NAME: DEFAULT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: DEFAULT_IDENTITY.email,
  GIT_COMMITTER_DATE: fixtureDate(seq),
});

const resolve = (
  repo: FixtureRepo,
  paths: ReadonlyArray<string>,
  resolution: Parameters<typeof conflictResolve>[2],
) =>
  runScoped(
    Effect.gen(function* () {
      const pool = yield* makeCatFilePool(repo.dir);
      return yield* conflictResolve(repo.dir, paths, resolution, pool);
    }),
  );

/** Whether `path` still has unmerged index entries. */
const isUnmerged = async (repo: FixtureRepo, path: string): Promise<boolean> =>
  (await repo.git(["ls-files", "-u", "--", path])).stdout.trim() !== "";

/** Staged (stage-0) blob content for `path`. */
const staged = async (repo: FixtureRepo, path: string): Promise<string> =>
  (await repo.git(["show", `:${path}`])).stdout;

const seedDeletedByThem = async (repo: FixtureRepo): Promise<void> => {
  await repo.commit({
    message: "base",
    files: { "d.txt": "base\n" },
    date: fixtureDate(1),
  });
  await repo.branch("other");
  await repo.commit({
    message: "ours modify",
    files: { "d.txt": "ours\n" },
    date: fixtureDate(2),
  });
  await repo.checkout("other");
  await repo.git(["rm", "-q", "d.txt"]);
  await repo.git(["commit", "-q", "-m", "theirs delete"], {
    env: commitEnv(3),
  });
  await repo.checkout("main");
  await repo.merge("other");
};

describe("conflictResolve (REQ-CN-004/005, REQ-WHOLE; AC-7(08)/2(11))", () => {
  test("take ours: working tree + index become the current side", async () => {
    const repo = await ws.createRepo("res-ours");
    await seedConflict(repo);

    await resolve(repo, ["f.txt"], "ours");
    expect(readFileSync(join(repo.dir, "f.txt"), "utf8")).toBe("ours\n");
    expect(await staged(repo, "f.txt")).toBe("ours\n");
    expect(await isUnmerged(repo, "f.txt")).toBe(false);
  });

  test("take theirs: working tree + index become the incoming side", async () => {
    const repo = await ws.createRepo("res-theirs");
    await seedConflict(repo);

    await resolve(repo, ["f.txt"], "theirs");
    expect(readFileSync(join(repo.dir, "f.txt"), "utf8")).toBe("theirs\n");
    expect(await staged(repo, "f.txt")).toBe("theirs\n");
    expect(await isUnmerged(repo, "f.txt")).toBe(false);
  });

  test("take base: working tree + index become the common ancestor", async () => {
    const repo = await ws.createRepo("res-base");
    await seedConflict(repo);

    await resolve(repo, ["f.txt"], "base");
    expect(readFileSync(join(repo.dir, "f.txt"), "utf8")).toBe("base\n");
    expect(await staged(repo, "f.txt")).toBe("base\n");
    expect(await isUnmerged(repo, "f.txt")).toBe(false);
  });

  test("keep file on modify/delete stages the modified content", async () => {
    const repo = await ws.createRepo("res-keep");
    await seedDeletedByThem(repo);

    await resolve(repo, ["d.txt"], "keepFile");
    expect(existsSync(join(repo.dir, "d.txt"))).toBe(true);
    expect(await staged(repo, "d.txt")).toBe("ours\n");
    expect(await isUnmerged(repo, "d.txt")).toBe(false);
  });

  test("delete file on modify/delete stages the removal", async () => {
    const repo = await ws.createRepo("res-delete");
    await seedDeletedByThem(repo);

    await resolve(repo, ["d.txt"], "deleteFile");
    expect(existsSync(join(repo.dir, "d.txt"))).toBe(false);
    expect((await repo.git(["ls-files", "--", "d.txt"])).stdout.trim()).toBe(
      "",
    );
    expect(await isUnmerged(repo, "d.txt")).toBe(false);
  });

  test("refuses a path that is no longer conflicted (REQ-EDGE-008)", async () => {
    const repo = await ws.createRepo("res-clean");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    const err = await runScoped(
      Effect.flip(
        Effect.gen(function* () {
          const pool = yield* makeCatFilePool(repo.dir);
          return yield* conflictResolve(repo.dir, ["a.txt"], "ours", pool);
        }),
      ),
    );
    expect(err.code).toBe("gitFailed");
  });
});

describe("conflictSaveMerged (byte fidelity; REQ-MERGE-016/019)", () => {
  test("writes exact utf-8 bytes (CRLF preserved) and stages the path", async () => {
    const repo = await ws.createRepo("save-utf8");
    await seedConflict(repo);

    const content = "merged line 1\r\nmerged line 2\r\n";
    await runScoped(conflictSaveMerged(repo.dir, "f.txt", content, "utf8"));
    expect(readFileSync(join(repo.dir, "f.txt"), "utf8")).toBe(content);
    expect(await isUnmerged(repo, "f.txt")).toBe(false);
  });

  test("writes exact base64-decoded bytes (NUL preserved)", async () => {
    const repo = await ws.createRepo("save-b64");
    await seedConflict(repo);

    const raw = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await runScoped(
      conflictSaveMerged(repo.dir, "f.txt", raw.toString("base64"), "base64"),
    );
    expect(readFileSync(join(repo.dir, "f.txt")).equals(raw)).toBe(true);
    expect(await isUnmerged(repo, "f.txt")).toBe(false);
  });

  test("refuses a path that is no longer conflicted (REQ-EDGE-008)", async () => {
    const repo = await ws.createRepo("save-clean");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    const err = await runScoped(
      Effect.flip(conflictSaveMerged(repo.dir, "a.txt", "clobber\n", "utf8")),
    );
    expect(err.code).toBe("gitFailed");
    // the byte-clobbering write never happened
    expect(readFileSync(join(repo.dir, "a.txt"), "utf8")).toBe("a\n");
  });
});

describe("mark resolved / unresolved (REQ-CN-005/REQ-MERGE-018)", () => {
  test("markResolved stages a hand-edited working-tree file", async () => {
    const repo = await ws.createRepo("mark-resolved");
    await seedConflict(repo);
    await repo.writeFile("f.txt", "hand merged\n");

    await runScoped(conflictMarkResolved(repo.dir, ["f.txt"]));
    expect(await staged(repo, "f.txt")).toBe("hand merged\n");
    expect(await isUnmerged(repo, "f.txt")).toBe(false);
  });

  test("markResolved refuses a path that is no longer conflicted (REQ-EDGE-008)", async () => {
    const repo = await ws.createRepo("mark-resolved-clean");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await repo.writeFile("a.txt", "edited\n");

    const err = await runScoped(
      Effect.flip(conflictMarkResolved(repo.dir, ["a.txt"])),
    );
    expect(err.code).toBe("gitFailed");
    // nothing staged: the index still matches HEAD
    expect(await staged(repo, "a.txt")).toBe("a\n");
  });

  test("markUnresolved restores the conflict after a resolution", async () => {
    const repo = await ws.createRepo("mark-unresolved");
    await seedConflict(repo);
    await resolve(repo, ["f.txt"], "ours");
    expect(await isUnmerged(repo, "f.txt")).toBe(false);

    await runScoped(conflictMarkUnresolved(repo.dir, ["f.txt"]));
    expect(await isUnmerged(repo, "f.txt")).toBe(true);
  });

  test("empty path list is a no-op", async () => {
    const repo = await ws.createRepo("mark-empty");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await runScoped(conflictMarkResolved(repo.dir, []));
    await runScoped(conflictMarkUnresolved(repo.dir, []));
    expect(await isUnmerged(repo, "a.txt")).toBe(false);
  });
});
