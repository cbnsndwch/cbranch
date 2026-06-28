import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import { gc, gcArgs } from "./maintenance";

describe("gcArgs (pure argv builder)", () => {
  test("default — plain `gc`, no --aggressive, no --prune", () => {
    expect(gcArgs()).toEqual(["gc"]);
    expect(gcArgs(false, "default")).toEqual(["gc"]);
  });

  test("aggressive adds --aggressive", () => {
    expect(gcArgs(true)).toEqual(["gc", "--aggressive"]);
  });

  test('prune "now" adds --prune=now; "default" omits --prune', () => {
    expect(gcArgs(false, "now")).toEqual(["gc", "--prune=now"]);
    expect(gcArgs(undefined, "default")).toEqual(["gc"]);
  });

  test("aggressive + prune now combine in order", () => {
    expect(gcArgs(true, "now")).toEqual(["gc", "--aggressive", "--prune=now"]);
  });
});

describe("gc repository maintenance", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  test("gc succeeds and returns a GcResult; the repo survives intact", async () => {
    const repo = await ws.createRepo("gc-basic");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const before = await repo.revParse("HEAD");

    const result = await run(gc(repo.dir));

    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    // Objects are repacked, not destroyed: HEAD still resolves to the same commit.
    expect(await repo.revParse("HEAD")).toBe(before);
  });

  test("gc --aggressive --prune=now also succeeds", async () => {
    const repo = await ws.createRepo("gc-aggressive");
    await repo.commit({ message: "a", files: { "a.txt": "a\n" } });
    await repo.commit({ message: "b", files: { "b.txt": "b\n" } });
    const before = await repo.revParse("HEAD");

    const result = await run(gc(repo.dir, true, "now"));

    expect(typeof result.stdout).toBe("string");
    expect(await repo.revParse("HEAD")).toBe(before);
  });

  test("gc outside a repository fails as gitFailed (exit-status authoritative)", async () => {
    const plain = await ws.createPlainDir("gc-not-a-repo");

    const err = await Effect.runPromise(Effect.flip(gc(plain)));

    expect(err.code).toBe("gitFailed");
  });
});
