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

  test("branchCreate — rejects a duplicate branch name without partial creation (BR-013)", async () => {
    const repo = await ws.createRepo("bops-dup");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("dup");

    const err = await Effect.runPromise(
      Effect.flip(branchCreate(repo.dir, "dup")),
    );
    expect(err.code).toBe("refExists");

    // The pre-existing branch is untouched — no duplicate, no partial state.
    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.filter((b) => b.name === "dup")).toHaveLength(
      1,
    );
  });

  test("branchCreate — switchAfter duplicate is refExists, not partial (BR-013)", async () => {
    const repo = await ws.createRepo("bops-dup-switch");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.branch("dup2");

    const err = await Effect.runPromise(
      Effect.flip(branchCreate(repo.dir, "dup2", undefined, undefined, true)),
    );
    expect(err.code).toBe("refExists");

    // The create-and-switch was refused atomically — HEAD did not move.
    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("main");
  });

  test("branchCreate — rejects an invalid branch name (BR-013)", async () => {
    const repo = await ws.createRepo("bops-invalid-name");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    // '~' is illegal in a git ref name; git refuses and nothing is created.
    const err = await Effect.runPromise(
      Effect.flip(branchCreate(repo.dir, "bad~name")),
    );
    expect(err.code).toBe("invalidRefName");

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.some((b) => b.name.includes("bad"))).toBe(
      false,
    );
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

  test("branchSwitch — checks out a remote-tracking branch by creating a local tracking branch (BR-021)", async () => {
    const origin = await ws.createRepo("bops-rt-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });
    // A branch that exists ONLY on the remote.
    await origin.branch("feature");

    const clone = await ws.createRepo("bops-rt-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");

    // No local `feature` exists; switching by short name must create it from the
    // unique origin/feature remote-tracking ref and set up tracking.
    await Effect.runPromise(branchSwitch(clone.dir, "feature"));

    const listing = await Effect.runPromise(branchList(clone.dir));
    expect(listing.currentBranch).toBe("feature");
    const feat = listing.localBranches.find((b) => b.name === "feature");
    expect(feat?.upstream?.name).toContain("origin/feature");
  });

  test("branchSwitch — carry that would conflict aborts, leaving the working tree unchanged (BR-024)", async () => {
    const repo = await ws.createRepo("bops-carry-conflict");
    await repo.commit({ message: "init", files: { "a.txt": "base\n" } });
    // `other` changes a.txt; back on main we dirty the SAME file so a carrying
    // switch would have to overwrite local changes — git must refuse.
    await repo.git(["switch", "-c", "other"]);
    await repo.commit({ message: "other", files: { "a.txt": "other\n" } });
    await repo.git(["switch", "main"]);
    await repo.writeFile("a.txt", "work-in-progress\n");

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other")),
    );
    // Machine-classified (NF-GIT-3), not the generic gitFailed: a typed dirtyWorkingTree
    // naming the offending path, so the client can offer carry/stash/discard by code.
    expect(err.code).toBe("dirtyWorkingTree");
    expect((err.detail as { paths: string[] }).paths).toContain("a.txt");

    // The switch was aborted: still on main, and the WD edit is preserved.
    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.currentBranch).toBe("main");
    const status = await repo.git(["status", "--porcelain"]);
    expect(status.stdout).toContain("a.txt");
  });

  test("branchSwitch — carry blocked by an untracked file in the target is dirtyWorkingTree", async () => {
    const repo = await ws.createRepo("bops-carry-untracked");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await repo.git(["switch", "-c", "other"]);
    await repo.commit({
      message: "add new",
      files: { "new.txt": "from-other\n" },
    });
    await repo.git(["switch", "main"]);
    // main has no new.txt; an untracked local new.txt collides with `other`'s tracked
    // version, so a carrying switch would overwrite it — git refuses (untracked class).
    await repo.writeFile("new.txt", "untracked-local\n");

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other")),
    );
    expect(err.code).toBe("dirtyWorkingTree");
    expect((err.detail as { paths: string[] }).paths).toContain("new.txt");
  });

  test("branchSwitch — untracked file inside a NEW target directory is dirtyWorkingTree", async () => {
    const repo = await ws.createRepo("bops-carry-untracked-dir");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await repo.git(["switch", "-c", "other"]);
    await repo.commit({
      message: "add dir",
      files: { "sub/foo.txt": "from-other\n" },
    });
    await repo.git(["switch", "main"]);
    // `sub/` is entirely untracked on main, so git's default status collapses it to a
    // single `sub/` entry — detection must use --untracked-files=all to see the file.
    await repo.writeFile("sub/foo.txt", "untracked-local\n");

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other")),
    );
    expect(err.code).toBe("dirtyWorkingTree");
    expect((err.detail as { paths: string[] }).paths).toContain("sub/foo.txt");
  });

  test("branchSwitch — an untracked file whose name is a target directory is dirtyWorkingTree", async () => {
    const repo = await ws.createRepo("bops-carry-file-vs-dir");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await repo.git(["switch", "-c", "other"]);
    await repo.commit({
      message: "add foo/",
      files: { "foo/bar": "tracked\n" },
    });
    await repo.git(["switch", "main"]);
    // main has no `foo`; an untracked FILE named `foo` collides with `other`'s `foo/` dir.
    await repo.writeFile("foo", "untracked-file\n");

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other")),
    );
    expect(err.code).toBe("dirtyWorkingTree");
    expect((err.detail as { paths: string[] }).paths).toContain("foo");
  });

  test("branchSwitch — a locally-modified file renamed away in the target is dirtyWorkingTree", async () => {
    const repo = await ws.createRepo("bops-carry-rename");
    await repo.commit({ message: "init", files: { "a.txt": "base\n" } });
    await repo.git(["switch", "-c", "other"]);
    await repo.git(["mv", "a.txt", "b.txt"]);
    await repo.git(["commit", "-q", "-m", "rename a->b"]);
    await repo.git(["switch", "main"]);
    // git's plain switch does NO rename detection — it deletes a.txt — so a dirty a.txt
    // would be overwritten; detection must use --no-renames to still see a.txt.
    await repo.writeFile("a.txt", "work-in-progress\n");

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other")),
    );
    expect(err.code).toBe("dirtyWorkingTree");
    expect((err.detail as { paths: string[] }).paths).toContain("a.txt");
  });

  test("branchSwitch — an unmerged index refusal stays gitFailed, not a dead-end dirtyWorkingTree", async () => {
    const repo = await ws.createRepo("bops-switch-unmerged");
    await repo.commit({ message: "base", files: { "f.txt": "base\n" } });
    await repo.git(["switch", "-c", "other"]);
    await repo.commit({ message: "other", files: { "f.txt": "other\n" } });
    await repo.git(["switch", "main"]);
    await repo.commit({ message: "mine", files: { "f.txt": "mine\n" } });
    // A conflicting merge leaves an unmerged index; a switch is then refused on the
    // index-resolution check — NOT a would-be-overwritten case, so it must stay gitFailed.
    await repo.git(["merge", "other"], { allowFailure: true });

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "other")),
    );
    expect(err.code).toBe("gitFailed");
  });

  test("branchSwitch — a non-dirty failure (unknown target) stays gitFailed", async () => {
    const repo = await ws.createRepo("bops-switch-unknown");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    const err = await Effect.runPromise(
      Effect.flip(branchSwitch(repo.dir, "no-such-branch")),
    );
    expect(err.code).toBe("gitFailed");
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

  test("branchDelete — refuses to delete the currently checked-out branch (BR-041)", async () => {
    const repo = await ws.createRepo("bops-del-current");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    // HEAD is on main — neither safe nor force delete may remove it.
    const err = await Effect.runPromise(
      Effect.flip(branchDelete(repo.dir, "main", false)),
    );
    expect(err.code).toBe("gitFailed");
    // The refusal names the holding worktree (BR-041) and identifies it as the
    // active one.
    expect(err.message).toContain("current worktree");
    expect((err.detail as { reason?: string }).reason).toBe(
      "branchCheckedOutElsewhere",
    );
    const forceErr = await Effect.runPromise(
      Effect.flip(branchDelete(repo.dir, "main", true)),
    );
    expect(forceErr.code).toBe("gitFailed");

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.some((b) => b.name === "main")).toBe(true);
  });

  test("branchDelete — refuses to delete a branch checked out in another worktree (BR-041)", async () => {
    const repo = await ws.createRepo("bops-del-wt");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    // A linked worktree holds `wt-branch`.
    await repo.worktreeAdd("wt", { branch: "wt-branch" });

    const err = await Effect.runPromise(
      Effect.flip(branchDelete(repo.dir, "wt-branch", false)),
    );
    expect(err.code).toBe("gitFailed");
    // The refusal names the OTHER worktree that holds the branch (BR-041).
    expect(err.message).toContain("another worktree");
    expect(
      typeof (err.detail as { conflictWorktreePath?: unknown })
        .conflictWorktreePath,
    ).toBe("string");

    const listing = await Effect.runPromise(branchList(repo.dir));
    expect(listing.localBranches.some((b) => b.name === "wt-branch")).toBe(
      true,
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
