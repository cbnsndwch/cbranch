// The `GitEngine` service (docs/spec/02 REQ-ARCH-010..014).
//
// The single, transport-agnostic entry point for ALL Git behavior. Every RPC handler
// in apps/web-server calls THROUGH this service and never invokes git directly. It is
// an Effect `Context` service; methods return `Effect`/`Stream` of the
// `@cbranch/rpc-contract` types and fail with the canonical `GitError` (REQ-ARCH-014).
// Internal invocation choices (the `cat-file --batch` pool, `--no-optional-locks`,
// the per-repo lock) are invisible to callers (REQ-ARCH-013).
//
// core-A implements `open`/`recentList`/`recentRemove`/`state` and the object-read
// infra; the history/diff/content/subscribe methods are typed here and left as
// core-B stubs so the interface is COMPLETE and core-B only fills bodies.

import {
  type CommitDetail,
  type DiffFile,
  type FileContentResult,
  type GitError,
  type InvalidationEvent,
  type LogQuery,
  type Oid,
  type RecentRepo,
  type RepoHandle,
  type RepoId,
  type RepoState,
  type CommitSummary,
  type DiffSpec,
} from "@cbranch/rpc-contract";
import { Context, type Effect, type Stream } from "effect";

import { type ObjectData, type ObjectInfo } from "../git/cat-file-pool";

/**
 * The full P1 `GitEngine` surface. The first block is the RPC method catalog
 * (`14 §7`); the trailing `readObject`/`objectInfo` are internal object-read infra
 * exposed for core-B (not part of the RPC surface).
 */
export interface GitEngineApi {
  // ── repository & live state (P1, core-A) ───────────────────────────────────
  /** repo.open — resolve identity + state, upsert recent list. */
  readonly open: (path: string) => Effect.Effect<RepoHandle, GitError>;
  /** repo.recentList — the persisted recent-repos list. */
  readonly recentList: () => Effect.Effect<ReadonlyArray<RecentRepo>, GitError>;
  /** repo.recentRemove — drop an entry from the recent list. */
  readonly recentRemove: (repoId: RepoId) => Effect.Effect<void, GitError>;
  /** repo.state — HEAD/branch/detached/in-progress/empty/bare snapshot. */
  readonly state: (repoId: RepoId) => Effect.Effect<RepoState, GitError>;

  // ── repository & live state (P1, core-B watcher) ───────────────────────────
  /** repo.subscribe — fs-watcher invalidation bus (chokidar). core-B. */
  readonly subscribe: (repoId: RepoId) => Stream.Stream<InvalidationEvent, GitError>;

  // ── history & diff (P1, core-B) ────────────────────────────────────────────
  /** log.stream — the single streaming history feed. core-B. */
  readonly logStream: (query: LogQuery) => Stream.Stream<CommitSummary, GitError>;
  /** commit.detail — full commit object + stats. core-B. */
  readonly commitDetail: (repoId: RepoId, oid: Oid) => Effect.Effect<CommitDetail, GitError>;
  /** commit.diff — changed files for a commit/range. core-B. */
  readonly commitDiff: (spec: DiffSpec) => Effect.Effect<ReadonlyArray<DiffFile>, GitError>;
  /** diff.workingFile — working-tree/index diff for one path. core-B (P2 surface). */
  readonly diffWorkingFile: (repoId: RepoId, path: string, staged: boolean) => Effect.Effect<DiffFile, GitError>;
  /** file.contentAtRev — inline content or a download descriptor. core-B. */
  readonly fileContentAtRev: (repoId: RepoId, path: string, rev: string) => Effect.Effect<FileContentResult, GitError>;

  // ── object-read infrastructure (internal; for core-B) ──────────────────────
  /** Read a full object via the repo's `cat-file --batch` pool (`null` if missing). */
  readonly readObject: (repoId: RepoId, rev: string) => Effect.Effect<ObjectData | null, GitError>;
  /** Read object metadata via the repo's `cat-file --batch-check` pool. */
  readonly objectInfo: (repoId: RepoId, rev: string) => Effect.Effect<ObjectInfo | null, GitError>;
}

/** The `GitEngine` context service key. Yield it to obtain a {@link GitEngineApi}. */
export class GitEngine extends Context.Service<GitEngine, GitEngineApi>()("GitEngine") {}
