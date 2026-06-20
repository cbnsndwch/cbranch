// Commit-graph lane layout (docs/spec/10-commit-graph.md).
//
// A pure, deterministic, APPEND-ONLY lane assignment computed directly from commit
// parent data — no layout library. Commits arrive in the server's fixed
// `--topo-order --date-order` (every parent below its children, REQ-GRAPH-002), and each
// is placed without ever moving an already-placed row (REQ-GRAPH-020). The result for a
// row depends only on the commits at or above it, so recomputing as the stream grows is
// stable across scrolling (REQ-GRAPH-008) and viewport-independent.
//
// Lanes are integer columns (REQ-GRAPH-003); a lane "tracks" the oid it is waiting to
// reach. The node sits at the row's vertical centre; the cell is split into a top half
// (incoming edges, y 0 -> 0.5) and a bottom half (outgoing edges, y 0.5 -> 1). Parents
// not yet in the rendered set keep their lane open to the bottom boundary (REQ-GRAPH-007).

/** Number of lane colors — the curated Tailwind 500 palette (`--graph-1..16`, REQ-GRAPH-009). */
export const GRAPH_PALETTE_SIZE = 16;

/**
 * Deterministic 32-bit FNV-1a hash of a commit oid. Used to map a lane's *seed* (the commit
 * that opened the lane) to a stable palette color, so a line of development keeps one color
 * for its whole length and distinct branches get pseudo-randomly different colors.
 */
const hashOid = (oid: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < oid.length; i++) {
    h ^= oid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** Stable 1-based palette color for a lane, keyed on its seed oid (REQ-GRAPH-010). */
const colorOfSeed = (seed: string): number =>
  (hashOid(seed) % GRAPH_PALETTE_SIZE) + 1;

/** A vertical half of an edge within a row cell, in (lane, half-row) coordinates. */
export interface GraphSegment {
  /** Lane index where the segment starts. */
  readonly fromLane: number;
  /** Lane index where the segment ends. */
  readonly toLane: number;
  /** Vertical start: 0 = top boundary, 0.5 = node centre. */
  readonly fromY: 0 | 0.5;
  /** Vertical end: 0.5 = node centre, 1 = bottom boundary. */
  readonly toY: 0.5 | 1;
  /** 1-based palette color index (`--graph-N`) of the lane this segment belongs to. */
  readonly color: number;
}

/** Per-row render data for the graph cell. Self-contained: a row never depends on rows below it. */
export interface GraphRow {
  /** Lane index of this commit's node (REQ-GRAPH-003). */
  readonly lane: number;
  /** 1-based palette color of the node's lane (hashed from the lane's seed commit). */
  readonly color: number;
  /** Lanes spanning this row (node + incoming + outgoing), for cell width. */
  readonly laneCount: number;
  /** Edge halves to draw in this row's cell. */
  readonly segments: ReadonlyArray<GraphSegment>;
}

/** First free (null) slot in the lane vector, or the next index past the end. */
const firstFree = (lanes: ReadonlyArray<string | null>): number => {
  for (let i = 0; i < lanes.length; i++) if (lanes[i] === null) return i;
  return lanes.length;
};

/** Trailing-null-trimmed length: the count of meaningful lanes. */
const usedLength = (lanes: ReadonlyArray<string | null>): number => {
  let n = lanes.length;
  while (n > 0 && lanes[n - 1] === null) n--;
  return n;
};

/** A commit reduced to what layout needs: its id and ordered parent ids. */
export interface GraphInput {
  readonly oid: string;
  readonly parents: ReadonlyArray<string>;
}

/**
 * Incremental layout engine. Feed commits top-to-bottom with {@link push}; each call
 * returns that row's render data and never alters a prior row (append-only).
 */
export class GraphLayout {
  /** Lane vector: `lanes[i]` is the oid lane `i` is waiting to render, or null if free. */
  private readonly lanes: Array<string | null> = [];
  /**
   * Per-lane seed oid: the commit that opened the lane's current line of development. A lane
   * keeps its seed (and therefore its color) for its whole length; a freed-then-reused lane
   * takes a fresh seed. Parallel to {@link lanes}.
   */
  private readonly seeds: Array<string | null> = [];

  push(commit: GraphInput): GraphRow {
    const before = this.lanes.slice();
    const beforeSeeds = this.seeds.slice();

    // Lanes already reserved for this commit (its children reach it here). The leftmost is
    // the node's lane; the rest are merging children's lanes that terminate at the node.
    const myLanes: number[] = [];
    for (let i = 0; i < before.length; i++)
      if (before[i] === commit.oid) myLanes.push(i);
    const lane = myLanes.length > 0 ? myLanes[0]! : firstFree(before);

    // The node's seed (its color): inherited from the lane a child reached it on, or — if no
    // child reaches it (a tip with no rendered children) — the commit itself opens a new line.
    const nodeSeed = myLanes.length > 0 ? beforeSeeds[lane]! : commit.oid;

    // Build the lane state for the rows below (`after`): free this commit's lanes, then route
    // its parents. The first parent continues straight down in the node's lane, carrying the
    // node's color onward; each further parent reuses a lane already awaiting it (shared
    // parent, keeping that lane's color) or opens a fresh lane seeded by the parent oid.
    const after = before.slice();
    const afterSeeds = beforeSeeds.slice();
    while (after.length <= lane) {
      after.push(null);
      afterSeeds.push(null);
    }
    for (const i of myLanes) {
      after[i] = null;
      afterSeeds[i] = null;
    }

    const parentLanes: number[] = [];
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        after[lane] = parent;
        afterSeeds[lane] = nodeSeed;
        parentLanes.push(lane);
        return;
      }
      const existing = after.indexOf(parent);
      if (existing !== -1) {
        parentLanes.push(existing);
        return;
      }
      const slot = firstFree(after);
      while (after.length <= slot) {
        after.push(null);
        afterSeeds.push(null);
      }
      after[slot] = parent;
      afterSeeds[slot] = parent;
      parentLanes.push(slot);
    });
    const parentLaneSet = new Set(parentLanes);

    const segments: GraphSegment[] = [];

    // Top half (incoming, y 0 -> 0.5): each occupied incoming lane either arrives at the node
    // (it was tracking this commit) or passes straight through, keeping its own lane color.
    for (let i = 0; i < before.length; i++) {
      if (before[i] === null) continue;
      const color = colorOfSeed(beforeSeeds[i]!);
      if (before[i] === commit.oid) {
        segments.push({ fromLane: i, toLane: lane, fromY: 0, toY: 0.5, color });
      } else {
        segments.push({ fromLane: i, toLane: i, fromY: 0, toY: 0.5, color });
      }
    }

    // Bottom half (outgoing, y 0.5 -> 1): pass-through reservations continue straight; each
    // parent destination emanates from the node (diagonally if the lane shifts), colored by
    // the destination lane's seed so a merged-in side branch carries its own color downward.
    for (let j = 0; j < after.length; j++) {
      if (after[j] === null) continue;
      const color = colorOfSeed(afterSeeds[j]!);
      const passthrough = before[j] === after[j];
      if (passthrough) {
        segments.push({ fromLane: j, toLane: j, fromY: 0.5, toY: 1, color });
      }
      if (parentLaneSet.has(j) && !(passthrough && j === lane)) {
        segments.push({ fromLane: lane, toLane: j, fromY: 0.5, toY: 1, color });
      }
    }

    // Commit the new lane state for the next push.
    this.lanes.length = 0;
    this.seeds.length = 0;
    for (let i = 0; i < after.length; i++) {
      this.lanes.push(after[i] ?? null);
      this.seeds.push(afterSeeds[i] ?? null);
    }

    const laneCount = Math.max(usedLength(before), usedLength(after), lane + 1);
    return { lane, color: colorOfSeed(nodeSeed), laneCount, segments };
  }
}

/** Lay out a full (or partial) ordered commit list. Equivalent to feeding each via {@link GraphLayout.push}. */
export const layoutCommits = (
  commits: ReadonlyArray<GraphInput>,
): GraphRow[] => {
  const engine = new GraphLayout();
  return commits.map((c) => engine.push(c));
};

/** The widest lane span across a laid-out set, for sizing the graph column. */
export const maxLaneCount = (rows: ReadonlyArray<GraphRow>): number =>
  rows.reduce((max, row) => Math.max(max, row.laneCount), 0);
