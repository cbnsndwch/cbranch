import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runScoped } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureRepo,
  type FixtureWorkspace,
  fixtureDate,
} from "../testing/fixtures";
import { blame, type BlameOptions, parseBlamePorcelain } from "./blame";
import { makeCatFilePool } from "./cat-file-pool";

let ws: FixtureWorkspace;
beforeAll(async () => {
  ws = await createFixtureWorkspace();
});
afterAll(async () => {
  await ws.cleanup();
});

const doBlame = (repo: FixtureRepo, path: string, opts: BlameOptions = {}) =>
  runScoped(
    Effect.gen(function* () {
      const pool = yield* makeCatFilePool(repo.dir);
      return yield* blame(repo.dir, pool, path, opts);
    }),
  );

describe("parseBlamePorcelain", () => {
  test("groups commits, parses author/tz/previous, keeps per-line content", () => {
    const oidA = "a".repeat(40);
    const oidB = "b".repeat(40);
    const oidC = "c".repeat(40);
    const sample = [
      `${oidA} 1 1 2`,
      "author Ada",
      "author-mail <ada@example.io>",
      "author-time 1700000000",
      "author-tz +0530",
      "summary first",
      "filename f.txt",
      "\toriginal one",
      `${oidA} 2 2`,
      "\toriginal two",
      `${oidB} 3 3 1`,
      "author Bob",
      "author-mail <bob@example.io>",
      "author-time 1700000100",
      "author-tz -0500",
      "summary second",
      `previous ${oidC} f.txt`,
      "filename f.txt",
      "\tthird",
    ].join("\n");

    const data = parseBlamePorcelain(sample, "f.txt", "HEAD");
    expect(data.lines).toHaveLength(3);
    expect(data.lines[0]?.ownerOid).toBe(oidA);
    expect(data.lines[2]?.content).toBe("third");
    expect(data.commits).toHaveLength(2);
    const ca = data.commits.find((c) => c.oid === oidA);
    expect(ca?.authorName).toBe("Ada");
    expect(ca?.authorEmail).toBe("ada@example.io");
    expect(ca?.authorTzMinutes).toBe(330);
    const cb = data.commits.find((c) => c.oid === oidB);
    expect(cb?.authorTzMinutes).toBe(-300);
    expect(cb?.previousOid).toBe(oidC);
    expect(cb?.previousPath).toBe("f.txt");
  });
});

describe("blame (REQ-BL-001..006; AC-11/12(08))", () => {
  test("attributes each line to its commit with author + summary", async () => {
    const repo = await ws.createRepo("blame-basic");
    const oid = await repo.commit({
      message: "init",
      files: { "f.txt": "line1\nline2\nline3\n" },
      date: fixtureDate(1),
    });

    const r = await doBlame(repo, "f.txt");
    expect("lines" in r).toBe(true);
    if (!("lines" in r)) return;
    expect(r.lines).toHaveLength(3);
    expect(r.lines.every((l) => l.ownerOid === oid)).toBe(true);
    expect(r.lines[0]?.content).toBe("line1");
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0]?.summary).toBe("init");
    expect(r.commits[0]?.authorName).toBe("Cb Tester");
  });

  test("follows a rename: lines keep the introducing commit + old name (AC-11)", async () => {
    const repo = await ws.createRepo("blame-rename");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    const intro = await repo.commit({
      message: "add old",
      files: { "old.txt": "keep me\n" },
      date: fixtureDate(2),
    });
    await repo.git(["mv", "old.txt", "new.txt"]);
    await repo.git(["commit", "-q", "-m", "rename"], {
      env: {
        GIT_AUTHOR_NAME: "Cb Tester",
        GIT_AUTHOR_EMAIL: "tester@cbranch.test",
        GIT_AUTHOR_DATE: fixtureDate(3),
        GIT_COMMITTER_NAME: "Cb Tester",
        GIT_COMMITTER_EMAIL: "tester@cbranch.test",
        GIT_COMMITTER_DATE: fixtureDate(3),
      },
    });

    const r = await doBlame(repo, "new.txt");
    if (!("lines" in r)) throw new Error("expected blame data");
    expect(r.lines[0]?.ownerOid).toBe(intro);
    const owner = r.commits.find((c) => c.oid === intro);
    expect(owner?.filename).toBe("old.txt");
  });

  test("a modified line records its previous revision (AC-12)", async () => {
    const repo = await ws.createRepo("blame-previous");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    const first = await repo.commit({
      message: "original",
      files: { "f.txt": "original\n" },
      date: fixtureDate(2),
    });
    const second = await repo.commit({
      message: "modified",
      files: { "f.txt": "modified\n" },
      date: fixtureDate(3),
    });

    const r = await doBlame(repo, "f.txt");
    if (!("lines" in r)) throw new Error("expected blame data");
    expect(r.lines[0]?.ownerOid).toBe(second);
    const owner = r.commits.find((c) => c.oid === second);
    expect(owner?.previousOid).toBe(first);
    expect(owner?.previousPath).toBe("f.txt");
  });

  test("-L restricts blame to a line range", async () => {
    const repo = await ws.createRepo("blame-range");
    await repo.commit({
      message: "init",
      files: { "f.txt": "one\ntwo\nthree\nfour\nfive\n" },
      date: fixtureDate(1),
    });

    const r = await doBlame(repo, "f.txt", { startLine: 2, endLine: 3 });
    if (!("lines" in r)) throw new Error("expected blame data");
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]?.finalLineNo).toBe(2);
    expect(r.lines[0]?.content).toBe("two");
  });

  test("an oversized file is refused unless forced (REQ-EDGE-010)", async () => {
    const repo = await ws.createRepo("blame-big");
    await repo.commit({
      message: "big",
      files: { "big.txt": "x\n".repeat(5_600_000) },
      date: fixtureDate(1),
    });

    const r = await doBlame(repo, "big.txt");
    expect("byteSize" in r).toBe(true);
    if ("byteSize" in r) expect(r.byteSize).toBeGreaterThan(10 * 1024 * 1024);
  });
});
