// Presentation-layer formatting (docs/spec/12 NF-I18N-7: format at render, never store
// pre-formatted). Phase 1 uses the host locale; the relative/absolute date preference
// and i18n-aware formatting land with the history polish.

/** Abbreviated object id for display (P1-HIST-2 / P1-DET-1). */
export const shortOid = (oid: string): string => oid.slice(0, 8);

/** Format a raw git ISO date string for display, falling back to the raw value. */
export const formatIso = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
};

/** Format a committed instant (epoch seconds) for display. */
export const formatEpoch = (epochSeconds: number): string => new Date(epochSeconds * 1000).toLocaleString();
