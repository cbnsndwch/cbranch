// Live `GitEngine` construction (docs/spec/02 REQ-ARCH-020/025/030/041).
//
// `makeGitEngine` wires the host-git infrastructure once: it gates the host git
// version (REQ-ARCH-025), opens the config store, and stands up a per-`repoId`
// `cat-file` pool registry whose lifetime is bound to the engine's `Scope` (killed on
// teardown — REQ-ARCH-064). `repoId → location` is remembered on open so
// `state(repoId)` (and core-B's reads) can map an id back to a working directory,
// falling back to the recent list so a freshly restarted service can still answer for
// a known repo. Phase 1 is read-only, so nothing acquires the per-repo mutation lock
// (P1-X-1); the lock registry (`makeRepoLockRegistry`) is exported infra for P2.

import { basename } from "node:path";

import {
  type GitError,
  type InvalidationEvent,
  type RepoId,
  type StashEntry,
  type TagInfo,
  type WorktreeInfo,
} from "@cbranch/rpc-contract";
import { RepoHandle } from "@cbranch/rpc-contract";
import { type Cause, Effect, Layer, Queue, Scope, Stream } from "effect";

import { type ConfigStore, makeConfigStore } from "../config/config-store";
import {
  branchCreate as branchCreateGit,
  branchDelete as branchDeleteGit,
  branchRename as branchRenameGit,
  branchSetUpstream as branchSetUpstreamGit,
  branchSwitch as branchSwitchGit,
} from "../git/branch-ops";
import { branchList } from "../git/branches";
import { type CatFilePool, makeCatFilePool } from "../git/cat-file-pool";
import { commitDetail } from "../git/commit";
import { commitCreate as commitCreateGit, commitLastMessage as commitLastMessageGit } from "../git/commit-write";
import { fileContentAtRev } from "../git/content";
import { commitDiff, diffWorkingFile } from "../git/diff";
import { gitError } from "../git/errors";
import { makeLogStream } from "../git/history";
import { makeRepoLockRegistry } from "../git/locks";
import { mergeAbort as mergeAbortGit, mergeCreate as mergeCreateGit } from "../git/merge";
import {
  discardHunks as discardHunksGit,
  stageHunks as stageHunksGit,
  unstageHunks as unstageHunksGit,
} from "../git/patch";
import {
  remoteAdd as remoteAddGit,
  remoteList as remoteListGit,
  remoteRemove as remoteRemoveGit,
  remoteRename as remoteRenameGit,
  remoteSetUrl as remoteSetUrlGit,
} from "../git/remotes";
import {
  deleteUntracked as deleteUntrackedGit,
  discardFiles as discardFilesGit,
  resetTo as resetToGit,
  stageFiles as stageFilesGit,
  unstageFiles as unstageFilesGit,
} from "../git/stage";
import { statusGet } from "../git/status";
import {
  fetchStream as fetchStreamGit,
  pullStream as pullStreamGit,
  pushDeleteRemoteRef as pushDeleteRemoteRefGit,
  pushStream as pushStreamGit,
} from "../git/sync";
import { detectGitVersion } from "../git/version";
import { WatcherRegistry } from "../git/watcher";
import { type ResolvedRepo, repoCwd, resolveRepo } from "../repo/resolve";
import { readRepoState } from "../repo/state";
import { GitEngine, type GitEngineApi } from "./git-engine";

export interface MakeGitEngineOptions {
  /** Override the settings file path (tests / `CBRANCH_CONFIG` semantics). */
  readonly configPath?: string;
  /** Environment overrides for git invocations + config-path resolution. */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the one-time `git --version` probe (default `process.cwd()`). */
  readonly versionProbeCwd?: string;
}

/**
 * Build a live {@link GitEngineApi}. Requires a `Scope`: the version probe runs once,
 * and the `cat-file` pools register their teardown finalizers on this scope. Provide
 * the scope via a `Layer` ({@link gitEngineLayer}) or `Effect.scoped` (tests).
 */
export const makeGitEngine = (opts?: MakeGitEngineOptions): Effect.Effect<GitEngineApi, GitError, Scope.Scope> =>
  Effect.gen(function* () {
    const env = opts?.env;
    // 1. Version gate (REQ-ARCH-025 / NF-PKG-5) — fails construction if missing/too old.
    yield* detectGitVersion(opts?.versionProbeCwd ?? process.cwd());

    const configStore: ConfigStore = makeConfigStore({ configPath: opts?.configPath, env });
    const scope = yield* Effect.scope;
    const locks = makeRepoLockRegistry();
    const locations = new Map<string, ResolvedRepo>();
    const pools = new Map<string, CatFilePool>();

    // The shared per-`repoId` fs-watcher registry; all watchers die on engine teardown
    // (NF-WATCH-2 / REQ-ARCH-042).
    const watchers = new WatcherRegistry();
    yield* Effect.addFinalizer(() => Effect.sync(() => watchers.closeAll()));

    const resolveById = (repoId: RepoId): Effect.Effect<ResolvedRepo, GitError> =>
      Effect.gen(function* () {
        const cached = locations.get(repoId);
        if (cached !== undefined) return cached;
        const recents = yield* configStore.listRecent();
        const entry = recents.find((r) => r.repoId === repoId);
        if (entry === undefined) {
          return yield* Effect.fail(gitError("repoUnavailable", "repository is not open and not in the recent list"));
        }
        const repo = yield* resolveRepo(entry.path);
        if (repo.repoId !== repoId) {
          return yield* Effect.fail(gitError("repoUnavailable", "recent entry no longer resolves to this repository"));
        }
        locations.set(repo.repoId, repo);
        return repo;
      });

    const poolFor = (repo: ResolvedRepo): Effect.Effect<CatFilePool, GitError> =>
      Effect.gen(function* () {
        const cached = pools.get(repo.repoId);
        if (cached !== undefined) return cached;
        const pool = yield* Scope.provide(makeCatFilePool(repoCwd(repo), env), scope);
        pools.set(repo.repoId, pool);
        return pool;
      });

    const open = (path: string): Effect.Effect<RepoHandle, GitError> =>
      Effect.gen(function* () {
        const repo = yield* resolveRepo(path);
        const state = yield* readRepoState(repo);
        locations.set(repo.repoId, repo);
        const name = basename(repo.root) === "" ? repo.root : basename(repo.root);
        yield* configStore.upsertRecent({ path: repo.root, name, repoId: repo.repoId, lastOpenedAt: Date.now() });
        return new RepoHandle({
          repoId: repo.repoId,
          root: repo.root,
          gitDir: repo.gitDir,
          commonDir: repo.commonDir,
          state,
        });
      });

    const api: GitEngineApi = {
      open,
      recentList: () => configStore.listRecent(),
      recentRemove: (repoId) => configStore.removeRecent(repoId),
      state: (repoId) => Effect.flatMap(resolveById(repoId), readRepoState),

      // ── history & diff & content (P1, core-B) ──────────────────────────────
      subscribe: (repoId) =>
        Stream.unwrap(
          Effect.map(resolveById(repoId), (repo) =>
            Stream.callback<InvalidationEvent, GitError>(
              (queue: Queue.Queue<InvalidationEvent, GitError | Cause.Done>) =>
                Effect.acquireRelease(
                  Effect.sync(() => watchers.addListener(repo, (event) => Queue.offerUnsafe(queue, event))),
                  (dispose) => Effect.sync(() => dispose()),
                ),
            ),
          ),
        ),
      logStream: (query) =>
        Stream.unwrap(Effect.map(resolveById(query.repoId), (repo) => makeLogStream(repoCwd(repo), query, env))),
      commitDetail: (repoId, oid) =>
        Effect.flatMap(resolveById(repoId), (repo) => commitDetail(repoCwd(repo), oid, env)),
      commitDiff: (spec) => Effect.flatMap(resolveById(spec.repoId), (repo) => commitDiff(repoCwd(repo), spec, env)),
      diffWorkingFile: (repoId, path, staged) =>
        Effect.flatMap(resolveById(repoId), (repo) => diffWorkingFile(repoCwd(repo), path, staged, env)),
      fileContentAtRev: (repoId, path, rev) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          Effect.flatMap(poolFor(repo), (pool) => fileContentAtRev(pool, repoId, path, rev)),
        ),

      // ── stage & commit (P2) ────────────────────────────────────────────────
      statusGet: (repoId, includeIgnored) =>
        Effect.flatMap(resolveById(repoId), (repo) => statusGet(repoCwd(repo), includeIgnored)),
      stageFiles: (repoId, paths, all) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(stageFilesGit(repoCwd(repo), paths, all ?? false)),
        ),
      unstageFiles: (repoId, paths, all) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(unstageFilesGit(repoCwd(repo), paths, all ?? false)),
        ),
      discardFiles: (repoId, paths) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(discardFilesGit(repoCwd(repo), paths)),
        ),
      deleteUntracked: (repoId, paths) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(deleteUntrackedGit(repoCwd(repo), paths)),
        ),
      resetTo: (repoId, mode, target) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(resetToGit(repoCwd(repo), mode, target)),
        ),
      stageHunks: (selection) =>
        Effect.flatMap(resolveById(selection.repoId), (repo) =>
          locks.withRepoLock(selection.repoId)(stageHunksGit(repoCwd(repo), selection)),
        ),
      unstageHunks: (selection) =>
        Effect.flatMap(resolveById(selection.repoId), (repo) =>
          locks.withRepoLock(selection.repoId)(unstageHunksGit(repoCwd(repo), selection)),
        ),
      discardHunks: (selection) =>
        Effect.flatMap(resolveById(selection.repoId), (repo) =>
          locks.withRepoLock(selection.repoId)(discardHunksGit(repoCwd(repo), selection)),
        ),
      commitCreate: (input) =>
        Effect.flatMap(resolveById(input.repoId), (repo) =>
          locks.withRepoLock(input.repoId)(commitCreateGit(repoCwd(repo), input)),
        ),
      commitLastMessage: (repoId) => Effect.flatMap(resolveById(repoId), (repo) => commitLastMessageGit(repoCwd(repo))),

      // Object-read infra (implemented now; consumed by core-B's history/diff/content).
      readObject: (repoId, rev) =>
        Effect.flatMap(resolveById(repoId), (repo) => Effect.flatMap(poolFor(repo), (p) => p.readObject(rev))),
      objectInfo: (repoId, rev) =>
        Effect.flatMap(resolveById(repoId), (repo) => Effect.flatMap(poolFor(repo), (p) => p.objectInfo(rev))),

      // ── branches (P3) ─────────────────────────────────────────────────────
      branchList: (repoId) => Effect.flatMap(resolveById(repoId), (repo) => branchList(repoCwd(repo), env)),
      branchCreate: (repoId, name, startPoint, setUpstream, switchAfter) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(branchCreateGit(repoCwd(repo), name, startPoint, setUpstream, switchAfter, env)),
        ),
      branchSwitch: (repoId, target, strategy, _stashAndReapply) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(branchSwitchGit(repoCwd(repo), target, strategy, env)),
        ),
      branchRename: (repoId, oldName, newName) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(branchRenameGit(repoCwd(repo), oldName, newName, env)),
        ),
      branchDelete: (repoId, name, force) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(branchDeleteGit(repoCwd(repo), name, force, env)),
        ),
      branchSetUpstream: (repoId, name, upstream) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(branchSetUpstreamGit(repoCwd(repo), name, upstream, env)),
        ),

      // ── merge (P3) ────────────────────────────────────────────────────────
      mergeCreate: (repoId, ref, strategy) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(mergeCreateGit(repoCwd(repo), ref, strategy, env)),
        ),
      mergeAbort: (repoId) =>
        Effect.flatMap(resolveById(repoId), (repo) => locks.withRepoLock(repoId)(mergeAbortGit(repoCwd(repo), env))),

      // ── sync (P3) ────────────────────────────────────────────────────────
      fetchStream: (repoId, remote, all, prune, tags) =>
        Stream.unwrap(
          Effect.map(resolveById(repoId), (repo) => fetchStreamGit(repoCwd(repo), remote, all, prune, tags, env)),
        ),
      pullStream: (repoId, mode, autostash) =>
        Stream.unwrap(Effect.map(resolveById(repoId), (repo) => pullStreamGit(repoCwd(repo), mode, autostash, env))),
      pushStream: (repoId, remote, branch, setUpstream, forceWithLease, tags) =>
        Stream.unwrap(
          Effect.map(resolveById(repoId), (repo) =>
            pushStreamGit(repoCwd(repo), remote, branch, setUpstream, forceWithLease, tags, env),
          ),
        ),
      pushDeleteRemoteRef: (repoId, remote, ref, _refType) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(pushDeleteRemoteRefGit(repoCwd(repo), remote, ref, env)),
        ),

      // ── remotes (P3) ──────────────────────────────────────────────────────
      remoteList: (repoId) => Effect.flatMap(resolveById(repoId), (repo) => remoteListGit(repoCwd(repo), env)),
      remoteAdd: (repoId, name, url) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(remoteAddGit(repoCwd(repo), name, url, env)),
        ),
      remoteSetUrl: (repoId, name, url, push) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(remoteSetUrlGit(repoCwd(repo), name, url, push, env)),
        ),
      remoteRename: (repoId, oldName, newName) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(remoteRenameGit(repoCwd(repo), oldName, newName, env)),
        ),
      remoteRemove: (repoId, name) =>
        Effect.flatMap(resolveById(repoId), (repo) =>
          locks.withRepoLock(repoId)(remoteRemoveGit(repoCwd(repo), name, env)),
        ),

      // ── worktrees (P3, stubs) ─────────────────────────────────────────────
      worktreeList: (repoId) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: worktreeList not implemented")),
        ) as Effect.Effect<ReadonlyArray<WorktreeInfo>, GitError>,
      worktreeAdd: (repoId, _path, _branch, _newBranch, _startPoint) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: worktreeAdd not implemented")),
        ) as Effect.Effect<WorktreeInfo, GitError>,
      worktreeRemove: (repoId, _path, _force) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: worktreeRemove not implemented")),
        ),
      worktreePrune: (repoId) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: worktreePrune not implemented")),
        ),

      // ── stash (P3, stubs) ─────────────────────────────────────────────────
      stashPush: (repoId, _message, _includeUntracked, _keepIndex, _stagedOnly) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashPush not implemented")),
        ) as Effect.Effect<StashEntry, GitError>,
      stashList: (repoId) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashList not implemented")),
        ) as Effect.Effect<ReadonlyArray<StashEntry>, GitError>,
      stashShow: (repoId, _ref) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashShow not implemented")),
        ),
      stashApply: (repoId, _ref) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashApply not implemented")),
        ),
      stashPop: (repoId, _ref) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashPop not implemented")),
        ),
      stashDrop: (repoId, _ref) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashDrop not implemented")),
        ),
      stashClear: (repoId) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: stashClear not implemented")),
        ),

      // ── tags (P3, stubs) ──────────────────────────────────────────────────
      tagList: (repoId) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: tagList not implemented")),
        ) as Effect.Effect<ReadonlyArray<TagInfo>, GitError>,
      tagCreate: (repoId, _name, _target, _tagType, _message, _force) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: tagCreate not implemented")),
        ) as Effect.Effect<TagInfo, GitError>,
      tagDelete: (repoId, _name) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: tagDelete not implemented")),
        ),
      tagPush: (repoId, _remote, _name, _all) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: tagPush not implemented")),
        ),
      tagDeleteRemote: (repoId, _remote, _name) =>
        Effect.flatMap(resolveById(repoId), (_repo) =>
          Effect.fail(gitError("gitFailed", "P3: tagDeleteRemote not implemented")),
        ),
    };
    return api;
  });

/** A `Layer` providing the live {@link GitEngine}, owning the engine's scope. */
export const gitEngineLayer = (opts?: MakeGitEngineOptions): Layer.Layer<GitEngine, GitError> =>
  Layer.effect(GitEngine, makeGitEngine(opts));
