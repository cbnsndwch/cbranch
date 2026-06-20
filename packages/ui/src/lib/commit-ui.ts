// Commit-dialog UI preferences (docs/design/commit-surface.md §2/§5).
//
// The commit experience is a dedicated modal dialog. Two preferences outlive a single
// open/close and are mirrored to localStorage so they survive a reload (the design says
// "Zustand, optionally mirror to localStorage"): the **keep-open-after-commit** toggle
// (default ON, §5) and the **internal split position** of the dialog body (§2 — the
// dialog itself is not resizable, but its inner changes|diff split is). The same
// graceful no-storage fallback pattern as `lib/diff.ts` is used.

const KEEP_OPEN_KEY = "cbranch.ui.commitKeepOpen";
const SPLIT_KEY = "cbranch.ui.commitSplit";

/** Default fraction (0..1) of the dialog body width given to the changes column. */
export const DEFAULT_COMMIT_SPLIT = 0.4;

/** Read the persisted "keep open after commit" preference; defaults to ON (§5). */
export const readKeepOpen = (): boolean => {
  try {
    if (typeof localStorage === "undefined") return true;
    // Absent → default ON; only an explicit "false" turns it off.
    return localStorage.getItem(KEEP_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
};

/** Persist the keep-open preference. No-op when storage is unavailable (NF-CFG-3). */
export const writeKeepOpen = (value: boolean): void => {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(KEEP_OPEN_KEY, value ? "true" : "false");
  } catch {
    // ignore unavailable/blocked storage
  }
};

/** Clamp a split fraction to a sane on-screen range so a column never collapses. */
export const clampSplit = (fraction: number): number =>
  Math.min(0.7, Math.max(0.2, fraction));

/** Read the persisted internal split fraction; defaults to {@link DEFAULT_COMMIT_SPLIT}. */
export const readCommitSplit = (): number => {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_COMMIT_SPLIT;
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw === null) return DEFAULT_COMMIT_SPLIT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSplit(n) : DEFAULT_COMMIT_SPLIT;
  } catch {
    return DEFAULT_COMMIT_SPLIT;
  }
};

/** Persist the internal split fraction. No-op when storage is unavailable. */
export const writeCommitSplit = (fraction: number): void => {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(SPLIT_KEY, String(clampSplit(fraction)));
  } catch {
    // ignore unavailable/blocked storage
  }
};
