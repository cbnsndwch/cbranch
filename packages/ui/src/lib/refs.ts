// Ref-decoration parsing for history-row labels (P1-HIST-2 / P1-UI-HIST-4; spec 10
// REQ-GRAPH-012..015).
//
// `CommitSummary.refs` carries git's `%D` decoration tokens (split on ", "), e.g.
// `HEAD -> main`, `HEAD` (detached), `tag: v1.0`, `origin/main`, `feature/x`. Because
// `%D` emits only SHORT ref names, a remote-tracking branch (`origin/main`) and a local
// branch whose name contains a slash (`feature/main`) are not perfectly distinguishable
// here; the common `<remote>/<branch>` shape is treated as remote. A future enrichment
// could thread full refnames through the contract to remove the heuristic.

/** The visually distinct label kinds (REQ-GRAPH-013). */
export type RefKind = 'head' | 'localBranch' | 'remoteBranch' | 'tag';

export interface RefLabel {
    /** Classified kind, driving chip color/icon. */
    readonly kind: RefKind;
    /** Short display name (no `tag:`/`HEAD ->` prefix). */
    readonly name: string;
    /** True when this is the branch `HEAD` currently points at (REQ-GRAPH-014). */
    readonly isHead: boolean;
    /** The raw decoration token, for keys/tooltips. */
    readonly raw: string;
}

/** Parse one `%D` decoration token into a structured label. */
export const parseRef = (raw: string): RefLabel => {
    const token = raw.trim();

    // Detached HEAD: the `HEAD` indicator sits on the checked-out commit (REQ-GRAPH-014).
    if (token === 'HEAD')
        return { kind: 'head', name: 'HEAD', isHead: true, raw };

    // `HEAD -> main`: HEAD points at a local branch; mark the branch as current.
    const headArrow = 'HEAD -> ';
    if (token.startsWith(headArrow)) {
        return {
            kind: 'localBranch',
            name: token.slice(headArrow.length),
            isHead: true,
            raw,
        };
    }

    const tagPrefix = 'tag: ';
    if (token.startsWith(tagPrefix)) {
        return {
            kind: 'tag',
            name: token.slice(tagPrefix.length),
            isHead: false,
            raw,
        };
    }

    // Heuristic remote-tracking branch: a `<remote>/<rest>` short name (see file header).
    if (token.includes('/'))
        return { kind: 'remoteBranch', name: token, isHead: false, raw };

    return { kind: 'localBranch', name: token, isHead: false, raw };
};

/**
 * Parse and order a row's decorations for display: the current `HEAD` branch first, then
 * local branches, remote-tracking branches, tags, and a bare detached `HEAD` last.
 */
export const parseRefs = (
    raw: ReadonlyArray<string>,
): ReadonlyArray<RefLabel> => {
    const order: Record<RefKind, number> = {
        localBranch: 0,
        remoteBranch: 1,
        tag: 2,
        head: 3,
    };
    return raw
        .map(parseRef)
        .map((label, index) => ({ label, index }))
        .toSorted((a, b) => {
            if (a.label.isHead !== b.label.isHead)
                return a.label.isHead ? -1 : 1;
            const byKind = order[a.label.kind] - order[b.label.kind];
            return byKind !== 0 ? byKind : a.index - b.index;
        })
        .map(entry => entry.label);
};
