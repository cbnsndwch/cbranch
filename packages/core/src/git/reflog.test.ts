import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import { parseReflog, reflogArgs, reflogList } from "./reflog";

const FS = "\x1f";
const rec = (oid: string, sel: string, gs: string) =>
  `${oid}${FS}${sel}${FS}${gs}`;

describe("reflog parse + argv (pure)", () => {
  test("reflogArgs adds --skip only when paging", () => {
    expect(reflogArgs("HEAD", 50, 0)).toEqual([
      "log",
      "-g",
      "-z",
      `--format=%H${FS}%gd${FS}%gs`,
      "--max-count=50",
      "HEAD",
    ]);
    expect(reflogArgs("main", 50, 50)).toContain("--skip=50");
  });

  test("parses selector/action/message; action splits on the FIRST colon only", () => {
    const oid = "a".repeat(40);
    const stdout = [
      rec(oid, "HEAD@{0}", "commit: init"),
      rec("b".repeat(40), "HEAD@{1}", "reset: moving to HEAD~1"),
      rec("c".repeat(40), "HEAD@{2}", "commit: fix: typo"),
      rec("d".repeat(40), "HEAD@{3}", "rebase (finish): returning"),
      "",
    ].join("\0");

    const entries = parseReflog(stdout);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      selector: "HEAD@{0}",
      action: "commit",
      message: "init",
    });
    expect(entries[1]).toMatchObject({
      action: "reset",
      message: "moving to HEAD~1",
    });
    // First-colon split keeps the rest (incl. further colons) in the message.
    expect(entries[2]).toMatchObject({
      action: "commit",
      message: "fix: typo",
    });
    expect(entries[3]?.action).toBe("rebase (finish)");
  });

  test("drops malformed records (non-hex oid / too few fields)", () => {
    const stdout = [
      rec("not-an-oid", "HEAD@{0}", "commit: x"),
      "only-one-field",
      rec("e".repeat(40), "HEAD@{1}", "commit: ok"),
    ].join("\0");
    const entries = parseReflog(stdout);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("commit");
  });
});

describe("reflogList git operations", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  test("lists HEAD reflog newest-first", async () => {
    const repo = await ws.createRepo("reflog-head");
    await repo.commit({ message: "a", files: { "a.txt": "a\n" } });
    await repo.commit({ message: "b", files: { "b.txt": "b\n" } });

    const page = await run(reflogList(repo.dir, 50));
    expect(page.entries.length).toBeGreaterThanOrEqual(2);
    // Newest entry first; HEAD@{0} is the latest commit.
    expect(page.entries[0]?.selector).toBe("HEAD@{0}");
    expect(page.entries[0]?.action).toBe("commit");
  });

  test("paginates: a full window mints a nextCursor that continues the walk", async () => {
    const repo = await ws.createRepo("reflog-page");
    for (let i = 0; i < 4; i += 1) {
      await repo.commit({ message: `c${i}`, files: { "f.txt": `${i}\n` } });
    }

    const first = await run(reflogList(repo.dir, 2));
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await run(reflogList(repo.dir, 2, "HEAD", first.nextCursor));
    expect(second.entries.length).toBeGreaterThan(0);
    // The second page is strictly older — no overlap with the first.
    const firstSelectors = new Set(first.entries.map((e) => e.selector));
    expect(second.entries.every((e) => !firstSelectors.has(e.selector))).toBe(
      true,
    );
  });

  test("a ref with no reflog / leading dash → empty page or invalidRefName", async () => {
    const repo = await ws.createRepo("reflog-empty");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    const noReflog = await run(reflogList(repo.dir, 50, "no-such-branch"));
    expect(noReflog.entries).toEqual([]);

    const dash = await run(Effect.flip(reflogList(repo.dir, 50, "-x")));
    expect(dash.code).toBe("invalidRefName");
  });
});
