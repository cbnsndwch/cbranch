import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";
import { stashApply, stashClear, stashDrop, stashList, stashPop, stashPush, stashShow } from "./stash";

describe("stash", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("stashList — empty stash returns empty array", async () => {
    const repo = await ws.createRepo("st-empty");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const entries = await Effect.runPromise(stashList(repo.dir));
    expect(entries).toHaveLength(0);
  });

  test("stashPush — creates entry and stashList returns it", async () => {
    const repo = await ws.createRepo("st-push");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.writeFile("a.txt", "modified");
    await repo.stage("a.txt");

    const entry = await Effect.runPromise(stashPush(repo.dir, { message: "my stash" }));

    expect(entry.index).toBe(0);
    expect(entry.ref).toBe("stash@{0}");
    expect(entry.message).toContain("my stash");

    const list = await Effect.runPromise(stashList(repo.dir));
    expect(list).toHaveLength(1);
    expect(list[0]?.ref).toBe("stash@{0}");
  });

  test("stashPush — multiple stashes are numbered correctly", async () => {
    const repo = await ws.createRepo("st-multi");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await repo.writeFile("a.txt", "v1");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "stash one" }));

    await repo.writeFile("a.txt", "v2");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "stash two" }));

    const list = await Effect.runPromise(stashList(repo.dir));
    expect(list).toHaveLength(2);
    // Stash list is newest-first
    expect(list[0]?.ref).toBe("stash@{0}");
    expect(list[1]?.ref).toBe("stash@{1}");
  });

  test("stashShow — returns diff files for stashed changes", async () => {
    const repo = await ws.createRepo("st-show");
    await repo.commit({ message: "init", files: { "a.txt": "line1\n" } });
    await repo.writeFile("a.txt", "line1\nline2\n");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir));

    const diff = await Effect.runPromise(stashShow(repo.dir, "stash@{0}"));
    expect(diff.length).toBeGreaterThan(0);
    expect(diff[0]?.newPath).toBe("a.txt");
  });

  test("stashApply — restores changes without removing stash entry", async () => {
    const repo = await ws.createRepo("st-apply");
    await repo.commit({ message: "init", files: { "a.txt": "original\n" } });
    await repo.writeFile("a.txt", "changed\n");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "apply-test" }));

    await Effect.runPromise(stashApply(repo.dir, "stash@{0}"));

    // Stash entry still present
    const list = await Effect.runPromise(stashList(repo.dir));
    expect(list).toHaveLength(1);

    // Working tree restored
    const status = await repo.git(["status", "--porcelain"]);
    expect(status.stdout.trim()).not.toBe("");
  });

  test("stashPop — restores changes and removes stash entry", async () => {
    const repo = await ws.createRepo("st-pop");
    await repo.commit({ message: "init", files: { "a.txt": "original\n" } });
    await repo.writeFile("a.txt", "changed\n");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "pop-test" }));

    await Effect.runPromise(stashPop(repo.dir, "stash@{0}"));

    // Stash entry removed
    const list = await Effect.runPromise(stashList(repo.dir));
    expect(list).toHaveLength(0);
  });

  test("stashDrop — removes a specific stash entry", async () => {
    const repo = await ws.createRepo("st-drop");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await repo.writeFile("a.txt", "v1");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "first" }));

    await repo.writeFile("a.txt", "v2");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "second" }));

    // Drop the first (older) stash
    await Effect.runPromise(stashDrop(repo.dir, "stash@{1}"));

    const list = await Effect.runPromise(stashList(repo.dir));
    expect(list).toHaveLength(1);
    expect(list[0]?.ref).toBe("stash@{0}");
  });

  test("stashClear — removes all stash entries", async () => {
    const repo = await ws.createRepo("st-clear");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await repo.writeFile("a.txt", "v1");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "one" }));

    await repo.writeFile("a.txt", "v2");
    await repo.stage("a.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "two" }));

    await Effect.runPromise(stashClear(repo.dir));

    const list = await Effect.runPromise(stashList(repo.dir));
    expect(list).toHaveLength(0);
  });

  test("stashPush with includeUntracked — includes untracked files", async () => {
    const repo = await ws.createRepo("st-untracked");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.writeFile("new.txt", "untracked content");

    // Stash with untracked; without -u it would fail (no changes)
    const entry = await Effect.runPromise(stashPush(repo.dir, { includeUntracked: true }));
    expect(entry.index).toBe(0);

    // Working tree should be clean now
    const statusRaw = await repo.git(["status", "--porcelain"]);
    expect(statusRaw.stdout.trim()).toBe("");
  });

  test("stashPush with keepIndex — staged changes remain after stash", async () => {
    const repo = await ws.createRepo("st-keepindex");
    await repo.commit({ message: "init", files: { "a.txt": "line1\n" } });

    // Stage a change, then add an unstaged modification
    await repo.writeFile("a.txt", "line1\nline2\n");
    await repo.stage("a.txt");
    await repo.writeFile("a.txt", "line1\nline2\nline3\n");

    const entry = await Effect.runPromise(stashPush(repo.dir, { keepIndex: true }));
    expect(entry.index).toBe(0);

    // Index retains the staged change (line2 addition)
    const statusRaw = await repo.git(["status", "--porcelain"]);
    expect(statusRaw.stdout.trim()).toMatch(/^M/);
  });

  test("stashApply — produces conflict error when apply conflicts with HEAD", async () => {
    const repo = await ws.createRepo("st-conflict");
    await repo.commit({ message: "init", files: { "f.txt": "line1\nline2\n" } });

    // Stash a change to line1
    await repo.writeFile("f.txt", "modified\nline2\n");
    await repo.stage("f.txt");
    await Effect.runPromise(stashPush(repo.dir, { message: "conflict stash" }));

    // Commit a conflicting change on the same line
    await repo.commit({ message: "conflict commit", files: { "f.txt": "different\nline2\n" } });

    // Apply the stash — should produce a merge conflict
    const exit = await Effect.runPromiseExit(stashApply(repo.dir, "stash@{0}"));
    expect(exit._tag).toBe("Failure");
  });

  test("stashPush with stagedOnly — only staged changes are stashed", async () => {
    const repo = await ws.createRepo("st-staged");
    await repo.commit({ message: "init", files: { "a.txt": "line1\n", "b.txt": "b\n" } });

    // Stage a change to a.txt but leave b.txt dirty (unstaged)
    await repo.writeFile("a.txt", "line1\nstaged\n");
    await repo.stage("a.txt");
    await repo.writeFile("b.txt", "unstaged change\n");

    const entry = await Effect.runPromise(stashPush(repo.dir, { stagedOnly: true }));
    expect(entry.index).toBe(0);

    // b.txt should still be dirty (unstaged, not stashed)
    const statusRaw = await repo.git(["status", "--porcelain"]);
    expect(statusRaw.stdout).toContain("b.txt");
  });

  test("stashPush branch name is extracted from subject", async () => {
    const repo = await ws.createRepo("st-branch");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.writeFile("a.txt", "modified");
    await repo.stage("a.txt");

    const entry = await Effect.runPromise(stashPush(repo.dir));
    expect(entry.branch).toBe("main");
  });

  test("stashApply on invalid ref — fails with gitFailed", async () => {
    const repo = await ws.createRepo("st-badref");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const exit = await Effect.runPromiseExit(stashApply(repo.dir, "stash@{99}"));
    expect(exit._tag).toBe("Failure");
  });
});
