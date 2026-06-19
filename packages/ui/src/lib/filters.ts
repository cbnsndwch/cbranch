// History filter state and its mapping to a server `LogQuery` (P1-FILT-1..6; spec 05 §2.4).
//
// The filter set is ephemeral per-tab UI state (Zustand). Building a `LogQuery` from it is
// pure and testable here; only present (non-empty) fields are emitted, so absent filters
// stay absent on the wire (DM-003). Multiple filters combine as logical AND server-side
// (P1-FILT-6) because each maps to an independent `git log` constraint.

import { LogQuery, type RepoId } from "@cbranch/rpc-contract";

/** Default head-window size (server-bounded to its cap, NF-LIMIT-5). */
export const DEFAULT_LOG_LIMIT = 500;

export type RefScope = "all" | "current" | "pattern";

/** The active history filters (P1-FILT-1..5). Empty strings mean "no constraint". */
export interface LogFilters {
  readonly refScope: RefScope;
  /** Ref glob when `refScope === "pattern"` (P1-FILT-1). */
  readonly refPattern: string;
  /** Pathspec to scope history to (P1-FILT-2). */
  readonly path: string;
  /** Author name/email substring or pattern (P1-FILT-3). */
  readonly author: string;
  /** Commit-message substring or pattern (P1-FILT-4). */
  readonly grep: string;
  /** Inclusive since date (P1-FILT-5). */
  readonly since: string;
  /** Inclusive until date (P1-FILT-5). */
  readonly until: string;
}

/** The default filter set: current branch, no other constraints (P1-FILT-1 default). */
export const emptyFilters: LogFilters = {
  refScope: "current",
  refPattern: "",
  path: "",
  author: "",
  grep: "",
  since: "",
  until: "",
};

const trimmed = (value: string): string | undefined => {
  const v = value.trim();
  return v === "" ? undefined : v;
};

/** Build the server `LogQuery` for `repoId` from the active filters (only present fields). */
export const buildLogQuery = (repoId: RepoId, filters: LogFilters): LogQuery =>
  new LogQuery({
    repoId,
    limit: DEFAULT_LOG_LIMIT,
    refScope: filters.refScope,
    refPattern: filters.refScope === "pattern" ? trimmed(filters.refPattern) : undefined,
    path: trimmed(filters.path),
    author: trimmed(filters.author),
    grep: trimmed(filters.grep),
    since: trimmed(filters.since),
    until: trimmed(filters.until),
  });

/** A removable summary chip for an active filter (P1-FILT-6 / P1-UI-FILT-1). */
export interface FilterChip {
  /** The filter field this chip clears. */
  readonly key: keyof LogFilters;
  /** Short human summary, e.g. `author: ada`. */
  readonly label: string;
}

/** Derive the visible chips for the active, non-default filters (P1-FILT-6). */
export const describeFilters = (filters: LogFilters): ReadonlyArray<FilterChip> => {
  const chips: FilterChip[] = [];
  if (filters.refScope === "all") chips.push({ key: "refScope", label: "refs: all" });
  if (filters.refScope === "pattern" && trimmed(filters.refPattern)) {
    chips.push({ key: "refPattern", label: `refs: ${filters.refPattern.trim()}` });
  }
  if (trimmed(filters.path)) chips.push({ key: "path", label: `path: ${filters.path.trim()}` });
  if (trimmed(filters.author)) chips.push({ key: "author", label: `author: ${filters.author.trim()}` });
  if (trimmed(filters.grep)) chips.push({ key: "grep", label: `msg: ${filters.grep.trim()}` });
  if (trimmed(filters.since)) chips.push({ key: "since", label: `since: ${filters.since.trim()}` });
  if (trimmed(filters.until)) chips.push({ key: "until", label: `until: ${filters.until.trim()}` });
  return chips;
};

/** Whether any constraint narrows the default head window (drives the no-match empty state, P1-FILT-9). */
export const hasActiveFilters = (filters: LogFilters): boolean => describeFilters(filters).length > 0;

/** Clear one filter field back to its default (chip removal, P1-FILT-6). */
export const clearFilter = (filters: LogFilters, key: keyof LogFilters): LogFilters => {
  if (key === "refScope" || key === "refPattern") {
    return { ...filters, refScope: "current", refPattern: "" };
  }
  return { ...filters, [key]: "" };
};
