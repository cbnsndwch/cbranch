// React Query key convention (docs/spec/15 §2; DECISIONS D9).
//
// Synced data is owned solely by React Query, keyed `[repoId, domain, ...params]` so the
// WebSocket invalidation bus can map a changed `Domain` to the queries to refetch with a
// single `invalidateQueries({ queryKey: [repoId, domain] })`. Immutable, content-addressed
// reads (a commit's detail/diff, a blob at a fixed rev) live under non-domain prefixes and
// are NEVER invalidated (spec 15 §8). On reconnect the whole `[repoId]` subtree is
// invalidated (spec 15 §5 / NF-ERR-6).

import {
  type DiffSpec,
  type Domain,
  type LogQuery,
  type Oid,
  type RepoId,
} from "@cbranch/rpc-contract";

/** Everything for a repo — the reconnect "resnapshot" invalidation target (spec 15 §5). */
export const repoScopeKey = (repoId: RepoId) => [repoId] as const;

/** The invalidation target for a changed domain (spec 15 §2). */
export const domainKey = (repoId: RepoId, domain: Domain) =>
  [repoId, domain] as const;

/** Query keys for the P1 read surface. Synced reads sit under a `Domain`; immutable reads don't. */
export const queryKeys = {
  /** `repo.state` — HEAD/branch/in-progress snapshot (domain: `inProgress`). */
  repoState: (repoId: RepoId) => [repoId, "inProgress", "state"] as const,
  /** Head window of the streaming history feed (domain: `commits`); keyed by the full query. */
  log: (query: LogQuery) => [query.repoId, "commits", "log", query] as const,
  /** `commit.detail` — immutable, content-addressed by oid (never invalidated). */
  commitDetail: (repoId: RepoId, oid: Oid) =>
    [repoId, "commit", oid, "detail"] as const,
  /**
   * `commit.diff` — immutable, content-addressed by target plus the options that change the
   * computed patch (base/whitespace/context/combined/paths), so toggling a control caches
   * independently. `paths` distinguishes a path-scoped diff (file history's "view diff",
   * REQ-FH-003) from the whole-commit diff of the same target. Never invalidated (spec 15 §8).
   */
  commitDiff: (spec: DiffSpec) =>
    [
      spec.repoId,
      "commit",
      spec.target,
      "diff",
      {
        base: spec.base ?? "^1",
        whitespace: spec.whitespace,
        context: spec.context,
        combined: spec.combined,
        paths: spec.paths,
      },
    ] as const,
  /** `file.contentAtRev` — immutable blob at a fixed rev (never invalidated). */
  fileContentAtRev: (repoId: RepoId, rev: string, path: string) =>
    [repoId, "blob", rev, path] as const,
  /** `repo.recentList` — the persisted switcher list (not repo-scoped). */
  recentList: () => ["recent"] as const,
  /** `status.get` — the working-tree status tree (domain: `status`). */
  status: (repoId: RepoId) => [repoId, "status", "tree"] as const,
  /**
   * `diff.workingFile` — one file's working/index diff, keyed by `staged` side so a
   * mixed-state file caches each side independently (under the `status` domain →
   * REQ-P2-HUNK-003).
   */
  workingDiff: (repoId: RepoId, path: string, staged: boolean) =>
    [repoId, "status", "diff", path, staged] as const,
  /** `commit.lastMessage` — the last commit's message, for reuse/amend (domain: `commit`). */
  lastMessage: (repoId: RepoId) => [repoId, "commit", "lastMessage"] as const,
  /** `branch.list` (domain: `refs`). */
  branches: (repoId: RepoId) => [repoId, "refs", "branches"] as const,
  /**
   * `reflog.list` — paginated reflog for a ref (domain: `refs`; every reflog append
   * co-occurs with a watched ref-tip move). `useInfiniteQuery`, cursor-paged.
   */
  reflog: (repoId: RepoId, ref: string) =>
    [repoId, "refs", "reflog", ref] as const,
  /**
   * `bisect.status` — machine-derived session status (domain: `inProgress`). Stays enabled
   * so a pre-existing session shows on repo open (cheap `existsSync` fast-path, REQ-P5-BS-006).
   */
  bisect: (repoId: RepoId) => [repoId, "inProgress", "bisect"] as const,
  /**
   * `rebase.plan` — the computed `<upstream>..HEAD` range for the todo editor (domain:
   * `commits`; re-derived per chosen base/onto). REQ-P5-IR-002.
   */
  rebasePlan: (repoId: RepoId, upstream: string, onto?: string) =>
    [repoId, "commits", "rebasePlan", upstream, onto ?? ""] as const,
  /**
   * `rebase.status` — machine-derived in-progress status (domain: `inProgress`). Stays
   * enabled so a pre-existing rebase shows on repo open (REQ-P5-IR-011).
   */
  rebaseStatus: (repoId: RepoId) =>
    [repoId, "inProgress", "rebaseStatus"] as const,
  /** `remote.list` (domain: `config`). */
  remotes: (repoId: RepoId) => [repoId, "config", "remotes"] as const,
  /**
   * `config.list` — every on-disk git config entry (domain: `config`). The SOLE refresh
   * for global/system writes invisible to the fs watcher → `onSettled` invalidates it
   * (REQ-P5-CFG-008).
   */
  gitConfig: (repoId: RepoId) => [repoId, "config", "gitConfig"] as const,
  /** `config.appGet` — cbranch app settings (NOT repo-scoped; never domain-invalidated, like `recentList`). */
  appSettings: () => ["appSettings"] as const,
  /** `worktree.list` (domain: `worktrees`). */
  worktrees: (repoId: RepoId) => [repoId, "worktrees", "list"] as const,
  /**
   * `submodule.list` — index-cross-read listing (domain: `status`; a submodule's
   * checkout/init/conflict state moves with the superproject index/worktree). REQ-P5-SM-001.
   */
  submodules: (repoId: RepoId) => [repoId, "status", "submodules"] as const,
  /** `stash.list` (domain: `stash`). */
  stash: (repoId: RepoId) => [repoId, "stash", "list"] as const,
  /** `stash.show` — immutable once the stash entry is dropped. */
  stashShow: (repoId: RepoId, ref: string) =>
    [repoId, "stash", ref, "diff"] as const,
  /** `tag.list` (domain: `tags`). */
  tags: (repoId: RepoId) => [repoId, "tags", "list"] as const,
  /**
   * `clean.preview` — dry-run would-remove list, keyed by the option toggles so changing
   * an option invalidates the stale preview (domain: `status`; REQ-P5-CL-002). The query
   * is `enabled` only once the user requests a Preview.
   */
  cleanPreview: (repoId: RepoId, directories: boolean, ignored: boolean) =>
    [repoId, "status", "clean", directories, ignored] as const,
  /**
   * `conflict.list` — in-progress op + conflicted paths (domain: `status`; every
   * conflict mutation touches the index). Drives the banner + panel.
   */
  conflicts: (repoId: RepoId) => [repoId, "status", "conflicts"] as const,
  /** `conflict.sides` — one path's three sides + merged seed (domain: `status`). */
  conflictSides: (repoId: RepoId, path: string) =>
    [repoId, "status", "conflict", path, "sides"] as const,
  /**
   * `blame` — immutable, content-addressed by a concrete rev (never invalidated;
   * spec 15 §8). The caller resolves a default HEAD to a concrete oid for caching.
   */
  blame: (repoId: RepoId, rev: string, path: string) =>
    [repoId, "blame", rev, path] as const,
  /**
   * `file.history` — single-path revision list, paginated. A walk pinned to a concrete
   * `startRev` is immutable (it only ever walks that commit's ancestors), so — like `blame`
   * and `commitDiff` — it lives under a non-domain prefix and is NEVER invalidated (spec 15
   * §8): a background commit can't change it, so refetching every loaded page on each
   * `commits` event would be pure waste. The tip case (no `startRev`) tracks the branch head,
   * so it stays under the `commits` domain to refresh when new commits land.
   */
  fileHistory: (repoId: RepoId, path: string, startRev?: string) =>
    startRev
      ? ([repoId, "fileHistory", path, startRev] as const)
      : ([repoId, "commits", "fileHistory", path] as const),
};
