// Promise/subscription facade over the Effect RPC client (docs/spec/14; NF-TEST-7).
//
// Components and React Query never touch Effect directly — they depend on this small
// `CbranchApi` interface: unary methods as Promises, the two streams as
// callback subscriptions returning an unsubscribe. This is the seam component tests
// mock (a hand-written fake `CbranchApi`, no live host — NF-TEST-7), while production
// backs it with the single app runtime. A `GitError` rejects the Promise (driving
// React Query error state); a stream's per-item error reaches `onError`.

import {
  type BranchInfo,
  type BranchListing,
  type BranchSwitchStrategy,
  type CommitCreated,
  type CommitDetail,
  type CommitInput,
  type CommitMessage,
  type CommitSummary,
  type DiffFile,
  type DiffSpec,
  type FileContentResult,
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
  type StashEntry,
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
  ): Promise<MergeResult>;
  mergeAbort(repoId: RepoId): Promise<void>;
  // ── sync streaming (P3) ───────────────────────────────────────────────────
  fetchStream(
    repoId: RepoId,
    opts: { remote?: string; all?: boolean; prune?: boolean; tags?: boolean },
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
    opts?: { branch?: string; newBranch?: string; startPoint?: string },
  ): Promise<WorktreeInfo>;
  worktreeRemove(repoId: RepoId, path: string, force?: boolean): Promise<void>;
  worktreePrune(repoId: RepoId): Promise<void>;
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
          c.BranchSwitch({ repoId, target, strategy, stashAndReapply }),
        ),
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
    mergeCreate: (repoId, ref, strategy) =>
      runtime.runPromise(
        withClient((c) => c.MergeCreate({ repoId, ref, strategy })),
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
  };
};
