// React Query key convention (docs/spec/15 §2; DECISIONS D9).
//
// Synced data is owned solely by React Query, keyed `[repoId, domain, ...params]` so the
// WebSocket invalidation bus can map a changed `Domain` to the queries to refetch with a
// single `invalidateQueries({ queryKey: [repoId, domain] })`. Immutable, content-addressed
// reads (a commit's detail/diff, a blob at a fixed rev) live under non-domain prefixes and
// are NEVER invalidated (spec 15 §8). On reconnect the whole `[repoId]` subtree is
// invalidated (spec 15 §5 / NF-ERR-6).

import { type DiffSpec, type Domain, type LogQuery, type Oid, type RepoId } from "@cbranch/rpc-contract";

/** Everything for a repo — the reconnect "resnapshot" invalidation target (spec 15 §5). */
export const repoScopeKey = (repoId: RepoId) => [repoId] as const;

/** The invalidation target for a changed domain (spec 15 §2). */
export const domainKey = (repoId: RepoId, domain: Domain) => [repoId, domain] as const;

/** Query keys for the P1 read surface. Synced reads sit under a `Domain`; immutable reads don't. */
export const queryKeys = {
  /** `repo.state` — HEAD/branch/in-progress snapshot (domain: `inProgress`). */
  repoState: (repoId: RepoId) => [repoId, "inProgress", "state"] as const,
  /** Head window of the streaming history feed (domain: `commits`); keyed by the full query. */
  log: (query: LogQuery) => [query.repoId, "commits", "log", query] as const,
  /** `commit.detail` — immutable, content-addressed by oid (never invalidated). */
  commitDetail: (repoId: RepoId, oid: Oid) => [repoId, "commit", oid, "detail"] as const,
  /**
   * `commit.diff` — immutable, content-addressed by target plus the options that change the
   * computed patch (base/whitespace/context/combined), so toggling a control caches
   * independently. Never invalidated (spec 15 §8).
   */
  commitDiff: (spec: DiffSpec) =>
    [
      spec.repoId,
      "commit",
      spec.target,
      "diff",
      { base: spec.base ?? "^1", whitespace: spec.whitespace, context: spec.context, combined: spec.combined },
    ] as const,
  /** `file.contentAtRev` — immutable blob at a fixed rev (never invalidated). */
  fileContentAtRev: (repoId: RepoId, rev: string, path: string) => [repoId, "blob", rev, path] as const,
  /** `repo.recentList` — the persisted switcher list (not repo-scoped). */
  recentList: () => ["recent"] as const,
};
