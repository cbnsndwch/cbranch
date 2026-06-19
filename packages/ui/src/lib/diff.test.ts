import { DiffFile, RepoId } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import {
  allDirPaths,
  buildDiffSpec,
  buildFileTree,
  changedLineCount,
  defaultDiffOptions,
  diffTotals,
  flatRows,
  isLargeDiff,
  isSubmodule,
  treeRows,
} from "./diff";

const repoId = RepoId.make("repo-1");

const mkFile = (over: Partial<DiffFile> & { newPath: string }): DiffFile =>
  new DiffFile({
    oldPath: over.oldPath ?? over.newPath,
    newPath: over.newPath,
    status: over.status ?? "modified",
    isBinary: over.isBinary ?? false,
    additions: over.additions ?? 1,
    deletions: over.deletions ?? 1,
    hunks: over.hunks ?? [],
    oldMode: over.oldMode,
    newMode: over.newMode,
  });

describe("buildDiffSpec (P1-DET-3 / P1-DIFF-5)", () => {
  test("maps options to the wire DiffSpec; combined drops the base", () => {
    const spec = buildDiffSpec(repoId, "abc", { whitespace: "ignore-all", context: 5, base: "p2", combined: false });
    expect(spec).toMatchObject({ target: "abc", whitespace: "ignore-all", context: 5, base: "p2", combined: false });
    const combined = buildDiffSpec(repoId, "abc", { ...defaultDiffOptions, base: "p2", combined: true });
    expect(combined.combined).toBe(true);
    expect(combined.base).toBeUndefined();
  });
});

describe("classification helpers", () => {
  test("submodule detected by the 160000 mode (P1-DIFF-10)", () => {
    expect(isSubmodule(mkFile({ newPath: "vendor/lib", newMode: "160000" }))).toBe(true);
    expect(isSubmodule(mkFile({ newPath: "a.ts" }))).toBe(false);
  });

  test("changedLineCount sums numstat, large-diff gate respects the threshold (P1-DIFF-9)", () => {
    const big = mkFile({ newPath: "big.ts", additions: 1500, deletions: 600 });
    expect(changedLineCount(big)).toBe(2100);
    expect(isLargeDiff(big)).toBe(true);
    expect(isLargeDiff(big, 5000)).toBe(false);
    expect(isLargeDiff(mkFile({ newPath: "big.bin", isBinary: true, additions: 0, deletions: 0 }))).toBe(false);
  });

  test("diffTotals aggregates files and counts", () => {
    const totals = diffTotals([
      mkFile({ newPath: "a", additions: 2, deletions: 1 }),
      mkFile({ newPath: "b", additions: 3, deletions: 0 }),
    ]);
    expect(totals).toEqual({ files: 2, additions: 5, deletions: 1 });
  });
});

describe("file tree (P1-DIFF-2)", () => {
  const files = [
    mkFile({ newPath: "src/a.ts" }),
    mkFile({ newPath: "src/sub/b.ts" }),
    mkFile({ newPath: "readme.md" }),
  ];

  test("buildFileTree nests by directory, dirs before files", () => {
    const tree = buildFileTree(files);
    expect(tree.map((n) => `${n.type}:${n.name}`)).toEqual(["dir:src", "file:readme.md"]);
    expect(allDirPaths(tree)).toEqual(["src", "src/sub"]);
  });

  test("flatRows is one row per file, sorted by path", () => {
    expect(flatRows(files).map((r) => r.path)).toEqual(["readme.md", "src/a.ts", "src/sub/b.ts"]);
  });

  test("treeRows hides collapsed subtrees", () => {
    const tree = buildFileTree(files);
    const expandedAll = new Set(allDirPaths(tree));
    expect(treeRows(tree, expandedAll).some((r) => r.path === "src/sub/b.ts")).toBe(true);
    // Expand only `src` (so `src/sub` is collapsed): its dir row shows, its file does not.
    const rows = treeRows(tree, new Set(["src"]));
    expect(rows.some((r) => r.path === "src/sub")).toBe(true);
    expect(rows.some((r) => r.path === "src/sub/b.ts")).toBe(false);
  });
});
