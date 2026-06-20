import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";
import { branchList } from "./branches";

describe("branchList", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("single branch repo — current branch reported, no upstream", async () => {
    const repo = await ws.createRepo("bl-single");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const listing = await Effect.runPromise(branchList(repo.dir));

    expect(listing.localBranches).toHaveLength(1);
    const main = listing.localBranches[0];
    expect(main?.name).toBe("main");
    expect(main?.isCurrent).toBe(true);
    expect(main?.isRemote).toBe(false);
    expect(main?.upstream).toBeUndefined();
    expect(listing.currentBranch).toBe("main");
    expect(listing.remoteBranches).toHaveLength(0);
    expect(listing.detachedHead).toBeUndefined();
  });

  test("multiple local branches — current marker correct", async () => {
    const repo = await ws.createRepo("bl-multi");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("feat/thing");
    await repo.branch("fix/bug");

    const listing = await Effect.runPromise(branchList(repo.dir));

    expect(listing.localBranches).toHaveLength(3);
    const names = listing.localBranches.map((b) => b.name).toSorted();
    expect(names).toEqual(["feat/thing", "fix/bug", "main"]);
    const current = listing.localBranches.find((b) => b.isCurrent);
    expect(current?.name).toBe("main");
  });

  test("local branch with upstream + ahead/behind", async () => {
    const origin = await ws.createRepo("bl-origin");
    await origin.commit({ message: "init", files: { "a.txt": "v1" } });

    const clone = await ws.createRepo("bl-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    // Create main tracking origin/main; this also makes main point to origin/main's commit
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // Add a local commit (ahead by 1)
    await clone.commit({ message: "local commit", files: { "b.txt": "b" } });

    const listing = await Effect.runPromise(branchList(clone.dir));

    const main = listing.localBranches.find((b) => b.name === "main");
    expect(main?.upstream).toBeDefined();
    expect(main?.upstream?.name).toContain("origin/main");
    expect(main?.upstream?.ahead).toBe(1);
    expect(main?.upstream?.behind).toBe(0);
    expect(listing.remoteBranches.some((b) => b.name === "origin/main")).toBe(true);
  });

  test("detached HEAD — no currentBranch, detachedHead is populated", async () => {
    const repo = await ws.createRepo("bl-detached");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    // Detach HEAD
    await repo.checkout("HEAD", { detach: true });

    const listing = await Effect.runPromise(branchList(repo.dir));

    expect(listing.currentBranch).toBeUndefined();
    expect(listing.detachedHead).toBeTruthy();
  });

  test("remote-tracking branches include remoteName", async () => {
    const origin = await ws.createRepo("bl-rt-origin");
    await origin.commit({ message: "init", files: { "a.txt": "v1" } });

    const clone = await ws.createRepo("bl-rt-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    const listing = await Effect.runPromise(branchList(clone.dir));

    const remote = listing.remoteBranches.find((b) => b.name === "origin/main");
    expect(remote).toBeDefined();
    expect(remote?.isRemote).toBe(true);
    expect(remote?.remoteName).toBe("origin");
  });

  test("local branch behind its upstream — behind count > 0", async () => {
    const origin = await ws.createRepo("bl-behind-origin");
    await origin.commit({ message: "init", files: { "a.txt": "v1" } });

    const clone = await ws.createRepo("bl-behind-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // Add a commit on origin so clone is behind by 1
    await origin.commit({ message: "origin commit 2", files: { "a.txt": "v2" } });
    await clone.fetch("origin");

    const listing = await Effect.runPromise(branchList(clone.dir));

    const main = listing.localBranches.find((b) => b.name === "main");
    expect(main?.upstream).toBeDefined();
    expect(main?.upstream?.behind).toBeGreaterThan(0);
    expect(main?.upstream?.ahead).toBe(0);
  });

  test("remote HEAD symlink is filtered from remote-tracking list", async () => {
    const origin = await ws.createRepo("bl-remhead-origin");
    await origin.commit({ message: "init", files: { "a.txt": "v1" } });

    const clone = await ws.createRepo("bl-remhead-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    // Create refs/remotes/origin/HEAD symref
    await clone.git(["remote", "set-head", "origin", "main"]);
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    const listing = await Effect.runPromise(branchList(clone.dir));

    // origin/HEAD symref must not appear
    expect(listing.remoteBranches.some((b) => b.name.endsWith("/HEAD"))).toBe(false);
    expect(listing.remoteBranches.some((b) => b.name === "origin/main")).toBe(true);
  });

  test("empty repo (no commits) — empty listing, no detachedHead", async () => {
    const repo = await ws.createRepo("bl-empty");
    // No commits — unborn branch, rev-parse HEAD fails

    const listing = await Effect.runPromise(branchList(repo.dir));

    expect(listing.localBranches).toHaveLength(0);
    expect(listing.remoteBranches).toHaveLength(0);
    expect(listing.currentBranch).toBeUndefined();
    expect(listing.detachedHead).toBeUndefined();
  });

  test("tip commit OID and subject are populated", async () => {
    const repo = await ws.createRepo("bl-tip");
    await repo.commit({ message: "the subject line", files: { "a.txt": "a" } });

    const listing = await Effect.runPromise(branchList(repo.dir));

    const main = listing.localBranches[0];
    expect(main?.tipOid).toMatch(/^[0-9a-f]{40}$/);
    expect(main?.tipSubject).toBe("the subject line");
  });

  test("branch with deleted upstream — upstream is undefined (gone)", async () => {
    const origin = await ws.createRepo("bl-gone-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });
    // Create a feature branch on origin
    await origin.branch("feat/gone");

    const clone = await ws.createRepo("bl-gone-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);
    await clone.git(["checkout", "-b", "feat/gone", "--track", "origin/feat/gone"]);

    // Delete the branch on origin
    await origin.deleteBranch("feat/gone");
    // Fetch with prune so remote-tracking branch is removed
    await clone.git(["fetch", "origin", "--prune"]);

    const listing = await Effect.runPromise(branchList(clone.dir));

    // The local feat/gone branch has a [gone] upstream — upstream should be absent
    const feat = listing.localBranches.find((b) => b.name === "feat/gone");
    expect(feat).toBeDefined();
    expect(feat?.upstream).toBeUndefined();
  });
});
