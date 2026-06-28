// RPC handler bindings (docs/spec/14 §7; DECISIONS D1).
//
// Maps every method of the single `CbranchRpcs` catalog to the corresponding
// `GitEngine` operation. The handler keys are the on-wire PascalCase tags (D1);
// unary methods return an `Effect`, the two streaming methods (`RepoSubscribe`,
// `LogStream`) return a `Stream` (`Stream.unwrap` threads the `GitEngine` service in).
// Every handler calls THROUGH the engine and never touches git directly
// (REQ-ARCH-010); the produced layer requires `GitEngine` and provides the RPC
// handler context the server runtime consumes.

import { GitEngine } from "@cbranch/core";
import { CbranchRpcs } from "@cbranch/rpc-contract";
import { Effect, Stream } from "effect";

/** Layer providing the P1 RPC handlers; requires `GitEngine` (supplied by `gitEngineLayer`). */
export const handlersLayer = CbranchRpcs.toLayer({
  // ── repository & live state ────────────────────────────────────────────────
  RepoOpen: ({ path }) =>
    Effect.flatMap(GitEngine, (engine) => engine.open(path)),
  RepoRecentList: () =>
    Effect.flatMap(GitEngine, (engine) => engine.recentList()),
  RepoRecentRemove: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.recentRemove(repoId)),
  RepoState: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.state(repoId)),
  RepoSubscribe: ({ repoId }) =>
    Stream.unwrap(Effect.map(GitEngine, (engine) => engine.subscribe(repoId))),

  // ── history & diff & content ───────────────────────────────────────────────
  LogStream: (query) =>
    Stream.unwrap(Effect.map(GitEngine, (engine) => engine.logStream(query))),
  CommitDetail: ({ repoId, oid }) =>
    Effect.flatMap(GitEngine, (engine) => engine.commitDetail(repoId, oid)),
  CommitDiff: (spec) =>
    Effect.flatMap(GitEngine, (engine) => engine.commitDiff(spec)),
  DiffWorkingFile: ({ repoId, path, staged }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.diffWorkingFile(repoId, path, staged),
    ),
  FileContentAtRev: ({ repoId, path, rev }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.fileContentAtRev(repoId, path, rev),
    ),

  // ── stage & commit (P2) ────────────────────────────────────────────────────
  StatusGet: ({ repoId, includeIgnored }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.statusGet(repoId, includeIgnored),
    ),
  StageFiles: ({ repoId, paths, all }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.stageFiles(repoId, paths, all),
    ),
  UnstageFiles: ({ repoId, paths, all }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.unstageFiles(repoId, paths, all),
    ),
  DiscardFiles: ({ repoId, paths }) =>
    Effect.flatMap(GitEngine, (engine) => engine.discardFiles(repoId, paths)),
  DeleteUntracked: ({ repoId, paths }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.deleteUntracked(repoId, paths),
    ),
  ResetTo: ({ repoId, mode, target }) =>
    Effect.flatMap(GitEngine, (engine) => engine.resetTo(repoId, mode, target)),
  StageHunks: (selection) =>
    Effect.flatMap(GitEngine, (engine) => engine.stageHunks(selection)),
  UnstageHunks: (selection) =>
    Effect.flatMap(GitEngine, (engine) => engine.unstageHunks(selection)),
  DiscardHunks: (selection) =>
    Effect.flatMap(GitEngine, (engine) => engine.discardHunks(selection)),
  CommitCreate: (input) =>
    Effect.flatMap(GitEngine, (engine) => engine.commitCreate(input)),
  CommitLastMessage: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.commitLastMessage(repoId)),

  // ── branches (P3) ─────────────────────────────────────────────────────────
  BranchList: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.branchList(repoId)),
  BranchCreate: ({ repoId, name, startPoint, setUpstream, switchAfter }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.branchCreate(repoId, name, startPoint, setUpstream, switchAfter),
    ),
  BranchSwitch: ({ repoId, target, strategy, stashAndReapply }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.branchSwitch(repoId, target, strategy, stashAndReapply),
    ),
  BranchCheckoutDetached: ({ repoId, ref }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.branchCheckoutDetached(repoId, ref),
    ),
  BranchRename: ({ repoId, oldName, newName }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.branchRename(repoId, oldName, newName),
    ),
  BranchDelete: ({ repoId, name, force }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.branchDelete(repoId, name, force),
    ),
  BranchSetUpstream: ({ repoId, name, upstream }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.branchSetUpstream(repoId, name, upstream),
    ),

  // ── merge (P3) ────────────────────────────────────────────────────────────
  MergeCreate: ({ repoId, ref, strategy, message }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.mergeCreate(repoId, ref, strategy, message),
    ),
  MergeAbort: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.mergeAbort(repoId)),

  // ── sync (P3) ─────────────────────────────────────────────────────────────
  FetchStream: ({ repoId, remote, all, prune, tags }) =>
    Stream.unwrap(
      Effect.map(GitEngine, (engine) =>
        engine.fetchStream(repoId, remote, all, prune, tags),
      ),
    ),
  PullStream: ({ repoId, mode, autostash }) =>
    Stream.unwrap(
      Effect.map(GitEngine, (engine) =>
        engine.pullStream(repoId, mode, autostash),
      ),
    ),
  PushStream: ({ repoId, remote, branch, setUpstream, forceWithLease, tags }) =>
    Stream.unwrap(
      Effect.map(GitEngine, (engine) =>
        engine.pushStream(
          repoId,
          remote,
          branch,
          setUpstream,
          forceWithLease,
          tags,
        ),
      ),
    ),
  PushDeleteRemoteRef: ({ repoId, remote, ref, refType }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.pushDeleteRemoteRef(repoId, remote, ref, refType),
    ),

  // ── remotes (P3) ──────────────────────────────────────────────────────────
  RemoteList: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.remoteList(repoId)),
  RemoteAdd: ({ repoId, name, url }) =>
    Effect.flatMap(GitEngine, (engine) => engine.remoteAdd(repoId, name, url)),
  RemoteSetUrl: ({ repoId, name, url, push }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.remoteSetUrl(repoId, name, url, push),
    ),
  RemoteRename: ({ repoId, oldName, newName }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.remoteRename(repoId, oldName, newName),
    ),
  RemoteRemove: ({ repoId, name }) =>
    Effect.flatMap(GitEngine, (engine) => engine.remoteRemove(repoId, name)),

  // ── worktrees (P3) ────────────────────────────────────────────────────────
  WorktreeList: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.worktreeList(repoId)),
  WorktreeAdd: ({ repoId, path, branch, newBranch, startPoint, force }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.worktreeAdd(repoId, path, branch, newBranch, startPoint, force),
    ),
  WorktreeRemove: ({ repoId, path, force }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.worktreeRemove(repoId, path, force),
    ),
  WorktreePrune: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.worktreePrune(repoId)),
  WorktreeSwitch: ({ repoId, path }) =>
    Effect.flatMap(GitEngine, (engine) => engine.worktreeSwitch(repoId, path)),

  // ── stash (P3) ────────────────────────────────────────────────────────────
  StashPush: ({ repoId, message, includeUntracked, keepIndex, stagedOnly }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.stashPush(
        repoId,
        message,
        includeUntracked,
        keepIndex,
        stagedOnly,
      ),
    ),
  StashList: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.stashList(repoId)),
  StashShow: ({ repoId, ref }) =>
    Effect.flatMap(GitEngine, (engine) => engine.stashShow(repoId, ref)),
  StashApply: ({ repoId, ref }) =>
    Effect.flatMap(GitEngine, (engine) => engine.stashApply(repoId, ref)),
  StashPop: ({ repoId, ref }) =>
    Effect.flatMap(GitEngine, (engine) => engine.stashPop(repoId, ref)),
  StashDrop: ({ repoId, ref }) =>
    Effect.flatMap(GitEngine, (engine) => engine.stashDrop(repoId, ref)),
  StashClear: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.stashClear(repoId)),

  // ── tags (P3) ─────────────────────────────────────────────────────────────
  TagList: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.tagList(repoId)),
  TagCreate: ({ repoId, name, target, tagType, message, force }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.tagCreate(repoId, name, target, tagType, message, force),
    ),
  TagDelete: ({ repoId, name }) =>
    Effect.flatMap(GitEngine, (engine) => engine.tagDelete(repoId, name)),
  TagPush: ({ repoId, remote, name, all }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.tagPush(repoId, remote, name, all),
    ),
  TagDeleteRemote: ({ repoId, remote, name }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.tagDeleteRemote(repoId, remote, name),
    ),

  // ── conflicts (P4) ──────────────────────────────────────────────────────────
  ConflictList: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.conflictList(repoId)),
  ConflictSides: ({ repoId, path }) =>
    Effect.flatMap(GitEngine, (engine) => engine.conflictSides(repoId, path)),
  ConflictResolve: ({ repoId, paths, resolution }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.conflictResolve(repoId, paths, resolution),
    ),
  ConflictSaveMerged: ({ repoId, path, content, encoding }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.conflictSaveMerged(repoId, path, content, encoding),
    ),
  ConflictMarkResolved: ({ repoId, paths }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.conflictMarkResolved(repoId, paths),
    ),
  ConflictMarkUnresolved: ({ repoId, paths }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.conflictMarkUnresolved(repoId, paths),
    ),

  // ── cherry-pick / revert + continuation (P4) ──────────────────────────────
  CherryPick: ({ repoId, commits, recordOrigin, mainline, noCommit }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.cherryPick(repoId, commits, recordOrigin, mainline, noCommit),
    ),
  Revert: ({ repoId, commits, mainline, noCommit, message }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.revert(repoId, commits, mainline, noCommit, message),
    ),
  OpContinue: ({ repoId, message, allowEmpty }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.opContinue(repoId, message, allowEmpty),
    ),
  OpAbort: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.opAbort(repoId)),
  OpSkip: ({ repoId }) =>
    Effect.flatMap(GitEngine, (engine) => engine.opSkip(repoId)),

  // ── blame & file history (P4) ─────────────────────────────────────────────
  Blame: ({ repoId, path, rev, startLine, endLine, force }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.blame(repoId, path, rev, startLine, endLine, force),
    ),
  FileHistory: ({ repoId, path, limit, cursor, startRev }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.fileHistory(repoId, path, limit, cursor, startRev),
    ),

  // ── repository maintenance (P5) ─────────────────────────────────────────────
  RepoGc: ({ repoId, aggressive, prune }) =>
    Effect.flatMap(GitEngine, (engine) => engine.gc(repoId, aggressive, prune)),

  // ── clean working directory (P5) ────────────────────────────────────────────
  CleanPreview: ({ repoId, directories, ignored }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.cleanPreview(repoId, directories, ignored),
    ),
  Clean: ({ repoId, paths, directories, ignored }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.clean(repoId, paths, directories, ignored),
    ),

  // ── archive export (P5) — bytes stream over GET /sidechannel/archive, not here ──
  ArchivePrepare: ({ repoId, treeish, format, prefix, subPath }) =>
    Effect.flatMap(GitEngine, (engine) =>
      engine.archivePrepare(repoId, treeish, format, prefix, subPath),
    ),
});
