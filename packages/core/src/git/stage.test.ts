import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";
import { deleteUntracked, discardFiles, resetTo, stageFiles, unstageFiles } from "./stage";

describe("stage git operations", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  test("stageFiles stages a new file", async () => {
    const repo = await ws.createRepo("stage-new-file");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("new.txt", "hello\n");

    await run(stageFiles(repo.dir, ["new.txt"], false));

    const result = await repo.git(["diff", "--cached", "--name-status"]);
    expect(result.stdout).toContain("new.txt");
  });

  test("stageFiles all stages all modified files", async () => {
    const repo = await ws.createRepo("stage-all");
    await repo.commit({ message: "init", files: { "a.txt": "a\n", "b.txt": "b\n" } });
    await repo.writeFile("a.txt", "a2\n");
    await repo.writeFile("b.txt", "b2\n");

    await run(stageFiles(repo.dir, [], true));

    const result = await repo.git(["diff", "--cached", "--name-status"]);
    expect(result.stdout).toContain("a.txt");
    expect(result.stdout).toContain("b.txt");
  });

  test("unstageFiles unstages a staged file", async () => {
    const repo = await ws.createRepo("unstage-file");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await repo.writeFile("a.txt", "a2\n");
    await repo.stage("a.txt");

    await run(unstageFiles(repo.dir, ["a.txt"], false));

    const result = await repo.git(["diff", "--cached", "--name-status"]);
    expect(result.stdout.trim()).toBe("");
  });

  test("unstageFiles all resets all staged changes", async () => {
    const repo = await ws.createRepo("unstage-all");
    await repo.commit({ message: "init", files: { "a.txt": "a\n", "b.txt": "b\n" } });
    await repo.writeFile("a.txt", "a2\n");
    await repo.writeFile("b.txt", "b2\n");
    await repo.stage("a.txt", "b.txt");

    await run(unstageFiles(repo.dir, [], true));

    const result = await repo.git(["diff", "--cached", "--name-status"]);
    expect(result.stdout.trim()).toBe("");
  });

  test("discardFiles restores worktree file to HEAD content", async () => {
    const repo = await ws.createRepo("discard-file");
    await repo.commit({ message: "init", files: { "a.txt": "original\n" } });
    await repo.writeFile("a.txt", "modified\n");

    await run(discardFiles(repo.dir, ["a.txt"]));

    const content = await readFile(join(repo.dir, "a.txt"), "utf8");
    expect(content).toBe("original\n");
  });

  test("deleteUntracked removes an untracked file", async () => {
    const repo = await ws.createRepo("delete-untracked");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("untracked.txt", "untracked\n");

    await run(deleteUntracked(repo.dir, ["untracked.txt"]));

    expect(existsSync(join(repo.dir, "untracked.txt"))).toBe(false);
  });

  test("resetTo mixed moves HEAD back one commit", async () => {
    const repo = await ws.createRepo("reset-to");
    await repo.commit({ message: "a", files: { "a.txt": "a\n" } });
    await repo.commit({ message: "b", files: { "b.txt": "b\n" } });
    const parent = await repo.revParse("HEAD~1");

    await run(resetTo(repo.dir, "mixed", "HEAD~1"));

    const after = await repo.revParse("HEAD");
    expect(after).toBe(parent);
  });

  test("resetTo rejects a leading-dash target", async () => {
    const repo = await ws.createRepo("reset-dash");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    await expect(run(resetTo(repo.dir, "mixed", "--hard"))).rejects.toThrow();
  });
});
