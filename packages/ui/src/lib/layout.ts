// Persisted layout preferences for the main history view.
//
// The history view stacks the commit list over the commit-details panel (tabs + diff),
// separated by a draggable divider. The split position outlives a reload, so — like the
// commit dialog's internal split (`lib/commit-ui.ts`) — it is mirrored to localStorage
// with the same graceful no-storage fallback (NF-CFG-3).

const HISTORY_SPLIT_KEY = "cbranch.ui.historySplit";

/** Default fraction (0..1) of the history view height given to the commit list. */
export const DEFAULT_HISTORY_SPLIT = 0.55;

/** Clamp a split fraction so neither the list nor the details panel collapses. */
export const clampHistorySplit = (fraction: number): number =>
  Math.min(0.8, Math.max(0.2, fraction));

/** Read the persisted history split fraction; defaults to {@link DEFAULT_HISTORY_SPLIT}. */
export const readHistorySplit = (): number => {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_HISTORY_SPLIT;
    const raw = localStorage.getItem(HISTORY_SPLIT_KEY);
    if (raw === null) return DEFAULT_HISTORY_SPLIT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampHistorySplit(n) : DEFAULT_HISTORY_SPLIT;
  } catch {
    return DEFAULT_HISTORY_SPLIT;
  }
};

/** Persist the history split fraction. No-op when storage is unavailable. */
export const writeHistorySplit = (fraction: number): void => {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(
        HISTORY_SPLIT_KEY,
        String(clampHistorySplit(fraction)),
      );
  } catch {
    // ignore unavailable/blocked storage
  }
};
