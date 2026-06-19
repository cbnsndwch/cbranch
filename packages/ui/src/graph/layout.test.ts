import { describe, expect, test } from "vitest";

import { GraphLayout, GRAPH_PALETTE_SIZE, layoutCommits, maxLaneCount } from "./layout";

// Helper: an ordered commit (parents below children, as the server streams them).
const c = (oid: string, ...parents: string[]) => ({ oid, parents });

// Does the row carry an edge that ends at the node (top half arriving at `lane`)?
const arrivesAtNode = (row: { lane: number; segments: ReadonlyArray<{ toLane: number; toY: number }> }) =>
  row.segments.filter((s) => s.toY === 0.5 && s.toLane === row.lane);

// Bottom-half edges leaving the node toward a parent lane.
const leavesNode = (row: { lane: number; segments: ReadonlyArray<{ fromLane: number; fromY: number; toY: number }> }) =>
  row.segments.filter((s) => s.fromY === 0.5 && s.toY === 1 && s.fromLane === row.lane);

describe("GraphLayout — ordering and structure (spec 10)", () => {
  test("linear history is a single straight lane (REQ-GRAPH-edge-cases)", () => {
    const rows = layoutCommits([c("a", "b"), c("b", "c"), c("c")]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(maxLaneCount(rows)).toBe(1);
    // No segment ever leaves lane 0.
    for (const row of rows) for (const s of row.segments) expect(s.fromLane === 0 && s.toLane === 0).toBe(true);
  });

  test("a single commit renders one node and no edges", () => {
    const rows = layoutCommits([c("a")]);
    expect(rows[0]!.lane).toBe(0);
    expect(rows[0]!.segments).toHaveLength(0);
  });

  test("root commit terminates its lane (no outgoing bottom-half edge)", () => {
    const rows = layoutCommits([c("a", "b"), c("b")]);
    const root = rows[1]!;
    expect(root.segments.some((s) => s.toY === 1)).toBe(false);
  });
});

describe("GraphLayout — merges and branch points (REQ-GRAPH-005/006)", () => {
  test("a merge commit draws one outgoing edge per parent, diverging from the node", () => {
    // m has two parents p1, p2; both appear in the rendered set below.
    const rows = layoutCommits([c("m", "p1", "p2"), c("p1", "base"), c("p2", "base"), c("base")]);
    const merge = rows[0]!;
    const out = leavesNode(merge);
    expect(out).toHaveLength(2);
    // First parent stays in the node's lane; the second takes a fresh lane to the right.
    const dests = out.map((s) => s.toLane).toSorted();
    expect(dests[0]).toBe(merge.lane);
    expect(dests[1]).toBeGreaterThan(merge.lane);
  });

  test("a branch point converges child edges into the shared parent's node", () => {
    // Both p1 and p2 have parent `base`; base is a branch point with two children above it.
    const rows = layoutCommits([c("m", "p1", "p2"), c("p1", "base"), c("p2", "base"), c("base")]);
    const base = rows[3]!;
    // Two distinct incoming lanes arrive at base's node.
    const arrivals = arrivesAtNode(base);
    const fromLanes = new Set(arrivals.map((s) => s.fromLane));
    expect(fromLanes.size).toBe(2);
  });

  test("octopus merge (3 parents) draws one edge per parent (REQ edge-cases)", () => {
    const rows = layoutCommits([c("m", "p1", "p2", "p3"), c("p1"), c("p2"), c("p3")]);
    expect(leavesNode(rows[0]!)).toHaveLength(3);
  });
});

describe("GraphLayout — truncation and stability", () => {
  test("a parent outside the rendered window leaves an open-ended outgoing lane (REQ-GRAPH-007)", () => {
    // `a`'s parent `z` never arrives (window truncated): lane 0 stays reserved to the bottom.
    const rows = layoutCommits([c("a", "z")]);
    const tail = rows[0]!;
    expect(tail.segments.some((s) => s.toY === 1 && s.toLane === tail.lane)).toBe(true);
  });

  test("incremental push matches a full relayout (append-only determinism, REQ-GRAPH-020)", () => {
    const commits = [c("m", "p1", "p2"), c("p1", "base"), c("p2", "base"), c("base", "root"), c("root")];
    const full = layoutCommits(commits);
    const engine = new GraphLayout();
    const incremental = commits.map((x) => engine.push(x));
    expect(incremental).toEqual(full);
  });

  test("appending more commits never changes an already-placed row's lane", () => {
    const head = [c("m", "p1", "p2"), c("p1", "base")];
    const grown = [...head, c("p2", "base"), c("base")];
    const a = layoutCommits(head);
    const b = layoutCommits(grown);
    expect(b.slice(0, head.length).map((r) => r.lane)).toEqual(a.map((r) => r.lane));
  });
});

describe("GraphLayout — lane colors (REQ-GRAPH-009/010)", () => {
  test("color is deterministic per lane and adjacent lanes differ", () => {
    const rows = layoutCommits([c("m", "p1", "p2"), c("p1", "base"), c("p2", "base"), c("base")]);
    // Node color is the 1-based palette index of its lane.
    expect(rows[0]!.color).toBe(1);
    for (const row of rows) {
      expect(row.color).toBeGreaterThanOrEqual(1);
      expect(row.color).toBeLessThanOrEqual(GRAPH_PALETTE_SIZE);
    }
  });
});
