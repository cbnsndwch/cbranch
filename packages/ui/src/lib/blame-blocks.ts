// Client-side blame block grouping (docs/spec/08 REQ-BL-003 / REQ-UX-009; AC-11(08)).
//
// `git blame` already carries a per-commit group length in its porcelain header, but the
// contract surfaces a flat per-line model (`BlameLine.ownerOid`) so the client derives the
// contiguous blocks it renders. A "block" is a maximal run of consecutive source lines all
// attributed to the same owning commit: the gutter shows the commit attribution once at the
// block's first line, while every line keeps its own row for selection/navigation.

import { type BlameCommit, type BlameLine } from '@cbranch/rpc-contract';

export interface BlameBlock {
    /** The owning commit oid shared by every line in the block. */
    readonly ownerOid: string;
    /** Index of the block's first line in the flat `lines` array. */
    readonly startIndex: number;
    /** Number of consecutive lines in the block. */
    readonly count: number;
}

/**
 * Group consecutive lines attributed to the same commit into contiguous blocks
 * (REQ-BL-003). A run of the same owner that is interrupted and later resumes forms two
 * separate blocks — grouping is by adjacency, not by owner identity overall.
 */
export const groupBlameBlocks = (
    lines: ReadonlyArray<BlameLine>,
): ReadonlyArray<BlameBlock> => {
    const blocks: BlameBlock[] = [];
    for (let i = 0; i < lines.length; i++) {
        const owner = lines[i]!.ownerOid;
        const last = blocks[blocks.length - 1];
        // `last` always ends at line i-1 (each iteration extends it or pushes a new block), so a
        // matching owner is necessarily adjacent — extend it; otherwise the run is broken, start anew.
        if (last !== undefined && last.ownerOid === owner) {
            blocks[blocks.length - 1] = { ...last, count: last.count + 1 };
        } else {
            blocks.push({ ownerOid: owner, startIndex: i, count: 1 });
        }
    }
    return blocks;
};

/** Index the deduped commit headers by oid for O(1) owner lookups during render. */
export const indexCommits = (
    commits: ReadonlyArray<BlameCommit>,
): ReadonlyMap<string, BlameCommit> => new Map(commits.map(c => [c.oid, c]));

/** The set of line indices that open a block (where the gutter attribution is drawn). */
export const blockStartIndices = (
    blocks: ReadonlyArray<BlameBlock>,
): ReadonlySet<number> => new Set(blocks.map(b => b.startIndex));
