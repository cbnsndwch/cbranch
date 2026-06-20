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
  type BranchInfo,
  type BranchListing,
  type BranchSwitchStrategy,
  type CommitCreated,
  type CommitDetail,
  type CommitInput,
  type CommitMessage,
  type DiffFile,
  type FileContentResult,
  type GitError,
  type InvalidationEvent,
  type LogQuery,
  type MergeMode,
  type MergeResult,
  type Oid,
  type PatchSelection,
  type RecentRepo,
  type RemoteInfo,
  type RepoHandle,
  type RepoId,
  type RepoState,
  type CommitSummary,
  type DiffSpec,
  type StashEntry,
  type SyncEvent,
  type TagInfo,
  type TagType,
  type WorkingTreeStatus,
  type WorktreeInfo,
} from "@cbranch/rpc-contract";
import { Context, type Effect, type Stream } from "effect";

import { type ObjectData, type ObjectInfo } from "../git/cat-file-pool";

/**
 * The full P1+P2+P3 `GitEngine` surface. The first block is the RPC method catalog
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
  readonly subscribe: (
    repoId: RepoId,
  ) => Stream.Stream<InvalidationEvent, GitError>;

  // ── history & diff (P1, core-B) ────────────────────────────────────────────
  /** log.stream — the single streaming history feed. core-B. */
  readonly logStream: (
    query: LogQuery,
  ) => Stream.Stream<CommitSummary, GitError>;
  /** commit.detail — full commit object + stats. core-B. */
  readonly commitDetail: (
    repoId: RepoId,
    oid: Oid,
  ) => Effect.Effect<CommitDetail, GitError>;
  /** commit.diff — changed files for a commit/range. core-B. */
  readonly commitDiff: (
    spec: DiffSpec,
  ) => Effect.Effect<ReadonlyArray<DiffFile>, GitError>;
  /** diff.workingFile — working-tree/index diff for one path. core-B (P2 surface). */
  readonly diffWorkingFile: (
    repoId: RepoId,
    path: string,
    staged: boolean,
  ) => Effect.Effect<DiffFile, GitError>;
  /** file.contentAtRev — inline content or a download descriptor. core-B. */
  readonly fileContentAtRev: (
    repoId: RepoId,
    path: string,
    rev: string,
  ) => Effect.Effect<FileContentResult, GitError>;

  // ── stage & commit (P2, S1 stubs) ──────────────────────────────────────────
  /** status.get — full working-tree status snapshot (porcelain v2). READ. core-S2. */
  readonly statusGet: (
    repoId: RepoId,
    includeIgnored?: boolean,
  ) => Effect.Effect<WorkingTreeStatus, GitError>;
  /** stage.files ✎ — stage whole files (or `all` = `git add -A`). core-S3. */
  readonly stageFiles: (
    repoId: RepoId,
    paths: ReadonlyArray<string>,
    all?: boolean,
  ) => Effect.Effect<void, GitError>;
  /** unstage.files ✎ — unstage whole files (or `all` = `git reset`). core-S3. */
  readonly unstageFiles: (
    repoId: RepoId,
    paths: ReadonlyArray<string>,
    all?: boolean,
  ) => Effect.Effect<void, GitError>;
  /** discard.files ✎ — restore tracked files in the worktree. core-S3. */
  readonly discardFiles: (
    repoId: RepoId,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<void, GitError>;
  /** deleteUntracked ✎ — remove untracked files (`git clean -f`). core-S3. */
  readonly deleteUntracked: (
    repoId: RepoId,
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<void, GitError>;
  /** reset.to ✎ — `git reset --<mode> <target>`. core-S3. */
  readonly resetTo: (
    repoId: RepoId,
    mode: "soft" | "mixed" | "hard",
    target: string,
  ) => Effect.Effect<void, GitError>;
  /** stage.hunks ✎ — partial stage from a structured selection. core-S4. */
  readonly stageHunks: (
    selection: PatchSelection,
  ) => Effect.Effect<void, GitError>;
  /** unstage.hunks ✎ — partial unstage from a structured selection. core-S4. */
  readonly unstageHunks: (
    selection: PatchSelection,
  ) => Effect.Effect<void, GitError>;
  /** discard.hunks ✎ — partial worktree discard from a structured selection. core-S4. */
  readonly discardHunks: (
    selection: PatchSelection,
  ) => Effect.Effect<void, GitError>;
  /** commit.create ✎ — `git commit -F -` with optional amend/signoff/sign/author. core-S5. */
  readonly commitCreate: (
    input: CommitInput,
  ) => Effect.Effect<CommitCreated, GitError>;
  /** commit.lastMessage — the last commit's split message (reuse/amend seed). READ. core-S5. */
  readonly commitLastMessage: (
    repoId: RepoId,
  ) => Effect.Effect<CommitMessage, GitError>;

  // ── branches (P3) ──────────────────────────────────────────────────────────
  /** branch.list — all local + remote-tracking branches with upstream/ahead-behind. */
  readonly branchList: (
    repoId: RepoId,
  ) => Effect.Effect<BranchListing, GitError>;
  /** branch.create ✎ */
  readonly branchCreate: (
    repoId: RepoId,
    name: string,
    startPoint?: string,
    setUpstream?: boolean,
    switchAfter?: boolean,
  ) => Effect.Effect<BranchInfo, GitError>;
  /** branch.switch ✎ */
  readonly branchSwitch: (
    repoId: RepoId,
    target: string,
    strategy?: BranchSwitchStrategy,
    stashAndReapply?: boolean,
  ) => Effect.Effect<void, GitError>;
  /** branch.rename ✎ */
  readonly branchRename: (
    repoId: RepoId,
    oldName: string,
    newName: string,
  ) => Effect.Effect<void, GitError>;
  /** branch.delete ✎ — force=false = safe; force=true = -D after user confirm. */
  readonly branchDelete: (
    repoId: RepoId,
    name: string,
    force: boolean,
  ) => Effect.Effect<void, GitError>;
  /** branch.setUpstream ✎ — upstream=undefined = unset. */
  readonly branchSetUpstream: (
    repoId: RepoId,
    name: string,
    upstream?: string,
  ) => Effect.Effect<void, GitError>;

  // ── merge (P3) ─────────────────────────────────────────────────────────────
  /** merge.create ✎ */
  readonly mergeCreate: (
    repoId: RepoId,
    ref: string,
    strategy: MergeMode,
    message?: string,
  ) => Effect.Effect<MergeResult, GitError>;
  /** merge.abort ✎ */
  readonly mergeAbort: (repoId: RepoId) => Effect.Effect<void, GitError>;

  // ── sync (P3) ──────────────────────────────────────────────────────────────
  /** fetch.stream — read-only; streams SyncEvent progress + refUpdates. */
  readonly fetchStream: (
    repoId: RepoId,
    remote?: string,
    all?: boolean,
    prune?: boolean,
    tags?: boolean,
  ) => Stream.Stream<SyncEvent, GitError>;
  /** pull.stream ✎ */
  readonly pullStream: (
    repoId: RepoId,
    mode: "ff-only" | "rebase" | "merge",
    autostash?: boolean,
  ) => Stream.Stream<SyncEvent, GitError>;
  /** push.stream ✎ */
  readonly pushStream: (
    repoId: RepoId,
    remote: string,
    branch?: string,
    setUpstream?: boolean,
    forceWithLease?: boolean,
    tags?: boolean,
  ) => Stream.Stream<SyncEvent, GitError>;
  /** push.deleteRemoteRef ✎ — non-streaming delete of a remote branch or tag ref. */
  readonly pushDeleteRemoteRef: (
    repoId: RepoId,
    remote: string,
    ref: string,
    refType: "branch" | "tag",
  ) => Effect.Effect<void, GitError>;

  // ── remotes (P3) ───────────────────────────────────────────────────────────
  /** remote.list */
  readonly remoteList: (
    repoId: RepoId,
  ) => Effect.Effect<ReadonlyArray<RemoteInfo>, GitError>;
  /** remote.add ✎ */
  readonly remoteAdd: (
    repoId: RepoId,
    name: string,
    url: string,
  ) => Effect.Effect<void, GitError>;
  /** remote.setUrl ✎ */
  readonly remoteSetUrl: (
    repoId: RepoId,
    name: string,
    url: string,
    push?: boolean,
  ) => Effect.Effect<void, GitError>;
  /** remote.rename ✎ */
  readonly remoteRename: (
    repoId: RepoId,
    oldName: string,
    newName: string,
  ) => Effect.Effect<void, GitError>;
  /** remote.remove ✎ */
  readonly remoteRemove: (
    repoId: RepoId,
    name: string,
  ) => Effect.Effect<void, GitError>;

  // ── worktrees (P3) ─────────────────────────────────────────────────────────
  /** worktree.list */
  readonly worktreeList: (
    repoId: RepoId,
  ) => Effect.Effect<ReadonlyArray<WorktreeInfo>, GitError>;
  /** worktree.add ✎ */
  readonly worktreeAdd: (
    repoId: RepoId,
    path: string,
    branch?: string,
    newBranch?: string,
    startPoint?: string,
  ) => Effect.Effect<WorktreeInfo, GitError>;
  /** worktree.remove ✎ */
  readonly worktreeRemove: (
    repoId: RepoId,
    path: string,
    force?: boolean,
  ) => Effect.Effect<void, GitError>;
  /** worktree.prune ✎ */
  readonly worktreePrune: (repoId: RepoId) => Effect.Effect<void, GitError>;

  // ── stash (P3) ─────────────────────────────────────────────────────────────
  /** stash.push ✎ */
  readonly stashPush: (
    repoId: RepoId,
    message?: string,
    includeUntracked?: boolean,
    keepIndex?: boolean,
    stagedOnly?: boolean,
  ) => Effect.Effect<StashEntry, GitError>;
  /** stash.list */
  readonly stashList: (
    repoId: RepoId,
  ) => Effect.Effect<ReadonlyArray<StashEntry>, GitError>;
  /** stash.show */
  readonly stashShow: (
    repoId: RepoId,
    ref: string,
  ) => Effect.Effect<ReadonlyArray<DiffFile>, GitError>;
  /** stash.apply ✎ */
  readonly stashApply: (
    repoId: RepoId,
    ref: string,
  ) => Effect.Effect<void, GitError>;
  /** stash.pop ✎ */
  readonly stashPop: (
    repoId: RepoId,
    ref: string,
  ) => Effect.Effect<void, GitError>;
  /** stash.drop ✎ */
  readonly stashDrop: (
    repoId: RepoId,
    ref: string,
  ) => Effect.Effect<void, GitError>;
  /** stash.clear ✎ */
  readonly stashClear: (repoId: RepoId) => Effect.Effect<void, GitError>;

  // ── tags (P3) ──────────────────────────────────────────────────────────────
  /** tag.list */
  readonly tagList: (
    repoId: RepoId,
  ) => Effect.Effect<ReadonlyArray<TagInfo>, GitError>;
  /** tag.create ✎ */
  readonly tagCreate: (
    repoId: RepoId,
    name: string,
    target?: string,
    tagType?: TagType,
    message?: string,
    force?: boolean,
  ) => Effect.Effect<TagInfo, GitError>;
  /** tag.delete ✎ */
  readonly tagDelete: (
    repoId: RepoId,
    name: string,
  ) => Effect.Effect<void, GitError>;
  /** tag.push ✎ */
  readonly tagPush: (
    repoId: RepoId,
    remote: string,
    name?: string,
    all?: boolean,
  ) => Effect.Effect<void, GitError>;
  /** tag.deleteRemote ✎ */
  readonly tagDeleteRemote: (
    repoId: RepoId,
    remote: string,
    name: string,
  ) => Effect.Effect<void, GitError>;

  // ── object-read infrastructure (internal; for core-B) ──────────────────────
  /** Read a full object via the repo's `cat-file --batch` pool (`null` if missing). */
  readonly readObject: (
    repoId: RepoId,
    rev: string,
  ) => Effect.Effect<ObjectData | null, GitError>;
  /** Read object metadata via the repo's `cat-file --batch-check` pool. */
  readonly objectInfo: (
    repoId: RepoId,
    rev: string,
  ) => Effect.Effect<ObjectInfo | null, GitError>;
}

/** The `GitEngine` context service key. Yield it to obtain a {@link GitEngineApi}. */
export class GitEngine extends Context.Service<GitEngine, GitEngineApi>()(
  "GitEngine",
) {}
