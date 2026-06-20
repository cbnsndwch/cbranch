import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { classifyChange } from "./watcher";

const COMMON = join("/repo", ".git");
const under = (...segs: string[]): string => join(COMMON, ...segs);

describe("classifyChange (15 §3 mapping)", () => {
  test("HEAD / heads / remotes / packed-refs ⇒ refs+commits+inProgress", () => {
    expect(classifyChange(COMMON, under("HEAD"))).toEqual([
      "refs",
      "commits",
      "inProgress",
    ]);
    expect(classifyChange(COMMON, under("refs", "heads", "main"))).toEqual([
      "refs",
      "commits",
      "inProgress",
    ]);
    expect(
      classifyChange(COMMON, under("refs", "remotes", "origin", "main")),
    ).toEqual(["refs", "commits", "inProgress"]);
    expect(classifyChange(COMMON, under("packed-refs"))).toEqual([
      "refs",
      "commits",
      "inProgress",
    ]);
  });

  test("tags ⇒ tags+commits", () => {
    expect(classifyChange(COMMON, under("refs", "tags", "v1"))).toEqual([
      "tags",
      "commits",
    ]);
  });

  test("index ⇒ status; stash refs ⇒ stash; config ⇒ config", () => {
    expect(classifyChange(COMMON, under("index"))).toEqual(["status"]);
    expect(classifyChange(COMMON, under("refs", "stash"))).toEqual(["stash"]);
    expect(classifyChange(COMMON, under("logs", "refs", "stash"))).toEqual([
      "stash",
    ]);
    expect(classifyChange(COMMON, under("config"))).toEqual(["config"]);
  });

  test("worktrees admin ⇒ worktrees", () => {
    expect(classifyChange(COMMON, under("worktrees", "wt1", "HEAD"))).toEqual([
      "worktrees",
    ]);
  });

  test("in-progress state files ⇒ inProgress+refs", () => {
    expect(classifyChange(COMMON, under("MERGE_HEAD"))).toEqual([
      "inProgress",
      "refs",
    ]);
    expect(classifyChange(COMMON, under("CHERRY_PICK_HEAD"))).toEqual([
      "inProgress",
      "refs",
    ]);
    expect(classifyChange(COMMON, under("REVERT_HEAD"))).toEqual([
      "inProgress",
      "refs",
    ]);
    expect(classifyChange(COMMON, under("BISECT_LOG"))).toEqual([
      "inProgress",
      "refs",
    ]);
    expect(classifyChange(COMMON, under("rebase-merge", "done"))).toEqual([
      "inProgress",
      "refs",
    ]);
    expect(classifyChange(COMMON, under("sequencer", "todo"))).toEqual([
      "inProgress",
      "refs",
    ]);
    expect(classifyChange(COMMON, under("ORIG_HEAD"))).toEqual([
      "inProgress",
      "refs",
    ]);
  });

  test("a worktree file (outside the git dir) ⇒ status", () => {
    expect(classifyChange(COMMON, join("/repo", "src", "a.ts"))).toEqual([
      "status",
    ]);
  });

  test("unmapped git-dir files (logs/HEAD, COMMIT_EDITMSG) ⇒ no domains", () => {
    expect(classifyChange(COMMON, under("logs", "HEAD"))).toEqual([]);
    expect(classifyChange(COMMON, under("COMMIT_EDITMSG"))).toEqual([]);
  });
});
