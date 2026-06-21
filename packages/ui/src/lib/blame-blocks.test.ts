import { type BlameCommit, type BlameLine } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import {
  blockStartIndices,
  groupBlameBlocks,
  indexCommits,
} from "./blame-blocks";

const line = (ownerOid: string): BlameLine =>
  ({ ownerOid, finalLineNo: 0, origLineNo: 0, content: "" }) as BlameLine;

describe("groupBlameBlocks (REQ-BL-003)", () => {
  test("groups consecutive same-owner lines into one block", () => {
    const blocks = groupBlameBlocks([line("a"), line("a"), line("a")]);
    expect(blocks).toEqual([{ ownerOid: "a", startIndex: 0, count: 3 }]);
  });

  test("starts a new block at every owner change", () => {
    const blocks = groupBlameBlocks([
      line("a"),
      line("a"),
      line("b"),
      line("c"),
      line("c"),
    ]);
    expect(blocks).toEqual([
      { ownerOid: "a", startIndex: 0, count: 2 },
      { ownerOid: "b", startIndex: 2, count: 1 },
      { ownerOid: "c", startIndex: 3, count: 2 },
    ]);
  });

  test("a returning owner forms a SEPARATE block (adjacency, not identity)", () => {
    const blocks = groupBlameBlocks([line("a"), line("b"), line("a")]);
    expect(blocks).toEqual([
      { ownerOid: "a", startIndex: 0, count: 1 },
      { ownerOid: "b", startIndex: 1, count: 1 },
      { ownerOid: "a", startIndex: 2, count: 1 },
    ]);
  });

  test("an empty file yields no blocks", () => {
    expect(groupBlameBlocks([])).toEqual([]);
  });
});

describe("blockStartIndices", () => {
  test("returns the first line index of each block", () => {
    const blocks = groupBlameBlocks([line("a"), line("a"), line("b")]);
    expect([...blockStartIndices(blocks)].sort()).toEqual([0, 2]);
  });
});

describe("indexCommits", () => {
  test("maps each commit by oid", () => {
    const a = { oid: "a", summary: "first" } as BlameCommit;
    const b = { oid: "b", summary: "second" } as BlameCommit;
    const map = indexCommits([a, b]);
    expect(map.get("a")).toBe(a);
    expect(map.get("b")).toBe(b);
    expect(map.get("z")).toBeUndefined();
  });
});
