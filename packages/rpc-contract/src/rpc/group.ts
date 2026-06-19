// The P1 method catalog (docs/spec/14-rpc-contract.md §7 — "Repository & live state"
// and "History & diff", both tagged P1).
//
// One `RpcGroup` (the single contract) imported unchanged by both server and client
// (14 §2). On-wire tags are PascalCase (DECISIONS D1); the human/doc `<domain>.<verb>`
// label is kept in a comment on each method. Every error is the canonical `GitError`
// (14 §4). Streaming methods set `stream: true`, which makes the success a stream and
// moves `GitError` to the per-item channel (the top-level error becomes `Never`).
//
// `Rpc`/`RpcGroup` come from the unstable adapter (the ONLY module allowed to import
// `effect/unstable/*` — DECISIONS D3/D10). `Schema` is stable and imported directly.

import { Schema } from "effect";

import { Rpc, RpcGroup } from "../effect-rpc-adapter";
import {
  CommitDetail,
  CommitSummary,
  DiffFile,
  FileContentResult,
  RecentRepo,
  RepoHandle,
  RepoState,
} from "../schemas/domain";
import { GitError } from "../schemas/errors";
import { InvalidationEvent } from "../schemas/live";
import { Oid, RepoId } from "../schemas/primitives";
import { DiffSpec, LogQuery } from "../schemas/queries";

export const CbranchRpcs = RpcGroup.make(
  // repo.open — entry point (no clone). Logically only repoNotFound | notARepository
  // | fsError, but the error schema is the single canonical GitError (DECISIONS D7).
  Rpc.make("RepoOpen", {
    payload: { path: Schema.String },
    success: RepoHandle,
    error: GitError,
  }),
  // repo.recentList — keyed by resolved top-level path.
  Rpc.make("RepoRecentList", {
    payload: {},
    success: Schema.Array(RecentRepo),
    error: GitError,
  }),
  // repo.recentRemove
  Rpc.make("RepoRecentRemove", {
    payload: { repoId: RepoId },
    success: Schema.Void,
    error: GitError,
  }),
  // repo.state — HEAD, current branch, detached, in-progress op (14 §8).
  Rpc.make("RepoState", {
    payload: { repoId: RepoId },
    success: RepoState,
    error: GitError,
  }),
  // repo.subscribe — WS invalidation bus → query refetch (15). Streaming.
  Rpc.make("RepoSubscribe", {
    payload: { repoId: RepoId },
    success: InvalidationEvent,
    error: GitError,
    stream: true,
  }),
  // log.stream — the one history feed (14 §6). Streaming.
  Rpc.make("LogStream", {
    payload: LogQuery,
    success: CommitSummary,
    error: GitError,
    stream: true,
  }),
  // commit.detail — full body, parents, stats.
  Rpc.make("CommitDetail", {
    payload: { repoId: RepoId, oid: Oid },
    success: CommitDetail,
    error: GitError,
  }),
  // commit.diff — diff of a commit/range.
  Rpc.make("CommitDiff", {
    payload: DiffSpec,
    success: Schema.Array(DiffFile),
    error: GitError,
  }),
  // diff.workingFile — working-tree / index diff for one path.
  Rpc.make("DiffWorkingFile", {
    payload: { repoId: RepoId, path: Schema.String, staged: Schema.Boolean },
    success: DiffFile,
    error: GitError,
  }),
  // file.contentAtRev — inline content, or a download descriptor when over the cap.
  Rpc.make("FileContentAtRev", {
    payload: { repoId: RepoId, path: Schema.String, rev: Schema.String },
    success: FileContentResult,
    error: GitError,
  }),
);
