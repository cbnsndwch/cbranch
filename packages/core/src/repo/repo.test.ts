import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run, runExit } from "../testing/effect-run";
import { createFixtureWorkspace, type FixtureWorkspace, seedConflict } from "../testing/fixtures";
import { resolveRepo } from "./resolve";
import { detectInProgress, parseBranchHeader, readRepoState } from "./state";

let ws: FixtureWorkspace;
beforeAll(async () => {
  ws = await createFixtureWorkspace();
});
afterAll(async () => {
  await ws.cleanup();
});

describe("parseBranchHeader (porcelain v2 -z headers)", () => {
  test("parses oid + head from NUL-terminated records", () => {
    const buf = Buffer.from("# branch.oid abc123\0# branch.head main\0");
    expect(parseBranchHeader(buf)).toEqual({ oid: "abc123", head: "main" });
  });

  test("recognizes (initial) and (detached) sentinels", () => {
    expect(parseBranchHeader(Buffer.from("# branch.oid (initial)\0# branch.head main\0"))).toEqual({
      oid: "(initial)",
      head: "main",
    });
    expect(parseBranchHeader(Buffer.from("# branch.oid abc\0# branch.head (detached)\0")).head).toBe("(detached)");
  });
});

const gitDirWith = (...markers: Array<string | [string, string]>): string => {
  const dir = mkdtempSync(join(tmpdir(), "cbranch-gitdir-"));
  for (const m of markers) {
    if (typeof m === "string") writeFileSync(join(dir, m), "");
    else {
      mkdirSync(join(dir, m[0]), { recursive: true });
      writeFileSync(join(dir, m[0], m[1]), "");
    }
  }
  return dir;
};

describe("detectInProgress (P1-OPEN-3 markers)", () => {
  test("maps each marker to its operation label", () => {
    expect(detectInProgress(gitDirWith())).toBe("none");
    expect(detectInProgress(gitDirWith("MERGE_HEAD"))).toBe("merge");
    expect(detectInProgress(gitDirWith("CHERRY_PICK_HEAD"))).toBe("cherryPick");
    expect(detectInProgress(gitDirWith("REVERT_HEAD"))).toBe("revert");
    expect(detectInProgress(gitDirWith("BISECT_LOG"))).toBe("bisect");
    expect(detectInProgress(gitDirWith(["rebase-merge", "x"]))).toBe("rebase");
    expect(detectInProgress(gitDirWith(["rebase-apply", "x"]))).toBe("rebase");
    expect(detectInProgress(gitDirWith(["rebase-apply", "applying"]))).toBe("am");
  });
});

describe("resolveRepo (P1-OPEN-2)", () => {
  test("classifies a normal repo and yields a 64-hex repoId", async () => {
    const repo = await ws.createRepo("normal");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const resolved = await run(resolveRepo(repo.dir));
    expect(resolved.isBare).toBe(false);
    expect(resolved.repoId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a subdir resolves to the same repoId + top-level root", async () => {
    const repo = await ws.createRepo("withsub");
    await repo.commit({ message: "init", files: { "pkg/x.txt": "x\n" } });
    const fromRoot = await run(resolveRepo(repo.dir));
    const fromSub = await run(resolveRepo(join(repo.dir, "pkg")));
    expect(fromSub.repoId).toBe(fromRoot.repoId);
    expect(fromSub.root).toBe(fromRoot.root);
  });

  test("sibling worktrees collapse to one repoId (DECISIONS D2)", async () => {
    const repo = await ws.createRepo("wtmain");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const linked = await repo.worktreeAdd("../wt-feature", { branch: "feature" });
    const main = await run(resolveRepo(repo.dir));
    const wt = await run(resolveRepo(linked.dir));
    expect(wt.repoId).toBe(main.repoId);
    expect(wt.root).not.toBe(main.root); // different working trees…
  });

  test("a bare repo is classified bare", async () => {
    const bare = await ws.createRepo("bare.git", { bare: true });
    const resolved = await run(resolveRepo(bare.dir));
    expect(resolved.isBare).toBe(true);
  });

  test("a non-repo directory fails with notARepository (AC-2)", async () => {
    const plain = await ws.createPlainDir("plain");
    const exit = await runExit(resolveRepo(plain));
    expect(Exit.isFailure(exit)).toBe(true);
    const err = await run(Effect.flip(resolveRepo(plain)));
    expect(err.code).toBe("notARepository");
  });

  test("a missing path fails with repoNotFound", async () => {
    const err = await run(Effect.flip(resolveRepo(join(ws.root, "does-not-exist"))));
    expect(err.code).toBe("repoNotFound");
  });
});

describe("readRepoState (DM-070 / P1-OPEN-3 / P1-STAT-3)", () => {
  test("empty repo: isEmpty, unborn branch, no head oid", async () => {
    const repo = await ws.createRepo("empty");
    const state = await run(Effect.flatMap(resolveRepo(repo.dir), readRepoState));
    expect(state.isEmpty).toBe(true);
    expect(state.currentBranch).toBe("main");
    expect(state.headOid).toBeUndefined();
    expect(state.isDetached).toBe(false);
    expect(state.inProgress).toBe("none");
  });

  test("after a commit: branch + head oid, not empty", async () => {
    const repo = await ws.createRepo("oneCommit");
    const oid = await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const state = await run(Effect.flatMap(resolveRepo(repo.dir), readRepoState));
    expect(state.isEmpty).toBe(false);
    expect(state.currentBranch).toBe("main");
    expect(state.headOid).toBe(oid);
  });

  test("detached HEAD: isDetached, no current branch", async () => {
    const repo = await ws.createRepo("detached");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await repo.commit({ message: "second", files: { "b.txt": "b\n" } });
    await repo.checkout("HEAD", { detach: true });
    const state = await run(Effect.flatMap(resolveRepo(repo.dir), readRepoState));
    expect(state.isDetached).toBe(true);
    expect(state.currentBranch).toBeUndefined();
    expect(state.headOid).toBeDefined();
  });

  test("conflicted merge surfaces inProgress=merge (P1-OPEN-3)", async () => {
    const repo = await ws.createRepo("midmerge");
    await seedConflict(repo);
    const state = await run(Effect.flatMap(resolveRepo(repo.dir), readRepoState));
    expect(state.inProgress).toBe("merge");
  });

  test("bare empty repo: isBare, branch from symbolic-ref", async () => {
    const bare = await ws.createRepo("bare2.git", { bare: true });
    const state = await run(Effect.flatMap(resolveRepo(bare.dir), readRepoState));
    expect(state.isBare).toBe(true);
    expect(state.isEmpty).toBe(true);
    expect(state.currentBranch).toBe("main");
  });
});
