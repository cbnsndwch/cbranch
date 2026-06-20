import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import {
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./worktrees";

describe("worktreeList", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("single-worktree repo — one entry, isMain=true", async () => {
    const repo = await ws.createRepo("wt-single");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const list = await Effect.runPromise(worktreeList(repo.dir));

    expect(list).toHaveLength(1);
    expect(list[0]?.isMain).toBe(true);
    expect(list[0]?.isBare).toBe(false);
    expect(list[0]?.isDetached).toBe(false);
    expect(list[0]?.branch).toBe("refs/heads/main");
    expect(list[0]?.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(list[0]?.path).toBe(repo.dir);
  });

  test("worktreeAdd creates a linked worktree with a new branch", async () => {
    const repo = await ws.createRepo("wt-add");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-add-linked");

    const info = await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/linked" }),
    );

    expect(info.path).toBe(wtPath);
    expect(info.isMain).toBe(false);
    expect(info.branch).toBe("refs/heads/feat/linked");

    // Verify it appears in the list
    const list = await Effect.runPromise(worktreeList(repo.dir));
    expect(list).toHaveLength(2);
    expect(list.some((w) => w.path === wtPath)).toBe(true);
  });

  test("worktreeRemove removes the linked worktree", async () => {
    const repo = await ws.createRepo("wt-remove");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-remove-linked");

    await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/to-remove" }),
    );
    let list = await Effect.runPromise(worktreeList(repo.dir));
    expect(list).toHaveLength(2);

    await Effect.runPromise(worktreeRemove(repo.dir, wtPath));
    list = await Effect.runPromise(worktreeList(repo.dir));
    expect(list).toHaveLength(1);
    expect(list[0]?.isMain).toBe(true);
  });

  test("worktreePrune completes without error on a clean repo", async () => {
    const repo = await ws.createRepo("wt-prune");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await expect(
      Effect.runPromise(worktreePrune(repo.dir)),
    ).resolves.toBeUndefined();
  });

  test("worktreeAdd with existing branch checks out that branch", async () => {
    const repo = await ws.createRepo("wt-existing-branch");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("side");
    const wtPath = join(ws.root, "wt-existing-linked");

    const info = await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { branch: "side" }),
    );

    expect(info.branch).toBe("refs/heads/side");
    expect(info.path).toBe(wtPath);
  });

  test("bare repo — main worktree isBare=true", async () => {
    const repo = await ws.createRepo("wt-bare", { bare: true });

    const list = await Effect.runPromise(worktreeList(repo.dir));

    expect(list).toHaveLength(1);
    expect(list[0]?.isMain).toBe(true);
    expect(list[0]?.isBare).toBe(true);
    expect(list[0]?.branch).toBeUndefined();
  });

  test("worktreeAdd with no branch opts — creates worktree with auto-named branch", async () => {
    const repo = await ws.createRepo("wt-no-branch");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-nb-linked");

    const info = await Effect.runPromise(worktreeAdd(repo.dir, wtPath, {}));

    expect(info.path).toBe(wtPath);
    expect(info.isMain).toBe(false);
  });

  test("locked worktree without reason — isLocked=true, lockReason=undefined", async () => {
    const repo = await ws.createRepo("wt-locked-nr");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-locked-nr-linked");

    await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/lock-nr" }),
    );
    await repo.git(["worktree", "lock", wtPath]);

    const list = await Effect.runPromise(worktreeList(repo.dir));
    const wt = list.find((w) => w.path === wtPath);
    expect(wt?.isLocked).toBe(true);
    expect(wt?.lockReason).toBeUndefined();
  });

  test("locked worktree with reason — lockReason is populated", async () => {
    const repo = await ws.createRepo("wt-locked-reason");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-lr-linked");

    await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/lr" }),
    );
    await repo.git(["worktree", "lock", "--reason", "CI hold", wtPath]);

    const list = await Effect.runPromise(worktreeList(repo.dir));
    const wt = list.find((w) => w.path === wtPath);
    expect(wt?.isLocked).toBe(true);
    expect(wt?.lockReason).toBe("CI hold");
  });

  test("empty repo — main worktree has no headOid", async () => {
    const repo = await ws.createRepo("wt-empty");

    const list = await Effect.runPromise(worktreeList(repo.dir));

    expect(list).toHaveLength(1);
    expect(list[0]?.isMain).toBe(true);
    // Unborn branch: HEAD points to a ref that doesn't exist yet — no HEAD oid in porcelain output
    // (git omits the HEAD line when the branch has no commits)
    expect(list[0]?.headOid).toBeUndefined();
  });

  test("detached HEAD worktree — isDetached=true, no branch", async () => {
    const repo = await ws.createRepo("wt-detached");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-detached-linked");

    // Use raw git to add a detached worktree
    await repo.git(["worktree", "add", "--detach", wtPath, "HEAD"]);

    const list = await Effect.runPromise(worktreeList(repo.dir));
    const wt = list.find((w) => w.path === wtPath);
    expect(wt).toBeDefined();
    expect(wt?.isDetached).toBe(true);
    expect(wt?.branch).toBeUndefined();
  });

  test("locked worktree — isLocked=true in list", async () => {
    const repo = await ws.createRepo("wt-locked");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-locked-linked");

    // Create the worktree and then lock it via raw git (with a reason to cover lockReason path)
    await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/locked" }),
    );
    await repo.git(["worktree", "lock", "--reason", "keep it safe", wtPath]);

    const list = await Effect.runPromise(worktreeList(repo.dir));
    const wt = list.find((w) => w.path === wtPath);
    expect(wt).toBeDefined();
    expect(wt?.isLocked).toBe(true);
    expect(wt?.lockReason).toBe("keep it safe");
  });

  test("worktreeAdd with startPoint — worktree checks out commit at startPoint", async () => {
    const repo = await ws.createRepo("wt-startpoint");
    const oid1 = await repo.commit({
      message: "first",
      files: { "a.txt": "v1" },
    });
    await repo.commit({ message: "second", files: { "a.txt": "v2" } });
    const wtPath = join(ws.root, "wt-startpoint-linked");

    const info = await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/sp", startPoint: oid1 }),
    );

    expect(info.headOid).toBe(oid1);
  });

  test("worktreeRemove with force — removes worktree even with changes", async () => {
    const { writeFile } = await import("node:fs/promises");

    const repo = await ws.createRepo("wt-force-remove");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-force-remove-linked");

    await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/force" }),
    );

    // Add an uncommitted change in the linked worktree so non-forced remove would fail
    await writeFile(join(wtPath, "a.txt"), "modified");

    // Force remove should succeed despite dirty state
    await Effect.runPromise(worktreeRemove(repo.dir, wtPath, true));

    const list = await Effect.runPromise(worktreeList(repo.dir));
    expect(list.some((w) => w.path === wtPath)).toBe(false);
  });

  test("prunable worktree — isPrunable=true when worktree directory is gone", async () => {
    const { rm } = await import("node:fs/promises");

    const repo = await ws.createRepo("wt-prunable");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const wtPath = join(ws.root, "wt-prunable-linked");

    await Effect.runPromise(
      worktreeAdd(repo.dir, wtPath, { newBranch: "feat/prunable" }),
    );

    // Delete the worktree directory without going through git — makes it prunable
    await rm(wtPath, { recursive: true, force: true });

    const list = await Effect.runPromise(worktreeList(repo.dir));
    const wt = list.find((w) => w.path === wtPath);
    expect(wt).toBeDefined();
    expect(wt?.isPrunable).toBe(true);
  });
});
