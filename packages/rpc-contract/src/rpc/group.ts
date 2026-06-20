// The P1+P2+P3 method catalog (docs/spec/14-rpc-contract.md §7).
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
  BranchInfo,
  BranchListing,
  BranchSwitchStrategy,
  MergeMode,
  MergeResult,
  RemoteInfo,
  StashEntry,
  SyncEvent,
  TagInfo,
  TagType,
  WorktreeInfo,
} from "../schemas/branches";
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
import {
  CommitCreated,
  CommitInput,
  CommitMessage,
  PatchSelection,
  WorkingTreeStatus,
} from "../schemas/working-tree";

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

  // ── P2: stage & commit (docs/spec/06; 14 §7) ───────────────────────────────
  // status.get — full working-tree status snapshot (porcelain v2).
  Rpc.make("StatusGet", {
    payload: {
      repoId: RepoId,
      includeIgnored: Schema.optional(Schema.Boolean),
    },
    success: WorkingTreeStatus,
    error: GitError,
  }),
  // stage.files ✎ — stage whole files (or `all` = `git add -A`).
  Rpc.make("StageFiles", {
    payload: {
      repoId: RepoId,
      paths: Schema.Array(Schema.String),
      all: Schema.optional(Schema.Boolean),
    },
    success: Schema.Void,
    error: GitError,
  }),
  // unstage.files ✎ — unstage whole files (or `all` = `git reset`).
  Rpc.make("UnstageFiles", {
    payload: {
      repoId: RepoId,
      paths: Schema.Array(Schema.String),
      all: Schema.optional(Schema.Boolean),
    },
    success: Schema.Void,
    error: GitError,
  }),
  // discard.files ✎ — restore tracked files in the worktree (`git restore --worktree`).
  Rpc.make("DiscardFiles", {
    payload: { repoId: RepoId, paths: Schema.Array(Schema.String) },
    success: Schema.Void,
    error: GitError,
  }),
  // deleteUntracked ✎ — remove untracked files (`git clean -f`); split from discard (D15).
  Rpc.make("DeleteUntracked", {
    payload: { repoId: RepoId, paths: Schema.Array(Schema.String) },
    success: Schema.Void,
    error: GitError,
  }),
  // reset.to ✎ — `git reset --<mode> <target>`.
  Rpc.make("ResetTo", {
    payload: {
      repoId: RepoId,
      mode: Schema.Literals(["soft", "mixed", "hard"]),
      target: Schema.String,
    },
    success: Schema.Void,
    error: GitError,
  }),
  // stage.hunks ✎ — partial stage from a structured selection (server builds the patch).
  Rpc.make("StageHunks", {
    payload: PatchSelection,
    success: Schema.Void,
    error: GitError,
  }),
  // unstage.hunks ✎ — partial unstage from a structured selection.
  Rpc.make("UnstageHunks", {
    payload: PatchSelection,
    success: Schema.Void,
    error: GitError,
  }),
  // discard.hunks ✎ — partial worktree discard from a structured selection.
  Rpc.make("DiscardHunks", {
    payload: PatchSelection,
    success: Schema.Void,
    error: GitError,
  }),
  // commit.create ✎ — `git commit -F -` with optional amend/signoff/sign/author.
  Rpc.make("CommitCreate", {
    payload: CommitInput,
    success: CommitCreated,
    error: GitError,
  }),
  // commit.lastMessage — the last commit's split message (for reuse/amend seeding).
  Rpc.make("CommitLastMessage", {
    payload: { repoId: RepoId },
    success: CommitMessage,
    error: GitError,
  }),

  // ── P3: branches (docs/spec/07) ────────────────────────────────────────────
  // branch.list — all local + remote-tracking branches with upstream/ahead-behind.
  Rpc.make("BranchList", {
    payload: { repoId: RepoId },
    success: BranchListing,
    error: GitError,
  }),
  // branch.create ✎
  Rpc.make("BranchCreate", {
    payload: {
      repoId: RepoId,
      name: Schema.String,
      startPoint: Schema.optional(Schema.String),
      setUpstream: Schema.optional(Schema.Boolean),
      switchAfter: Schema.Boolean,
    },
    success: BranchInfo,
    error: GitError,
  }),
  // branch.switch ✎ — strategy only needed when WD is dirty (retry after dirtyWorkingTree error).
  Rpc.make("BranchSwitch", {
    payload: {
      repoId: RepoId,
      target: Schema.String,
      strategy: Schema.optional(BranchSwitchStrategy),
      stashAndReapply: Schema.optional(Schema.Boolean),
    },
    success: Schema.Void,
    error: GitError,
  }),
  // branch.rename ✎
  Rpc.make("BranchRename", {
    payload: { repoId: RepoId, oldName: Schema.String, newName: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  // branch.delete ✎ — force=false = safe delete (fails if unmerged); force=true = -D (after user confirm).
  Rpc.make("BranchDelete", {
    payload: { repoId: RepoId, name: Schema.String, force: Schema.Boolean },
    success: Schema.Void,
    error: GitError,
  }),
  // branch.setUpstream ✎ — upstream=absent/undefined = unset upstream.
  Rpc.make("BranchSetUpstream", {
    payload: {
      repoId: RepoId,
      name: Schema.String,
      upstream: Schema.optional(Schema.String),
    },
    success: Schema.Void,
    error: GitError,
  }),

  // ── P3: merge ──────────────────────────────────────────────────────────────
  // merge.create ✎
  Rpc.make("MergeCreate", {
    payload: {
      repoId: RepoId,
      ref: Schema.String,
      strategy: MergeMode,
      message: Schema.optional(Schema.String),
    },
    success: MergeResult,
    error: GitError,
  }),
  // merge.abort ✎
  Rpc.make("MergeAbort", {
    payload: { repoId: RepoId },
    success: Schema.Void,
    error: GitError,
  }),

  // ── P3: sync (streaming) ───────────────────────────────────────────────────
  // fetch.stream — read-only (no lock); streams SyncEvent progress + refUpdates.
  Rpc.make("FetchStream", {
    payload: {
      repoId: RepoId,
      remote: Schema.optional(Schema.String),
      all: Schema.optional(Schema.Boolean),
      prune: Schema.optional(Schema.Boolean),
      tags: Schema.optional(Schema.Boolean),
    },
    success: SyncEvent,
    error: GitError,
    stream: true,
  }),
  // pull.stream ✎
  Rpc.make("PullStream", {
    payload: {
      repoId: RepoId,
      mode: Schema.Literals(["ff-only", "rebase", "merge"]),
      autostash: Schema.optional(Schema.Boolean),
    },
    success: SyncEvent,
    error: GitError,
    stream: true,
  }),
  // push.stream ✎
  Rpc.make("PushStream", {
    payload: {
      repoId: RepoId,
      remote: Schema.String,
      branch: Schema.optional(Schema.String),
      setUpstream: Schema.optional(Schema.Boolean),
      forceWithLease: Schema.optional(Schema.Boolean),
      tags: Schema.optional(Schema.Boolean),
    },
    success: SyncEvent,
    error: GitError,
    stream: true,
  }),
  // push.deleteRemoteRef ✎ — non-streaming delete of a remote branch or tag ref.
  Rpc.make("PushDeleteRemoteRef", {
    payload: {
      repoId: RepoId,
      remote: Schema.String,
      ref: Schema.String,
      refType: Schema.Literals(["branch", "tag"]),
    },
    success: Schema.Void,
    error: GitError,
  }),

  // ── P3: remotes ────────────────────────────────────────────────────────────
  Rpc.make("RemoteList", {
    payload: { repoId: RepoId },
    success: Schema.Array(RemoteInfo),
    error: GitError,
  }),
  Rpc.make("RemoteAdd", {
    payload: { repoId: RepoId, name: Schema.String, url: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("RemoteSetUrl", {
    payload: {
      repoId: RepoId,
      name: Schema.String,
      url: Schema.String,
      push: Schema.optional(Schema.Boolean),
    },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("RemoteRename", {
    payload: { repoId: RepoId, oldName: Schema.String, newName: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("RemoteRemove", {
    payload: { repoId: RepoId, name: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),

  // ── P3: worktrees ──────────────────────────────────────────────────────────
  Rpc.make("WorktreeList", {
    payload: { repoId: RepoId },
    success: Schema.Array(WorktreeInfo),
    error: GitError,
  }),
  Rpc.make("WorktreeAdd", {
    payload: {
      repoId: RepoId,
      path: Schema.String,
      branch: Schema.optional(Schema.String),
      newBranch: Schema.optional(Schema.String),
      startPoint: Schema.optional(Schema.String),
    },
    success: WorktreeInfo,
    error: GitError,
  }),
  Rpc.make("WorktreeRemove", {
    payload: {
      repoId: RepoId,
      path: Schema.String,
      force: Schema.optional(Schema.Boolean),
    },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("WorktreePrune", {
    payload: { repoId: RepoId },
    success: Schema.Void,
    error: GitError,
  }),

  // ── P3: stash ──────────────────────────────────────────────────────────────
  Rpc.make("StashPush", {
    payload: {
      repoId: RepoId,
      message: Schema.optional(Schema.String),
      includeUntracked: Schema.optional(Schema.Boolean),
      keepIndex: Schema.optional(Schema.Boolean),
      stagedOnly: Schema.optional(Schema.Boolean),
    },
    success: StashEntry,
    error: GitError,
  }),
  Rpc.make("StashList", {
    payload: { repoId: RepoId },
    success: Schema.Array(StashEntry),
    error: GitError,
  }),
  Rpc.make("StashShow", {
    payload: { repoId: RepoId, ref: Schema.String },
    success: Schema.Array(DiffFile),
    error: GitError,
  }),
  Rpc.make("StashApply", {
    payload: { repoId: RepoId, ref: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("StashPop", {
    payload: { repoId: RepoId, ref: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("StashDrop", {
    payload: { repoId: RepoId, ref: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("StashClear", {
    payload: { repoId: RepoId },
    success: Schema.Void,
    error: GitError,
  }),

  // ── P3: tags ───────────────────────────────────────────────────────────────
  Rpc.make("TagList", {
    payload: { repoId: RepoId },
    success: Schema.Array(TagInfo),
    error: GitError,
  }),
  Rpc.make("TagCreate", {
    payload: {
      repoId: RepoId,
      name: Schema.String,
      target: Schema.optional(Schema.String),
      tagType: TagType,
      message: Schema.optional(Schema.String),
      force: Schema.optional(Schema.Boolean),
    },
    success: TagInfo,
    error: GitError,
  }),
  Rpc.make("TagDelete", {
    payload: { repoId: RepoId, name: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("TagPush", {
    payload: {
      repoId: RepoId,
      remote: Schema.String,
      name: Schema.optional(Schema.String),
      all: Schema.optional(Schema.Boolean),
    },
    success: Schema.Void,
    error: GitError,
  }),
  Rpc.make("TagDeleteRemote", {
    payload: { repoId: RepoId, remote: Schema.String, name: Schema.String },
    success: Schema.Void,
    error: GitError,
  }),
);
