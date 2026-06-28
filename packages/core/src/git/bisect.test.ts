import { existsSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import {
  bisectMark,
  bisectReset,
  bisectStart,
  bisectStatus,
  parseBisectRefs,
  parseBisectVars,
  parseUnbisectable,
} from "./bisect";

const FS = "\x1f";

describe("bisect parsers (pure)", () => {
  test("parseBisectRefs splits bad + good oids", () => {
    const bad = "a".repeat(40);
    const good = "b".repeat(40);
    const stdout = [
      `refs/bisect/bad${FS}${bad}`,
      `refs/bisect/good-${good}${FS}${good}`,
      "",
    ].join("\n");
    expect(parseBisectRefs(stdout)).toEqual({ bad, goods: [good] });
  });

  test("parseBisectVars reads key=value, stripping quotes", () => {
    const vars = parseBisectVars(
      ["bisect_rev='abc123'", "bisect_nr=3", "bisect_steps=2", ""].join("\n"),
    );
    expect(vars.bisect_rev).toBe("abc123");
    expect(vars.bisect_nr).toBe("3");
    expect(vars.bisect_steps).toBe("2");
  });

  test("parseUnbisectable extracts the candidate oid block", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const text = [
      "There are only 'skip'ped commits left to test.",
      "The first bad commit could be any of:",
      a,
      b,
      "We cannot bisect more!",
    ].join("\n");
    expect(parseUnbisectable(text)).toEqual([a, b]);
    expect(parseUnbisectable("Bisecting: 3 revisions left")).toEqual([]);
  });
});

describe("bisect git operations", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  // A linear repo where a regression file (`bug.txt`) is introduced at c3 and persists.
  const seedRegression = async (name: string) => {
    const repo = await ws.createRepo(name);
    const oids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const files: Record<string, string> = { [`c${i}.txt`]: `${i}\n` };
      if (i === 3) files["bug.txt"] = "regression\n";
      oids.push(await repo.commit({ message: `c${i}`, files }));
    }
    return { repo, gitDir: join(repo.dir, ".git"), oids };
  };

  test("start checks out a midpoint with populated counts; walk concludes at the first bad", async () => {
    const { repo, gitDir, oids } = await seedRegression("bisect-walk");
    const buggy = () => existsSync(join(repo.dir, "bug.txt"));

    let status = await run(bisectStart(repo.dir, gitDir, oids[5], [oids[0]]));
    expect(status.state).toBe("bisecting");
    expect(status.current).toBeDefined();
    expect(status.revisionsRemaining).toBeGreaterThanOrEqual(0);

    let guard = 0;
    while (status.state === "bisecting" && guard < 20) {
      status = await run(
        bisectMark(repo.dir, gitDir, buggy() ? "bad" : "good"),
      );
      guard += 1;
    }
    expect(status.state).toBe("concluded");
    expect(status.firstBad?.oid).toBe(oids[3]);

    // Reset restores the session to inactive (HEAD back on the original branch).
    await run(bisectReset(repo.dir));
    const after = await run(bisectStatus(repo.dir, gitDir));
    expect(after.state).toBe("inactive");
  });

  test("a pre-existing session is detected on a fresh status read (repo-open, BS-006)", async () => {
    const { repo, gitDir, oids } = await seedRegression("bisect-detect");
    await run(bisectStart(repo.dir, gitDir, oids[5], [oids[0]]));

    const status = await run(bisectStatus(repo.dir, gitDir));
    expect(status.state).toBe("bisecting");
    expect(status.startPoint).toBeDefined();

    await run(bisectReset(repo.dir));
  });

  test("start while a session is in progress fails as repoLocked", async () => {
    const { repo, gitDir, oids } = await seedRegression("bisect-busy");
    await run(bisectStart(repo.dir, gitDir, oids[5], [oids[0]]));

    const err = await run(
      Effect.flip(bisectStart(repo.dir, gitDir, oids[5], [oids[0]])),
    );
    expect(err.code).toBe("repoLocked");

    await run(bisectReset(repo.dir));
  });

  test("mark with no bisect in progress fails as gitFailed", async () => {
    const { repo, gitDir } = await seedRegression("bisect-no-session");
    const err = await run(Effect.flip(bisectMark(repo.dir, gitDir, "good")));
    expect(err.code).toBe("gitFailed");
  });
});
