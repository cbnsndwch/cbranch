// Presentation-layer formatting (docs/spec/12 NF-I18N-7: format at render, never store
// pre-formatted). Phase 1 uses the host locale. The relative/absolute date display is a
// user-selectable preference (P1-HIST-8) applied consistently across the history list and
// details panel; the alternate form is always available on hover.

/** Abbreviated object id for display (P1-HIST-2 / P1-DET-1). */
export const shortOid = (oid: string): string => oid.slice(0, 8);

/** Date display preference (P1-HIST-8). */
export type DateMode = "relative" | "absolute";

const DATE_MODE_KEY = "cbranch.ui.dateMode";

/** Read the persisted date preference; defaults to `"relative"` when absent/unreadable. */
export const readDateMode = (): DateMode => {
  try {
    if (typeof localStorage === "undefined") return "relative";
    return localStorage.getItem(DATE_MODE_KEY) === "absolute"
      ? "absolute"
      : "relative";
  } catch {
    return "relative";
  }
};

/** Persist the date preference. No-op when storage is unavailable (NF-CFG-3). */
export const writeDateMode = (mode: DateMode): void => {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(DATE_MODE_KEY, mode);
  } catch {
    // ignore unavailable/blocked storage
  }
};

const RELATIVE_UNITS: ReadonlyArray<
  readonly [Intl.RelativeTimeFormatUnit, number]
> = [
  ["year", 31_536_000_000],
  ["month", 2_592_000_000],
  ["week", 604_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/** Format an absolute instant (epoch ms) as a coarse relative time (e.g. "3 days ago"). */
export const formatRelativeMs = (
  epochMs: number,
  nowMs: number = Date.now(),
): string => {
  if (!Number.isFinite(epochMs)) return "";
  const deltaMs = epochMs - nowMs;
  const abs = Math.abs(deltaMs);
  if (abs < 1000) return "just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: "auto",
  });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return formatter.format(Math.round(deltaMs / ms), unit);
  }
  return "just now";
};

/** Format a raw git ISO date string for display, falling back to the raw value. */
export const formatIso = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/** Format a raw git ISO date string per the chosen mode (P1-HIST-8). */
export const formatDate = (
  iso: string,
  mode: DateMode,
  nowMs?: number,
): string => {
  if (mode === "absolute") return formatIso(iso);
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : formatRelativeMs(date.getTime(), nowMs);
};

/** Format a committed instant (epoch seconds) for display. */
export const formatEpoch = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleString();

/** Format a committed instant (epoch seconds) per the chosen mode (P1-HIST-8). */
export const formatInstant = (
  epochSeconds: number,
  mode: DateMode,
  nowMs?: number,
): string =>
  mode === "absolute"
    ? formatEpoch(epochSeconds)
    : formatRelativeMs(epochSeconds * 1000, nowMs);
