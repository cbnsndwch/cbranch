// Promise/subscription facade over the Effect RPC client (docs/spec/14; NF-TEST-7).
//
// Components and React Query never touch Effect directly — they depend on this small
// `CbranchApi` interface: unary methods as Promises, the two streams as
// callback subscriptions returning an unsubscribe. This is the seam component tests
// mock (a hand-written fake `CbranchApi`, no live host — NF-TEST-7), while production
// backs it with the single app runtime. A `GitError` rejects the Promise (driving
// React Query error state); a stream's per-item error reaches `onError`.

import {
  type AppSettings,
  type ArchiveDescriptor,
  type ArchiveFormat,
  type BisectMark,
  type BisectStatus,
  type BlameResult,
  type BranchInfo,
  type BranchListing,
  type BranchSwitchStrategy,
  type CommitCreated,
  type CommitDetail,
  type CleanPreview,
  type CleanResult,
  type CommitInput,
  type CommitMessage,
  type CommitSummary,
  type ConfigScope,
  type ConflictListing,
  type ConflictResolution,
  type ConflictSides,
  type ContentEncoding,
  type DiffFile,
  type DiffSpec,
  type FileContentResult,
  type FileHistoryPage,
  type GcPrune,
  type GcResult,
  type GitConfigEntry,
  type GitConfigValue,
  type InvalidationEvent,
  type KeyBinding,
  type ThemePref,
  type WritableScope,
  type LogQuery,
  type MergeMode,
  type MergeResult,
  type Oid,
  type PatchSelection,
  type RebasePlan,
  type RebaseStatus,
  type RebaseStep,
  type RecentRepo,
  type ReflogPage,
  type RemoteInfo,
  type RepoHandle,
  type RepoId,
  type RepoState,
  type SequencerResult,
  type StashEntry,
  type SubmoduleInfo,
  type SyncEvent,
  type TagInfo,
  type TagType,
  type WorkingTreeStatus,
  type WorktreeInfo,
} from "@cbranch/rpc-contract";
import { Effect, Fiber, Stream } from "effect";

import {
  type AppRuntime,
  type RpcClientService,
  streamWithClient,
  withClient,
} from "./client";

export interface StreamHandlers<A> {
  readonly onItem: (item: A) => void;
  // The stream can fail with the schema `GitError` OR a transport `RpcClientError`,
  // so the callback takes `unknown`; consumers surface it as a toast (NF-ERR-2).
  readonly onError?: (error: unknown) => void;
  readonly onComplete?: () => void;
}

export type Unsubscribe = () => void;

/** The transport-agnostic host API the UI depends on (mockable for component tests). */
export interface CbranchApi {
  repoOpen(path: string): Promise<RepoHandle>;
  recentList(): Promise<ReadonlyArray<RecentRepo>>;
  recentRemove(repoId: RepoId): Promise<void>;
  repoState(repoId: RepoId): Promise<RepoState>;
  commitDetail(repoId: RepoId, oid: Oid): Promise<CommitDetail>;
  commitDiff(spec: DiffSpec): Promise<ReadonlyArray<DiffFile>>;
  workingFileDiff(
    repoId: RepoId,
    path: string,
    staged: boolean,
  ): Promise<DiffFile>;
  fileContentAtRev(
    repoId: RepoId,
    path: string,
    rev: string,
  ): Promise<FileContentResult>;
  // ── stage & commit (P2) ─────────────────────────────────────────────────────
  statusGet(
    repoId: RepoId,
    includeIgnored?: boolean,
  ): Promise<WorkingTreeStatus>;
  stageFiles(
    repoId: RepoId,
    paths: ReadonlyArray<string>,
    all?: boolean,
  ): Promise<void>;
  unstageFiles(
    repoId: RepoId,
    paths: ReadonlyArray<string>,
    all?: boolean,
  ): Promise<void>;
  discardFiles(repoId: RepoId, paths: ReadonlyArray<string>): Promise<void>;
  deleteUntracked(repoId: RepoId, paths: ReadonlyArray<string>): Promise<void>;
  resetTo(
    repoId: RepoId,
    mode: "soft" | "mixed" | "hard",
    target: string,
  ): Promise<void>;
  stageHunks(selection: PatchSelection): Promise<void>;
  unstageHunks(selection: PatchSelection): Promise<void>;
  discardHunks(selection: PatchSelection): Promise<void>;
  commitCreate(input: CommitInput): Promise<CommitCreated>;
  commitLastMessage(repoId: RepoId): Promise<CommitMessage>;
  /** Subscribe to the streaming history feed; returns an unsubscribe (cancels the request). */
  logStream(
    query: LogQuery,
    handlers: StreamHandlers<CommitSummary>,
  ): Unsubscribe;
  /** Subscribe to the WS invalidation bus for a repo; returns an unsubscribe. */
  subscribe(
    repoId: RepoId,
    handlers: StreamHandlers<InvalidationEvent>,
  ): Unsubscribe;
  // ── branches (P3) ─────────────────────────────────────────────────────────
  branchList(repoId: RepoId): Promise<BranchListing>;
  branchCreate(
    repoId: RepoId,
    name: string,
    startPoint?: string,
    setUpstream?: boolean,
    switchAfter?: boolean,
  ): Promise<BranchInfo>;
  branchSwitch(
    repoId: RepoId,
    target: string,
    strategy?: BranchSwitchStrategy,
    stashAndReapply?: boolean,
  ): Promise<void>;
  branchCheckoutDetached(repoId: RepoId, ref: string): Promise<void>;
  branchRename(repoId: RepoId, oldName: string, newName: string): Promise<void>;
  branchDelete(repoId: RepoId, name: string, force: boolean): Promise<void>;
  branchSetUpstream(
    repoId: RepoId,
    name: string,
    upstream?: string,
  ): Promise<void>;
  // ── merge (P3) ────────────────────────────────────────────────────────────
  mergeCreate(
    repoId: RepoId,
    ref: string,
    strategy: MergeMode,
    message?: string,
  ): Promise<MergeResult>;
  mergeAbort(repoId: RepoId): Promise<void>;
  // ── sync streaming (P3) ───────────────────────────────────────────────────
  fetchStream(
    repoId: RepoId,
    opts: {
      remote?: string;
      all?: boolean;
      prune?: boolean;
      tags?: boolean;
    },
    handlers: StreamHandlers<SyncEvent>,
  ): Unsubscribe;
  pullStream(
    repoId: RepoId,
    mode: "ff-only" | "rebase" | "merge",
    opts: { autostash?: boolean },
    handlers: StreamHandlers<SyncEvent>,
  ): Unsubscribe;
  pushStream(
    repoId: RepoId,
    remote: string,
    opts: {
      branch?: string;
      setUpstream?: boolean;
      forceWithLease?: boolean;
      tags?: boolean;
    },
    handlers: StreamHandlers<SyncEvent>,
  ): Unsubscribe;
  pushDeleteRemoteRef(
    repoId: RepoId,
    remote: string,
    ref: string,
    refType: "branch" | "tag",
  ): Promise<void>;
  // ── remotes (P3) ──────────────────────────────────────────────────────────
  remoteList(repoId: RepoId): Promise<ReadonlyArray<RemoteInfo>>;
  remoteAdd(repoId: RepoId, name: string, url: string): Promise<void>;
  remoteSetUrl(
    repoId: RepoId,
    name: string,
    url: string,
    push?: boolean,
  ): Promise<void>;
  remoteRename(repoId: RepoId, oldName: string, newName: string): Promise<void>;
  remoteRemove(repoId: RepoId, name: string): Promise<void>;
  // ── worktrees (P3) ────────────────────────────────────────────────────────
  worktreeList(repoId: RepoId): Promise<ReadonlyArray<WorktreeInfo>>;
  worktreeAdd(
    repoId: RepoId,
    path: string,
    opts?: {
      branch?: string;
      newBranch?: string;
      startPoint?: string;
      force?: boolean;
    },
  ): Promise<WorktreeInfo>;
  worktreeRemove(repoId: RepoId, path: string, force?: boolean): Promise<void>;
  worktreePrune(repoId: RepoId): Promise<void>;
  worktreeSwitch(repoId: RepoId, path: string): Promise<void>;
  // ── stash (P3) ────────────────────────────────────────────────────────────
  stashPush(
    repoId: RepoId,
    opts?: {
      message?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
      stagedOnly?: boolean;
    },
  ): Promise<StashEntry>;
  stashList(repoId: RepoId): Promise<ReadonlyArray<StashEntry>>;
  stashShow(repoId: RepoId, ref: string): Promise<ReadonlyArray<DiffFile>>;
  stashApply(repoId: RepoId, ref: string): Promise<void>;
  stashPop(repoId: RepoId, ref: string): Promise<void>;
  stashDrop(repoId: RepoId, ref: string): Promise<void>;
  stashClear(repoId: RepoId): Promise<void>;
  // ── tags (P3) ─────────────────────────────────────────────────────────────
  tagList(repoId: RepoId): Promise<ReadonlyArray<TagInfo>>;
  tagCreate(
    repoId: RepoId,
    name: string,
    opts: {
      target?: string;
      tagType: TagType;
      message?: string;
      force?: boolean;
    },
  ): Promise<TagInfo>;
  tagDelete(repoId: RepoId, name: string): Promise<void>;
  tagPush(
    repoId: RepoId,
    remote: string,
    opts?: { name?: string; all?: boolean },
  ): Promise<void>;
  tagDeleteRemote(repoId: RepoId, remote: string, name: string): Promise<void>;
  // ── conflicts (P4) ────────────────────────────────────────────────────────
  conflictList(repoId: RepoId): Promise<ConflictListing>;
  conflictSides(repoId: RepoId, path: string): Promise<ConflictSides>;
  conflictResolve(
    repoId: RepoId,
    paths: ReadonlyArray<string>,
    resolution: ConflictResolution,
  ): Promise<void>;
  conflictSaveMerged(
    repoId: RepoId,
    path: string,
    content: string,
    encoding: ContentEncoding,
  ): Promise<void>;
  conflictMarkResolved(
    repoId: RepoId,
    paths: ReadonlyArray<string>,
  ): Promise<void>;
  conflictMarkUnresolved(
    repoId: RepoId,
    paths: ReadonlyArray<string>,
  ): Promise<void>;
  // ── cherry-pick / revert + continuation (P4) ──────────────────────────────
  cherryPick(
    repoId: RepoId,
    commits: ReadonlyArray<Oid>,
    opts?: { recordOrigin?: boolean; mainline?: number; noCommit?: boolean },
  ): Promise<SequencerResult>;
  revert(
    repoId: RepoId,
    commits: ReadonlyArray<Oid>,
    opts?: { mainline?: number; noCommit?: boolean; message?: string },
  ): Promise<SequencerResult>;
  opContinue(
    repoId: RepoId,
    opts?: { message?: string; allowEmpty?: boolean },
  ): Promise<SequencerResult>;
  opAbort(repoId: RepoId): Promise<void>;
  opSkip(repoId: RepoId): Promise<SequencerResult>;
  // ── blame & file history (P4) ─────────────────────────────────────────────
  blame(
    repoId: RepoId,
    path: string,
    opts?: {
      rev?: string;
      startLine?: number;
      endLine?: number;
      force?: boolean;
    },
  ): Promise<BlameResult>;
  fileHistory(
    repoId: RepoId,
    path: string,
    opts: { limit: number; cursor?: string; startRev?: string },
  ): Promise<FileHistoryPage>;
  // ── repository maintenance (P5) ───────────────────────────────────────────
  gc(
    repoId: RepoId,
    opts?: { aggressive?: boolean; prune?: GcPrune },
  ): Promise<GcResult>;
  // ── clean working directory (P5) ──────────────────────────────────────────
  cleanPreview(
    repoId: RepoId,
    directories: boolean,
    ignored: boolean,
  ): Promise<CleanPreview>;
  clean(
    repoId: RepoId,
    paths: ReadonlyArray<string>,
    directories: boolean,
    ignored: boolean,
  ): Promise<CleanResult>;
  // ── archive export (P5) ───────────────────────────────────────────────────
  archivePrepare(
    repoId: RepoId,
    opts: {
      format: ArchiveFormat;
      treeish: string;
      prefix?: string;
      subPath?: string;
    },
  ): Promise<ArchiveDescriptor>;
  // ── reflog viewer (P5) ────────────────────────────────────────────────────
  reflogList(
    repoId: RepoId,
    opts: { ref?: string; limit: number; cursor?: string },
  ): Promise<ReflogPage>;
  // ── bisect (P5) ───────────────────────────────────────────────────────────
  bisectStart(
    repoId: RepoId,
    opts?: { bad?: Oid; good?: ReadonlyArray<Oid> },
  ): Promise<BisectStatus>;
  bisectMark(repoId: RepoId, mark: BisectMark): Promise<BisectStatus>;
  bisectReset(repoId: RepoId): Promise<void>;
  bisectStatus(repoId: RepoId): Promise<BisectStatus>;
  // ── submodules (P5) ───────────────────────────────────────────────────────
  submoduleList(repoId: RepoId): Promise<ReadonlyArray<SubmoduleInfo>>;
  submoduleUpdate(
    repoId: RepoId,
    opts?: {
      paths?: ReadonlyArray<string>;
      init?: boolean;
      recursive?: boolean;
      force?: boolean;
    },
  ): Promise<void>;
  submoduleSync(
    repoId: RepoId,
    opts?: { paths?: ReadonlyArray<string>; recursive?: boolean },
  ): Promise<void>;
  submoduleAdd(
    repoId: RepoId,
    url: string,
    path: string,
    branch?: string,
  ): Promise<void>;
  submoduleRemove(repoId: RepoId, path: string): Promise<void>;
  // ── settings & git config (P5) ──────────────────────────────────────────────
  configList(repoId: RepoId): Promise<ReadonlyArray<GitConfigEntry>>;
  configGet(
    repoId: RepoId,
    key: string,
    scope?: ConfigScope,
  ): Promise<GitConfigValue>;
  configSet(
    repoId: RepoId,
    key: string,
    value: string,
    scope: WritableScope,
  ): Promise<void>;
  configUnset(repoId: RepoId, key: string, scope: WritableScope): Promise<void>;
  appSettingsGet(): Promise<AppSettings>;
  appSettingsSet(patch: {
    theme?: ThemePref;
    locale?: string;
    keybindings?: ReadonlyArray<KeyBinding>;
  }): Promise<AppSettings>;
  // ── interactive rebase (P5) ─────────────────────────────────────────────────
  rebasePlan(
    repoId: RepoId,
    upstream: string,
    opts?: { onto?: string },
  ): Promise<RebasePlan>;
  rebaseStart(
    repoId: RepoId,
    upstream: string,
    steps: ReadonlyArray<RebaseStep>,
    opts?: { onto?: string },
  ): Promise<RebaseStatus>;
  rebaseStatus(repoId: RepoId): Promise<RebaseStatus>;
}

/** Back a {@link CbranchApi} with the single app runtime. */
export const makeApi = (runtime: AppRuntime): CbranchApi => {
  const runStream = <A, E>(
    stream: Stream.Stream<A, E, RpcClientService>,
    handlers: StreamHandlers<A>,
  ): Unsubscribe => {
    const fiber = runtime.runFork(
      stream.pipe(
        Stream.runForEach((item) => Effect.sync(() => handlers.onItem(item))),
        Effect.match({
          onFailure: (error) => handlers.onError?.(error),
          onSuccess: () => handlers.onComplete?.(),
        }),
      ),
    );
    return () => {
      void runtime.runFork(Fiber.interrupt(fiber));
    };
  };

  return {
    repoOpen: (path) =>
      runtime.runPromise(withClient((c) => c.RepoOpen({ path }))),
    recentList: () =>
      runtime.runPromise(withClient((c) => c.RepoRecentList({}))),
    recentRemove: (repoId) =>
      runtime.runPromise(withClient((c) => c.RepoRecentRemove({ repoId }))),
    repoState: (repoId) =>
      runtime.runPromise(withClient((c) => c.RepoState({ repoId }))),
    commitDetail: (repoId, oid) =>
      runtime.runPromise(withClient((c) => c.CommitDetail({ repoId, oid }))),
    commitDiff: (spec) =>
      runtime.runPromise(withClient((c) => c.CommitDiff(spec))),
    workingFileDiff: (repoId, path, staged) =>
      runtime.runPromise(
        withClient((c) => c.DiffWorkingFile({ repoId, path, staged })),
      ),
    fileContentAtRev: (repoId, path, rev) =>
      runtime.runPromise(
        withClient((c) => c.FileContentAtRev({ repoId, path, rev })),
      ),
    statusGet: (repoId, includeIgnored) =>
      runtime.runPromise(
        withClient((c) => c.StatusGet({ repoId, includeIgnored })),
      ),
    stageFiles: (repoId, paths, all) =>
      runtime.runPromise(
        withClient((c) => c.StageFiles({ repoId, paths, all })),
      ),
    unstageFiles: (repoId, paths, all) =>
      runtime.runPromise(
        withClient((c) => c.UnstageFiles({ repoId, paths, all })),
      ),
    discardFiles: (repoId, paths) =>
      runtime.runPromise(withClient((c) => c.DiscardFiles({ repoId, paths }))),
    deleteUntracked: (repoId, paths) =>
      runtime.runPromise(
        withClient((c) => c.DeleteUntracked({ repoId, paths })),
      ),
    resetTo: (repoId, mode, target) =>
      runtime.runPromise(
        withClient((c) => c.ResetTo({ repoId, mode, target })),
      ),
    stageHunks: (selection) =>
      runtime.runPromise(withClient((c) => c.StageHunks(selection))),
    unstageHunks: (selection) =>
      runtime.runPromise(withClient((c) => c.UnstageHunks(selection))),
    discardHunks: (selection) =>
      runtime.runPromise(withClient((c) => c.DiscardHunks(selection))),
    commitCreate: (input) =>
      runtime.runPromise(withClient((c) => c.CommitCreate(input))),
    commitLastMessage: (repoId) =>
      runtime.runPromise(withClient((c) => c.CommitLastMessage({ repoId }))),
    logStream: (query, handlers) =>
      runStream(
        streamWithClient((c) => c.LogStream(query)),
        handlers,
      ),
    subscribe: (repoId, handlers) =>
      runStream(
        streamWithClient((c) => c.RepoSubscribe({ repoId })),
        handlers,
      ),
    // ── branches (P3) ───────────────────────────────────────────────────────
    branchList: (repoId) =>
      runtime.runPromise(withClient((c) => c.BranchList({ repoId }))),
    branchCreate: (repoId, name, startPoint, setUpstream, switchAfter) =>
      runtime.runPromise(
        withClient((c) =>
          c.BranchCreate({
            repoId,
            name,
            startPoint,
            setUpstream,
            switchAfter: switchAfter ?? false,
          }),
        ),
      ),
    branchSwitch: (repoId, target, strategy, stashAndReapply) =>
      runtime.runPromise(
        withClient((c) =>
          c.BranchSwitch({
            repoId,
            target,
            strategy,
            stashAndReapply,
          }),
        ),
      ),
    branchCheckoutDetached: (repoId, ref) =>
      runtime.runPromise(
        withClient((c) => c.BranchCheckoutDetached({ repoId, ref })),
      ),
    branchRename: (repoId, oldName, newName) =>
      runtime.runPromise(
        withClient((c) => c.BranchRename({ repoId, oldName, newName })),
      ),
    branchDelete: (repoId, name, force) =>
      runtime.runPromise(
        withClient((c) => c.BranchDelete({ repoId, name, force })),
      ),
    branchSetUpstream: (repoId, name, upstream) =>
      runtime.runPromise(
        withClient((c) => c.BranchSetUpstream({ repoId, name, upstream })),
      ),
    // ── merge (P3) ──────────────────────────────────────────────────────────
    mergeCreate: (repoId, ref, strategy, message) =>
      runtime.runPromise(
        withClient((c) => c.MergeCreate({ repoId, ref, strategy, message })),
      ),
    mergeAbort: (repoId) =>
      runtime.runPromise(withClient((c) => c.MergeAbort({ repoId }))),
    // ── sync streaming (P3) ─────────────────────────────────────────────────
    fetchStream: (repoId, opts, handlers) =>
      runStream(
        streamWithClient((c) => c.FetchStream({ repoId, ...opts })),
        handlers,
      ),
    pullStream: (repoId, mode, opts, handlers) =>
      runStream(
        streamWithClient((c) => c.PullStream({ repoId, mode, ...opts })),
        handlers,
      ),
    pushStream: (repoId, remote, opts, handlers) =>
      runStream(
        streamWithClient((c) => c.PushStream({ repoId, remote, ...opts })),
        handlers,
      ),
    pushDeleteRemoteRef: (repoId, remote, ref, refType) =>
      runtime.runPromise(
        withClient((c) =>
          c.PushDeleteRemoteRef({ repoId, remote, ref, refType }),
        ),
      ),
    // ── remotes (P3) ────────────────────────────────────────────────────────
    remoteList: (repoId) =>
      runtime.runPromise(withClient((c) => c.RemoteList({ repoId }))),
    remoteAdd: (repoId, name, url) =>
      runtime.runPromise(withClient((c) => c.RemoteAdd({ repoId, name, url }))),
    remoteSetUrl: (repoId, name, url, push) =>
      runtime.runPromise(
        withClient((c) => c.RemoteSetUrl({ repoId, name, url, push })),
      ),
    remoteRename: (repoId, oldName, newName) =>
      runtime.runPromise(
        withClient((c) => c.RemoteRename({ repoId, oldName, newName })),
      ),
    remoteRemove: (repoId, name) =>
      runtime.runPromise(withClient((c) => c.RemoteRemove({ repoId, name }))),
    // ── worktrees (P3) ──────────────────────────────────────────────────────
    worktreeList: (repoId) =>
      runtime.runPromise(withClient((c) => c.WorktreeList({ repoId }))),
    worktreeAdd: (repoId, path, opts) =>
      runtime.runPromise(
        withClient((c) => c.WorktreeAdd({ repoId, path, ...opts })),
      ),
    worktreeRemove: (repoId, path, force) =>
      runtime.runPromise(
        withClient((c) => c.WorktreeRemove({ repoId, path, force })),
      ),
    worktreePrune: (repoId) =>
      runtime.runPromise(withClient((c) => c.WorktreePrune({ repoId }))),
    worktreeSwitch: (repoId, path) =>
      runtime.runPromise(withClient((c) => c.WorktreeSwitch({ repoId, path }))),
    // ── stash (P3) ──────────────────────────────────────────────────────────
    stashPush: (repoId, opts) =>
      runtime.runPromise(withClient((c) => c.StashPush({ repoId, ...opts }))),
    stashList: (repoId) =>
      runtime.runPromise(withClient((c) => c.StashList({ repoId }))),
    stashShow: (repoId, ref) =>
      runtime.runPromise(withClient((c) => c.StashShow({ repoId, ref }))),
    stashApply: (repoId, ref) =>
      runtime.runPromise(withClient((c) => c.StashApply({ repoId, ref }))),
    stashPop: (repoId, ref) =>
      runtime.runPromise(withClient((c) => c.StashPop({ repoId, ref }))),
    stashDrop: (repoId, ref) =>
      runtime.runPromise(withClient((c) => c.StashDrop({ repoId, ref }))),
    stashClear: (repoId) =>
      runtime.runPromise(withClient((c) => c.StashClear({ repoId }))),
    // ── tags (P3) ───────────────────────────────────────────────────────────
    tagList: (repoId) =>
      runtime.runPromise(withClient((c) => c.TagList({ repoId }))),
    tagCreate: (repoId, name, opts) =>
      runtime.runPromise(
        withClient((c) => c.TagCreate({ repoId, name, ...opts })),
      ),
    tagDelete: (repoId, name) =>
      runtime.runPromise(withClient((c) => c.TagDelete({ repoId, name }))),
    tagPush: (repoId, remote, opts) =>
      runtime.runPromise(
        withClient((c) => c.TagPush({ repoId, remote, ...opts })),
      ),
    tagDeleteRemote: (repoId, remote, name) =>
      runtime.runPromise(
        withClient((c) => c.TagDeleteRemote({ repoId, remote, name })),
      ),
    // ── conflicts (P4) ────────────────────────────────────────────────────────
    conflictList: (repoId) =>
      runtime.runPromise(withClient((c) => c.ConflictList({ repoId }))),
    conflictSides: (repoId, path) =>
      runtime.runPromise(withClient((c) => c.ConflictSides({ repoId, path }))),
    conflictResolve: (repoId, paths, resolution) =>
      runtime.runPromise(
        withClient((c) => c.ConflictResolve({ repoId, paths, resolution })),
      ),
    conflictSaveMerged: (repoId, path, content, encoding) =>
      runtime.runPromise(
        withClient((c) =>
          c.ConflictSaveMerged({ repoId, path, content, encoding }),
        ),
      ),
    conflictMarkResolved: (repoId, paths) =>
      runtime.runPromise(
        withClient((c) => c.ConflictMarkResolved({ repoId, paths })),
      ),
    conflictMarkUnresolved: (repoId, paths) =>
      runtime.runPromise(
        withClient((c) => c.ConflictMarkUnresolved({ repoId, paths })),
      ),
    // ── cherry-pick / revert + continuation (P4) ──────────────────────────────
    cherryPick: (repoId, commits, opts) =>
      runtime.runPromise(
        withClient((c) => c.CherryPick({ repoId, commits, ...opts })),
      ),
    revert: (repoId, commits, opts) =>
      runtime.runPromise(
        withClient((c) => c.Revert({ repoId, commits, ...opts })),
      ),
    opContinue: (repoId, opts) =>
      runtime.runPromise(withClient((c) => c.OpContinue({ repoId, ...opts }))),
    opAbort: (repoId) =>
      runtime.runPromise(withClient((c) => c.OpAbort({ repoId }))),
    opSkip: (repoId) =>
      runtime.runPromise(withClient((c) => c.OpSkip({ repoId }))),
    // ── blame & file history (P4) ─────────────────────────────────────────────
    blame: (repoId, path, opts) =>
      runtime.runPromise(withClient((c) => c.Blame({ repoId, path, ...opts }))),
    fileHistory: (repoId, path, opts) =>
      runtime.runPromise(
        withClient((c) => c.FileHistory({ repoId, path, ...opts })),
      ),
    // ── repository maintenance (P5) ─────────────────────────────────────────
    gc: (repoId, opts) =>
      runtime.runPromise(withClient((c) => c.RepoGc({ repoId, ...opts }))),
    // ── clean working directory (P5) ────────────────────────────────────────
    cleanPreview: (repoId, directories, ignored) =>
      runtime.runPromise(
        withClient((c) => c.CleanPreview({ repoId, directories, ignored })),
      ),
    clean: (repoId, paths, directories, ignored) =>
      runtime.runPromise(
        withClient((c) => c.Clean({ repoId, paths, directories, ignored })),
      ),
    // ── archive export (P5) ─────────────────────────────────────────────────
    archivePrepare: (repoId, opts) =>
      runtime.runPromise(
        withClient((c) => c.ArchivePrepare({ repoId, ...opts })),
      ),
    // ── reflog viewer (P5) ──────────────────────────────────────────────────
    reflogList: (repoId, opts) =>
      runtime.runPromise(withClient((c) => c.ReflogList({ repoId, ...opts }))),
    // ── bisect (P5) ─────────────────────────────────────────────────────────
    bisectStart: (repoId, opts) =>
      runtime.runPromise(withClient((c) => c.BisectStart({ repoId, ...opts }))),
    bisectMark: (repoId, mark) =>
      runtime.runPromise(withClient((c) => c.BisectMark({ repoId, mark }))),
    bisectReset: (repoId) =>
      runtime.runPromise(withClient((c) => c.BisectReset({ repoId }))),
    bisectStatus: (repoId) =>
      runtime.runPromise(withClient((c) => c.BisectStatus({ repoId }))),
    // ── submodules (P5) ───────────────────────────────────────────────────────
    submoduleList: (repoId) =>
      runtime.runPromise(withClient((c) => c.SubmoduleList({ repoId }))),
    submoduleUpdate: (repoId, opts) =>
      runtime.runPromise(
        withClient((c) => c.SubmoduleUpdate({ repoId, ...opts })),
      ),
    submoduleSync: (repoId, opts) =>
      runtime.runPromise(
        withClient((c) => c.SubmoduleSync({ repoId, ...opts })),
      ),
    submoduleAdd: (repoId, url, path, branch) =>
      runtime.runPromise(
        withClient((c) => c.SubmoduleAdd({ repoId, url, path, branch })),
      ),
    submoduleRemove: (repoId, path) =>
      runtime.runPromise(
        withClient((c) => c.SubmoduleRemove({ repoId, path })),
      ),
    // ── settings & git config (P5) ──────────────────────────────────────────────
    configList: (repoId) =>
      runtime.runPromise(withClient((c) => c.ConfigList({ repoId }))),
    configGet: (repoId, key, scope) =>
      runtime.runPromise(
        withClient((c) => c.ConfigGet({ repoId, key, scope })),
      ),
    configSet: (repoId, key, value, scope) =>
      runtime.runPromise(
        withClient((c) => c.ConfigSet({ repoId, key, value, scope })),
      ),
    configUnset: (repoId, key, scope) =>
      runtime.runPromise(
        withClient((c) => c.ConfigUnset({ repoId, key, scope })),
      ),
    appSettingsGet: () =>
      runtime.runPromise(withClient((c) => c.ConfigAppGet({}))),
    appSettingsSet: (patch) =>
      runtime.runPromise(withClient((c) => c.ConfigAppSet(patch))),
    // ── interactive rebase (P5) ─────────────────────────────────────────────────
    rebasePlan: (repoId, upstream, opts) =>
      runtime.runPromise(
        withClient((c) => c.RebasePlan({ repoId, upstream, ...opts })),
      ),
    rebaseStart: (repoId, upstream, steps, opts) =>
      runtime.runPromise(
        withClient((c) => c.RebaseStart({ repoId, upstream, steps, ...opts })),
      ),
    rebaseStatus: (repoId) =>
      runtime.runPromise(withClient((c) => c.RebaseStatus({ repoId }))),
  };
};
