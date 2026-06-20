// Quick incremental find over the LOADED history window (P1-FILT-7 / P1-HIST-7).
//
// Distinct from the server-side filters (P1-FILT-1..5): this never re-queries git, it just
// matches the rows already streamed in, by commit subject or (abbreviated) hash, so it is
// responsive as the user types. The hash match also backs "jump to commit by hash"
// (P1-HIST-7) within the loaded window; resolving a hash beyond the window would need a
// server rev-parse the P1 contract does not expose.

export interface FindRow {
  readonly oid: string;
  readonly subject: string;
}

/** Indices of loaded rows whose subject or hash contains `query` (case-insensitive). */
export const findMatches = (
  rows: ReadonlyArray<FindRow>,
  query: string,
): ReadonlyArray<number> => {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const matches: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (
      row.subject.toLowerCase().includes(q) ||
      row.oid.toLowerCase().includes(q)
    )
      matches.push(i);
  }
  return matches;
};

/** Step a match pointer with wrap-around; returns the new pointer (or -1 when there are none). */
export const stepMatch = (
  count: number,
  current: number,
  direction: 1 | -1,
): number => {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
};
