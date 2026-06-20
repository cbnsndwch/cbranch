import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runExit } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import {
  branchCheckoutDetached,
  branchCreate,
  branchDelete,
  branchRename,
  branchSetUpstream,
  branchSwitch,
} from "./branch-ops";
import { branchList } from "./branches";

describe("branch lifecycle", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  // ── create ──────────────────────────────────────────────────────────────────

  test("branchCreate — new branch without switching", async () => {
    const repo = await ws.createRepo("bops-create");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const info = await Effect.runPromise(branchCreate(repo.dir, "feat/x"));

    expect(info.name).toBe("feat/x");
    const listing = await Effect.runPromise(branchList(repo.dir));
    // HEAD still on main — feat/x not current
    expect(listing.currentBranch).toBe("main");
    expect(listing.localBranches.some((b) => b.name === "feat/x")).toBe(true);
  });

  test("branchCreate — switchAfter switches HEAD", async () => {
    const repo = await ws.createRepo("bops-create-sw");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await Effect.runPromise(
      branchCreate(repo.dir, "feat/y", undefined, undefined, true),
    );

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("feat/y");
  });

  test("branchCreate — from a remote-tracking branch with setUpstream", async () => {
    const origin = await ws.createRepo("bops-csu-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("bops-csu-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // Create new branch from remote ref with upstream set
    await Effect.runPromise(
      branchCreate(clone.dir, "feat/z", "origin/main", true),
    );

    const listing = await Effect.runPromise(branchList(clone.dir));
    const feat = listing.localBranches.find((b) => b.name === "feat/z");
    expect(feat).toBeDefined();
    expect(feat?.upstream).toBeDefined();
  });

  // ── switch ──────────────────────────────────────────────────────────────────

  test("branchSwitch — carry (default) switches HEAD", async () => {
    const repo = await ws.createRepo("bops-switch");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("feat/sw");

    await Effect.runPromise(branchSwitch(repo.dir, "feat/sw"));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("feat/sw");
  });

  test("branchSwitch — stash strategy stashes and restores WD changes", async () => {
    const repo = await ws.createRepo("bops-sw-stash");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("feat/stash");

    // Create a dirty working tree
    await repo.writeFile("dirty.txt", "dirty");

    await Effect.runPromise(branchSwitch(repo.dir, "feat/stash", "stash"));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("feat/stash");
  });

  test("branchSwitch — discard strategy forces switch ignoring WD changes", async () => {
    const repo = await ws.createRepo("bops-sw-discard");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("feat/discard");

    // Write a file that conflicts between branches
    await repo.writeFile("b.txt", "dirty");

    await Effect.runPromise(branchSwitch(repo.dir, "feat/discard", "discard"));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("feat/discard");
  });

  test("branchSwitch — stash without reapply leaves the stash on the stack (BR-023)", async () => {
    const repo = await ws.createRepo("bops-sw-no-reapply");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("feat/keep");
    await repo.writeFile("dirty.txt", "dirty");

    await Effect.runPromise(
      branchSwitch(repo.dir, "feat/keep", "stash", false),
    );

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("feat/keep");
    // The stash was NOT popped — it remains for the user to apply later.
    const stashes = await repo.git(["stash", "list"]);
    expect(stashes.stdout).toContain("cbranch-auto-stash");
    // ...and the dirty file is not in the working tree.
    const status = await repo.git(["status", "--porcelain"]);
    expect(status.stdout).not.toContain("dirty.txt");
  });

  test("branchSwitch — stash with reapply restores the working tree (BR-023)", async () => {
    const repo = await ws.createRepo("bops-sw-reapply");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("feat/reapply");
    await repo.writeFile("dirty.txt", "dirty");

    await Effect.runPromise(
      branchSwitch(repo.dir, "feat/reapply", "stash", true),
    );

    const status = await repo.git(["status", "--porcelain"]);
    expect(status.stdout).toContain("dirty.txt");
    const stashes = await repo.git(["stash", "list"]);
    expect(stashes.stdout.trim()).toBe("");
  });

  test("branchSwitch — stash reapply conflict is classified as mergeConflict (BR-023)", async () => {
    const repo = await ws.createRepo("bops-sw-reapply-conflict");
    await repo.commit({ message: "init", files: { "a.txt": "base\n" } });
    // A divergent change to the same file on the target branch.
    await repo.git(["switch", "-c", "other"]);
    await repo.commit({
      message: "other",
      files: { "a.txt": "other-change\n" },
    });
    await repo.git(["switch", "main"]);
    // Dirty the same file on main so re-applying the stash onto `other` conflicts.
    await repo.writeFile("a.txt", "wd-change\n");

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other", "stash", true)),
    );
    expect(err.code).toBe("mergeConflict");
  });

  // ── detached checkout (BR-022) ────────────────────────────────────────────────

  test("branchCheckoutDetached — checks out a commit into a detached HEAD", async () => {
    const repo = await ws.createRepo("bops-detach");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const firstRaw = await repo.git(["rev-parse", "HEAD"]);
    const firstOid = firstRaw.stdout.trim();
    await repo.commit({ message: "second", files: { "b.txt": "b" } });

    await Effect.runPromise(branchCheckoutDetached(repo.dir, firstOid));

    const head = await repo.git(["rev-parse", "HEAD"]);
    expect(head.stdout.trim()).toBe(firstOid);
    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.detachedHead).toBe(firstOid);
    expect(listing.currentBranch).toBeUndefined();
  });

  test("branchCheckoutDetached — rejects a target beginning with '-'", async () => {
    const repo = await ws.createRepo("bops-detach-dash");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const exit = await runExit(branchCheckoutDetached(repo.dir, "--evil"));
    expect(exit._tag).toBe("Failure");
  });

  // ── rename ──────────────────────────────────────────────────────────────────

  test("branchRename — renames the branch", async () => {
    const repo = await ws.createRepo("bops-rename");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("old-name");

    await Effect.runPromise(branchRename(repo.dir, "old-name", "new-name"));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.some((b) => b.name === "new-name")).toBe(true);
    expect(listing.localBranches.some((b) => b.name === "old-name")).toBe(
      false,
    );
  });

  test("branchRename — can rename the currently checked-out branch", async () => {
    const repo = await ws.createRepo("bops-rename-current");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    // HEAD is on main

    await Effect.runPromise(branchRename(repo.dir, "main", "trunk"));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("trunk");
  });

  // ── delete ──────────────────────────────────────────────────────────────────

  test("branchDelete — safe delete of a merged branch succeeds", async () => {
    const repo = await ws.createRepo("bops-delete");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("to-delete");

    await Effect.runPromise(branchDelete(repo.dir, "to-delete", false));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.some((b) => b.name === "to-delete")).toBe(
      false,
    );
  });

  test("branchDelete — safe delete of unmerged branch fails", async () => {
    const repo = await ws.createRepo("bops-delete-unmerged");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("unmerged");
    await repo.git(["switch", "unmerged"]);
    await repo.commit({ message: "unmerged commit", files: { "b.txt": "b" } });
    await repo.git(["switch", "main"]);

    const exit = await runExit(branchDelete(repo.dir, "unmerged", false));
    expect(exit._tag).toBe("Failure");
  });

  test("branchDelete — force delete of unmerged branch succeeds", async () => {
    const repo = await ws.createRepo("bops-delete-force");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("unmerged-force");
    await repo.git(["switch", "unmerged-force"]);
    await repo.commit({ message: "unmerged commit", files: { "b.txt": "b" } });
    await repo.git(["switch", "main"]);

    await Effect.runPromise(branchDelete(repo.dir, "unmerged-force", true));

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.some((b) => b.name === "unmerged-force")).toBe(
      false,
    );
  });

  // ── set-upstream ─────────────────────────────────────────────────────────────

  test("branchSetUpstream — sets upstream ref", async () => {
    const origin = await ws.createRepo("bops-su-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const repo = await ws.createRepo("bops-su-repo");
    await repo.addRemote("origin", origin.dir);
    await repo.fetch("origin");
    await repo.git(["checkout", "-b", "main", "--track", "origin/main"]);
    await repo.branch("feat/up");

    // feat/up has no upstream yet — set it
    await Effect.runPromise(
      branchSetUpstream(repo.dir, "feat/up", "origin/main"),
    );

    const listing = await Effect.runPromise(branchList(repo.dir));
    const feat = listing.localBranches.find((b) => b.name === "feat/up");
    expect(feat?.upstream).toBeDefined();
    expect(feat?.upstream?.name).toContain("origin/main");
  });

  test("branchSetUpstream — unsets upstream when called with undefined", async () => {
    const origin = await ws.createRepo("bops-unset-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const repo = await ws.createRepo("bops-unset-repo");
    await repo.addRemote("origin", origin.dir);
    await repo.fetch("origin");
    await repo.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // main tracks origin/main — unset it
    await Effect.runPromise(branchSetUpstream(repo.dir, "main", undefined));

    const listing = await Effect.runPromise(branchList(repo.dir));
    const main = listing.localBranches.find((b) => b.name === "main");
    expect(main?.upstream).toBeUndefined();
  });
});
