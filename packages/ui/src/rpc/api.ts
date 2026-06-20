// Promise/subscription facade over the Effect RPC client (docs/spec/14; NF-TEST-7).
//
// Components and React Query never touch Effect directly — they depend on this small
// `CbranchApi` interface: unary methods as Promises, the two streams as
// callback subscriptions returning an unsubscribe. This is the seam component tests
// mock (a hand-written fake `CbranchApi`, no live host — NF-TEST-7), while production
// backs it with the single app runtime. A `GitError` rejects the Promise (driving
// React Query error state); a stream's per-item error reaches `onError`.

import {
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
  type Oid,
  type PatchSelection,
  type RecentRepo,
  type RepoHandle,
  type RepoId,
  type RepoState,
  type WorkingTreeStatus,
} from "@cbranch/rpc-contract";
import { Effect, Fiber, Stream } from "effect";

import { type AppRuntime, type RpcClientService, streamWithClient, withClient } from "./client";

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
  workingFileDiff(repoId: RepoId, path: string, staged: boolean): Promise<DiffFile>;
  fileContentAtRev(repoId: RepoId, path: string, rev: string): Promise<FileContentResult>;
  // ── stage & commit (P2) ─────────────────────────────────────────────────────
  statusGet(repoId: RepoId, includeIgnored?: boolean): Promise<WorkingTreeStatus>;
  stageFiles(repoId: RepoId, paths: ReadonlyArray<string>, all?: boolean): Promise<void>;
  unstageFiles(repoId: RepoId, paths: ReadonlyArray<string>, all?: boolean): Promise<void>;
  discardFiles(repoId: RepoId, paths: ReadonlyArray<string>): Promise<void>;
  deleteUntracked(repoId: RepoId, paths: ReadonlyArray<string>): Promise<void>;
  resetTo(repoId: RepoId, mode: "soft" | "mixed" | "hard", target: string): Promise<void>;
  stageHunks(selection: PatchSelection): Promise<void>;
  unstageHunks(selection: PatchSelection): Promise<void>;
  discardHunks(selection: PatchSelection): Promise<void>;
  commitCreate(input: CommitInput): Promise<CommitCreated>;
  commitLastMessage(repoId: RepoId): Promise<CommitMessage>;
  /** Subscribe to the streaming history feed; returns an unsubscribe (cancels the request). */
  logStream(query: LogQuery, handlers: StreamHandlers<CommitSummary>): Unsubscribe;
  /** Subscribe to the WS invalidation bus for a repo; returns an unsubscribe. */
  subscribe(repoId: RepoId, handlers: StreamHandlers<InvalidationEvent>): Unsubscribe;
}

/** Back a {@link CbranchApi} with the single app runtime. */
export const makeApi = (runtime: AppRuntime): CbranchApi => {
  const runStream = <A, E>(stream: Stream.Stream<A, E, RpcClientService>, handlers: StreamHandlers<A>): Unsubscribe => {
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
    repoOpen: (path) => runtime.runPromise(withClient((c) => c.RepoOpen({ path }))),
    recentList: () => runtime.runPromise(withClient((c) => c.RepoRecentList({}))),
    recentRemove: (repoId) => runtime.runPromise(withClient((c) => c.RepoRecentRemove({ repoId }))),
    repoState: (repoId) => runtime.runPromise(withClient((c) => c.RepoState({ repoId }))),
    commitDetail: (repoId, oid) => runtime.runPromise(withClient((c) => c.CommitDetail({ repoId, oid }))),
    commitDiff: (spec) => runtime.runPromise(withClient((c) => c.CommitDiff(spec))),
    workingFileDiff: (repoId, path, staged) =>
      runtime.runPromise(withClient((c) => c.DiffWorkingFile({ repoId, path, staged }))),
    fileContentAtRev: (repoId, path, rev) =>
      runtime.runPromise(withClient((c) => c.FileContentAtRev({ repoId, path, rev }))),
    statusGet: (repoId, includeIgnored) =>
      runtime.runPromise(withClient((c) => c.StatusGet({ repoId, includeIgnored }))),
    stageFiles: (repoId, paths, all) => runtime.runPromise(withClient((c) => c.StageFiles({ repoId, paths, all }))),
    unstageFiles: (repoId, paths, all) => runtime.runPromise(withClient((c) => c.UnstageFiles({ repoId, paths, all }))),
    discardFiles: (repoId, paths) => runtime.runPromise(withClient((c) => c.DiscardFiles({ repoId, paths }))),
    deleteUntracked: (repoId, paths) => runtime.runPromise(withClient((c) => c.DeleteUntracked({ repoId, paths }))),
    resetTo: (repoId, mode, target) => runtime.runPromise(withClient((c) => c.ResetTo({ repoId, mode, target }))),
    stageHunks: (selection) => runtime.runPromise(withClient((c) => c.StageHunks(selection))),
    unstageHunks: (selection) => runtime.runPromise(withClient((c) => c.UnstageHunks(selection))),
    discardHunks: (selection) => runtime.runPromise(withClient((c) => c.DiscardHunks(selection))),
    commitCreate: (input) => runtime.runPromise(withClient((c) => c.CommitCreate(input))),
    commitLastMessage: (repoId) => runtime.runPromise(withClient((c) => c.CommitLastMessage({ repoId }))),
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
  };
};
