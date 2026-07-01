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

import { basename } from 'node:path';

import {
    type GitError,
    type InvalidationEvent,
    type RepoId,
} from '@cbranch/rpc-contract';
import { AppSettings, KeyBinding, RepoHandle } from '@cbranch/rpc-contract';
import { type Cause, Effect, Layer, Queue, Scope, Stream } from 'effect';

import {
    type AppSettingsData,
    type ConfigStore,
    makeConfigStore,
} from '../config/config-store';
import { blame as blameGit } from '../git/blame';
import {
    bisectMark as bisectMarkGit,
    bisectReset as bisectResetGit,
    bisectStart as bisectStartGit,
    bisectStatus as bisectStatusGit,
} from '../git/bisect';
import {
    branchCheckoutDetached as branchCheckoutDetachedGit,
    branchCreate as branchCreateGit,
    branchDelete as branchDeleteGit,
    branchRename as branchRenameGit,
    branchSetUpstream as branchSetUpstreamGit,
    branchSwitch as branchSwitchGit,
} from '../git/branch-ops';
import { branchList } from '../git/branches';
import { type CatFilePool, makeCatFilePool } from '../git/cat-file-pool';
import { commitDetail } from '../git/commit';
import {
    commitCreate as commitCreateGit,
    commitLastMessage as commitLastMessageGit,
} from '../git/commit-write';
import {
    conflictMarkResolved as conflictMarkResolvedGit,
    conflictMarkUnresolved as conflictMarkUnresolvedGit,
    conflictResolve as conflictResolveGit,
    conflictSaveMerged as conflictSaveMergedGit,
} from '../git/conflict-ops';
import {
    conflictList as conflictListGit,
    conflictSides as conflictSidesGit,
} from '../git/conflicts';
import { fileContentAtRev } from '../git/content';
import { commitDiff, diffWorkingFile } from '../git/diff';
import { gitError } from '../git/errors';
import { fileHistory as fileHistoryGit } from '../git/file-history';
import {
    configGet as configGetGit,
    configList as configListGit,
    configSet as configSetGit,
    configUnset as configUnsetGit,
} from '../git/git-config';
import {
    archivePrepare as archivePrepareGit,
    archiveStreamGit,
} from '../git/archive';
import {
    clean as cleanGit,
    cleanPreview as cleanPreviewGit,
} from '../git/clean';
import { makeLogStream } from '../git/history';
import { makeRepoLockRegistry } from '../git/locks';
import { gc as gcGit } from '../git/maintenance';
import {
    mergeAbort as mergeAbortGit,
    mergeCreate as mergeCreateGit,
} from '../git/merge';
import { reflogList as reflogListGit } from '../git/reflog';
import {
    discardHunks as discardHunksGit,
    stageHunks as stageHunksGit,
    unstageHunks as unstageHunksGit,
} from '../git/patch';
import {
    remoteAdd as remoteAddGit,
    remoteList as remoteListGit,
    remoteRemove as remoteRemoveGit,
    remoteRename as remoteRenameGit,
    remoteSetUrl as remoteSetUrlGit,
} from '../git/remotes';
import {
    cherryPick as cherryPickGit,
    opAbort as opAbortGit,
    opContinue as opContinueGit,
    opSkip as opSkipGit,
    revert as revertGit,
} from '../git/sequencer';
import {
    cleanupRebaseSidecar,
    rebasePlan as rebasePlanGit,
    rebaseStart as rebaseStartGit,
    rebaseStatus as rebaseStatusGit,
} from '../git/rebase';
import {
    deleteUntracked as deleteUntrackedGit,
    discardFiles as discardFilesGit,
    resetTo as resetToGit,
    stageFiles as stageFilesGit,
    unstageFiles as unstageFilesGit,
} from '../git/stage';
import {
    stashApply as stashApplyGit,
    stashClear as stashClearGit,
    stashDrop as stashDropGit,
    stashList as stashListGit,
    stashPop as stashPopGit,
    stashPush as stashPushGit,
    stashShow as stashShowGit,
} from '../git/stash';
import { statusGet } from '../git/status';
import {
    submoduleAdd as submoduleAddGit,
    submoduleList as submoduleListGit,
    submoduleRemove as submoduleRemoveGit,
    submoduleSync as submoduleSyncGit,
    submoduleUpdate as submoduleUpdateGit,
} from '../git/submodules';
import {
    fetchStream as fetchStreamGit,
    pullStream as pullStreamGit,
    pushDeleteRemoteRef as pushDeleteRemoteRefGit,
    pushStream as pushStreamGit,
} from '../git/sync';
import {
    tagCreate as tagCreateGit,
    tagDelete as tagDeleteGit,
    tagDeleteRemote as tagDeleteRemoteGit,
    tagList as tagListGit,
    tagPush as tagPushGit,
} from '../git/tags';
import { detectGitVersion } from '../git/version';
import { WatcherRegistry } from '../git/watcher';
import {
    worktreeAdd as worktreeAddGit,
    worktreeList as worktreeListGit,
    worktreePrune as worktreePruneGit,
    worktreeRemove as worktreeRemoveGit,
} from '../git/worktrees';
import { type ResolvedRepo, repoCwd, resolveRepo } from '../repo/resolve';
import { detectInProgress, readRepoState } from '../repo/state';
import { GitEngine, type GitEngineApi } from './git-engine';

/**
 * Best-effort reap of the scripted-rebase sidecar once a Continue/Skip/Abort ends the
 * rebase — the reused P4 sequencer doesn't know about `<gitDir>/cbranch-rebase/`, so the
 * engine clears it here when the rebase is no longer in progress (a no-op otherwise).
 */
const reapRebaseSidecar = (gitDir: string): Effect.Effect<void> =>
    Effect.sync(() => {
        if (detectInProgress(gitDir) !== 'rebase') cleanupRebaseSidecar(gitDir);
    });

export interface MakeGitEngineOptions {
    /** Override the settings file path (tests / `CBRANCH_CONFIG` semantics). */
    readonly configPath?: string;
    /** Environment overrides for git invocations + config-path resolution. */
    readonly env?: NodeJS.ProcessEnv;
    /** Working directory for the one-time `git --version` probe (default `process.cwd()`). */
    readonly versionProbeCwd?: string;
}

/** Wire app settings (host `config.json`, Record keybindings) → the {@link AppSettings} class. */
const toAppSettings = (data: AppSettingsData): AppSettings =>
    new AppSettings({
        theme: data.theme,
        locale: data.locale,
        keybindings: Object.entries(data.keybindings).map(
            ([commandId, chord]) => new KeyBinding({ commandId, chord }),
        ),
    });

/** Wire wire-form {@link KeyBinding}[] back to the host's native `Record<commandId, chord>`. */
const fromKeyBindings = (
    bindings: ReadonlyArray<KeyBinding>,
): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const b of bindings) out[b.commandId] = b.chord;
    return out;
};

/**
 * Build a live {@link GitEngineApi}. Requires a `Scope`: the version probe runs once,
 * and the `cat-file` pools register their teardown finalizers on this scope. Provide
 * the scope via a `Layer` ({@link gitEngineLayer}) or `Effect.scoped` (tests).
 */
export const makeGitEngine = (
    opts?: MakeGitEngineOptions,
): Effect.Effect<GitEngineApi, GitError, Scope.Scope> =>
    Effect.gen(function* () {
        const env = opts?.env;
        // 1. Version gate (REQ-ARCH-025 / NF-PKG-5) — fails construction if missing/too old.
        yield* detectGitVersion(opts?.versionProbeCwd ?? process.cwd());

        const configStore: ConfigStore = makeConfigStore({
            configPath: opts?.configPath,
            env,
        });
        const scope = yield* Effect.scope;
        const locks = makeRepoLockRegistry();
        const locations = new Map<string, ResolvedRepo>();
        const pools = new Map<string, CatFilePool>();

        // The shared per-`repoId` fs-watcher registry; all watchers die on engine teardown
        // (NF-WATCH-2 / REQ-ARCH-042).
        const watchers = new WatcherRegistry();
        yield* Effect.addFinalizer(() =>
            Effect.sync(() => watchers.closeAll()),
        );

        const resolveById = (
            repoId: RepoId,
        ): Effect.Effect<ResolvedRepo, GitError> =>
            Effect.gen(function* () {
                const cached = locations.get(repoId);
                if (cached !== undefined) return cached;
                const recents = yield* configStore.listRecent();
                const entry = recents.find(r => r.repoId === repoId);
                if (entry === undefined) {
                    return yield* Effect.fail(
                        gitError(
                            'repoUnavailable',
                            'repository is not open and not in the recent list',
                        ),
                    );
                }
                const repo = yield* resolveRepo(entry.path);
                if (repo.repoId !== repoId) {
                    return yield* Effect.fail(
                        gitError(
                            'repoUnavailable',
                            'recent entry no longer resolves to this repository',
                        ),
                    );
                }
                locations.set(repo.repoId, repo);
                return repo;
            });

        const poolFor = (
            repo: ResolvedRepo,
        ): Effect.Effect<CatFilePool, GitError> =>
            Effect.gen(function* () {
                const cached = pools.get(repo.repoId);
                if (cached !== undefined) return cached;
                const pool = yield* Scope.provide(
                    makeCatFilePool(repoCwd(repo), env),
                    scope,
                );
                pools.set(repo.repoId, pool);
                return pool;
            });

        const open = (path: string): Effect.Effect<RepoHandle, GitError> =>
            Effect.gen(function* () {
                const repo = yield* resolveRepo(path);
                const state = yield* readRepoState(repo);
                locations.set(repo.repoId, repo);
                const name =
                    basename(repo.root) === ''
                        ? repo.root
                        : basename(repo.root);
                yield* configStore.upsertRecent({
                    path: repo.root,
                    name,
                    repoId: repo.repoId,
                    lastOpenedAt: Date.now(),
                });
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
            recentRemove: repoId => configStore.removeRecent(repoId),
            state: repoId => Effect.flatMap(resolveById(repoId), readRepoState),

            // ── history & diff & content (P1, core-B) ──────────────────────────────
            subscribe: repoId =>
                Stream.unwrap(
                    Effect.map(resolveById(repoId), repo =>
                        Stream.callback<InvalidationEvent, GitError>(
                            (
                                queue: Queue.Queue<
                                    InvalidationEvent,
                                    GitError | Cause.Done
                                >,
                            ) =>
                                Effect.acquireRelease(
                                    Effect.sync(() =>
                                        watchers.addListener(repo, event =>
                                            Queue.offerUnsafe(queue, event),
                                        ),
                                    ),
                                    dispose => Effect.sync(() => dispose()),
                                ),
                        ),
                    ),
                ),
            logStream: query =>
                Stream.unwrap(
                    Effect.map(resolveById(query.repoId), repo =>
                        makeLogStream(repoCwd(repo), query, env),
                    ),
                ),
            commitDetail: (repoId, oid) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    commitDetail(repoCwd(repo), oid, env),
                ),
            commitDiff: spec =>
                Effect.flatMap(resolveById(spec.repoId), repo =>
                    commitDiff(repoCwd(repo), spec, env),
                ),
            diffWorkingFile: (repoId, path, staged) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    diffWorkingFile(repoCwd(repo), path, staged, env),
                ),
            fileContentAtRev: (repoId, path, rev) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    Effect.flatMap(poolFor(repo), pool =>
                        fileContentAtRev(pool, repoId, path, rev),
                    ),
                ),

            // ── stage & commit (P2) ────────────────────────────────────────────────
            statusGet: (repoId, includeIgnored) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    statusGet(repoCwd(repo), includeIgnored),
                ),
            stageFiles: (repoId, paths, all) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        stageFilesGit(repoCwd(repo), paths, all ?? false),
                    ),
                ),
            unstageFiles: (repoId, paths, all) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        unstageFilesGit(repoCwd(repo), paths, all ?? false),
                    ),
                ),
            discardFiles: (repoId, paths) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        discardFilesGit(repoCwd(repo), paths),
                    ),
                ),
            deleteUntracked: (repoId, paths) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        deleteUntrackedGit(repoCwd(repo), paths),
                    ),
                ),
            resetTo: (repoId, mode, target) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        resetToGit(repoCwd(repo), mode, target),
                    ),
                ),
            stageHunks: selection =>
                Effect.flatMap(resolveById(selection.repoId), repo =>
                    locks.withRepoLock(selection.repoId)(
                        stageHunksGit(repoCwd(repo), selection),
                    ),
                ),
            unstageHunks: selection =>
                Effect.flatMap(resolveById(selection.repoId), repo =>
                    locks.withRepoLock(selection.repoId)(
                        unstageHunksGit(repoCwd(repo), selection),
                    ),
                ),
            discardHunks: selection =>
                Effect.flatMap(resolveById(selection.repoId), repo =>
                    locks.withRepoLock(selection.repoId)(
                        discardHunksGit(repoCwd(repo), selection),
                    ),
                ),
            commitCreate: input =>
                Effect.flatMap(resolveById(input.repoId), repo =>
                    locks.withRepoLock(input.repoId)(
                        commitCreateGit(repoCwd(repo), input),
                    ),
                ),
            commitLastMessage: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    commitLastMessageGit(repoCwd(repo)),
                ),

            // Object-read infra (implemented now; consumed by core-B's history/diff/content).
            readObject: (repoId, rev) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    Effect.flatMap(poolFor(repo), p => p.readObject(rev)),
                ),
            objectInfo: (repoId, rev) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    Effect.flatMap(poolFor(repo), p => p.objectInfo(rev)),
                ),

            // ── branches (P3) ─────────────────────────────────────────────────────
            branchList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    branchList(repoCwd(repo), env),
                ),
            branchCreate: (
                repoId,
                name,
                startPoint,
                setUpstream,
                switchAfter,
            ) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        branchCreateGit(
                            repoCwd(repo),
                            name,
                            startPoint,
                            setUpstream,
                            switchAfter,
                            env,
                        ),
                    ),
                ),
            branchSwitch: (repoId, target, strategy, stashAndReapply) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        branchSwitchGit(
                            repoCwd(repo),
                            target,
                            strategy,
                            stashAndReapply,
                            env,
                        ),
                    ),
                ),
            branchCheckoutDetached: (repoId, ref) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        branchCheckoutDetachedGit(repoCwd(repo), ref, env),
                    ),
                ),
            branchRename: (repoId, oldName, newName) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        branchRenameGit(repoCwd(repo), oldName, newName, env),
                    ),
                ),
            branchDelete: (repoId, name, force) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        branchDeleteGit(repoCwd(repo), name, force, env),
                    ),
                ),
            branchSetUpstream: (repoId, name, upstream) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        branchSetUpstreamGit(
                            repoCwd(repo),
                            name,
                            upstream,
                            env,
                        ),
                    ),
                ),

            // ── merge (P3) ────────────────────────────────────────────────────────
            mergeCreate: (repoId, ref, strategy, message) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        mergeCreateGit(
                            repoCwd(repo),
                            ref,
                            strategy,
                            message,
                            env,
                        ),
                    ),
                ),
            mergeAbort: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        mergeAbortGit(repoCwd(repo), env),
                    ),
                ),

            // ── sync (P3) ────────────────────────────────────────────────────────
            fetchStream: (repoId, remote, all, prune, tags) =>
                Stream.unwrap(
                    Effect.map(resolveById(repoId), repo =>
                        fetchStreamGit(
                            repoCwd(repo),
                            remote,
                            all,
                            prune,
                            tags,
                            env,
                        ),
                    ),
                ),
            pullStream: (repoId, mode, autostash) =>
                Stream.unwrap(
                    Effect.map(resolveById(repoId), repo =>
                        // Mutating + cancelable: hold the per-repo lock for the stream's life
                        // (REQ-P3-XC-001/XC-004).
                        locks.withRepoLockStream(repoId)(
                            pullStreamGit(repoCwd(repo), mode, autostash, env),
                        ),
                    ),
                ),
            pushStream: (
                repoId,
                remote,
                branch,
                setUpstream,
                forceWithLease,
                tags,
            ) =>
                Stream.unwrap(
                    Effect.map(resolveById(repoId), repo =>
                        locks.withRepoLockStream(repoId)(
                            pushStreamGit(
                                repoCwd(repo),
                                remote,
                                branch,
                                setUpstream,
                                forceWithLease,
                                tags,
                                env,
                            ),
                        ),
                    ),
                ),
            pushDeleteRemoteRef: (repoId, remote, ref, _refType) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        pushDeleteRemoteRefGit(repoCwd(repo), remote, ref, env),
                    ),
                ),

            // ── remotes (P3) ──────────────────────────────────────────────────────
            remoteList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    remoteListGit(repoCwd(repo), env),
                ),
            remoteAdd: (repoId, name, url) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        remoteAddGit(repoCwd(repo), name, url, env),
                    ),
                ),
            remoteSetUrl: (repoId, name, url, push) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        remoteSetUrlGit(repoCwd(repo), name, url, push, env),
                    ),
                ),
            remoteRename: (repoId, oldName, newName) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        remoteRenameGit(repoCwd(repo), oldName, newName, env),
                    ),
                ),
            remoteRemove: (repoId, name) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        remoteRemoveGit(repoCwd(repo), name, env),
                    ),
                ),

            // ── worktrees (P3) ────────────────────────────────────────────────────
            worktreeList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    worktreeListGit(repoCwd(repo), env),
                ),
            worktreeAdd: (repoId, path, branch, newBranch, startPoint, force) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        worktreeAddGit(
                            repoCwd(repo),
                            path,
                            { branch, newBranch, startPoint, force },
                            env,
                        ),
                    ),
                ),
            worktreeRemove: (repoId, path, force) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        worktreeRemoveGit(repoCwd(repo), path, force, env),
                    ),
                ),
            worktreePrune: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        worktreePruneGit(repoCwd(repo), env),
                    ),
                ),
            // Re-point the active context to a worktree by re-resolving its path and
            // updating the cached location (WT-006). Worktrees of one repo share a
            // `repoId`, so we guard that the target really belongs to this repo, then
            // persist the choice in the recent list so it survives a cache miss.
            worktreeSwitch: (repoId, path) =>
                Effect.gen(function* () {
                    const repo = yield* resolveRepo(path);
                    if (repo.repoId !== repoId) {
                        return yield* Effect.fail(
                            gitError(
                                'repoUnavailable',
                                'path is not a worktree of this repository',
                            ),
                        );
                    }
                    locations.set(repo.repoId, repo);
                    const name =
                        basename(repo.root) === ''
                            ? repo.root
                            : basename(repo.root);
                    yield* configStore.upsertRecent({
                        path: repo.root,
                        name,
                        repoId: repo.repoId,
                        lastOpenedAt: Date.now(),
                    });
                }),

            // ── stash (P3) ───────────────────────────────────────────────────────
            stashPush: (
                repoId,
                message,
                includeUntracked,
                keepIndex,
                stagedOnly,
            ) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        stashPushGit(
                            repoCwd(repo),
                            {
                                message: message ?? undefined,
                                includeUntracked,
                                keepIndex,
                                stagedOnly,
                            },
                            env,
                        ),
                    ),
                ),
            stashList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    stashListGit(repoCwd(repo), env),
                ),
            stashShow: (repoId, ref) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    stashShowGit(repoCwd(repo), ref, env),
                ),
            stashApply: (repoId, ref) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        stashApplyGit(repoCwd(repo), ref, env),
                    ),
                ),
            stashPop: (repoId, ref) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        stashPopGit(repoCwd(repo), ref, env),
                    ),
                ),
            stashDrop: (repoId, ref) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        stashDropGit(repoCwd(repo), ref, env),
                    ),
                ),
            stashClear: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        stashClearGit(repoCwd(repo), env),
                    ),
                ),

            // ── tags (P3) ────────────────────────────────────────────────────────
            tagList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    tagListGit(repoCwd(repo), env),
                ),
            tagCreate: (repoId, name, target, tagType, message, force) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        tagCreateGit(
                            repoCwd(repo),
                            name,
                            {
                                target,
                                tagType: tagType ?? 'lightweight',
                                message,
                                force,
                            },
                            env,
                        ),
                    ),
                ),
            tagDelete: (repoId, name) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        tagDeleteGit(repoCwd(repo), name, env),
                    ),
                ),
            tagPush: (repoId, remote, name, all) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        tagPushGit(repoCwd(repo), remote, { name, all }, env),
                    ),
                ),
            tagDeleteRemote: (repoId, remote, name) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        tagDeleteRemoteGit(repoCwd(repo), remote, name, env),
                    ),
                ),

            // ── conflicts / sequencer / blame / file history (P4) ───────────────────
            // Remaining stubs land per slice (S3–S7); each compile-completes the
            // interface so `toLayer` stays exhaustive and the gate is green.
            conflictList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    Effect.flatMap(poolFor(repo), pool =>
                        conflictListGit(
                            repoCwd(repo),
                            repo.gitDir,
                            detectInProgress(repo.gitDir),
                            pool,
                            env,
                        ),
                    ),
                ),
            conflictSides: (repoId, path) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    Effect.flatMap(poolFor(repo), pool =>
                        conflictSidesGit(repoCwd(repo), path, pool, env),
                    ),
                ),
            conflictResolve: (repoId, paths, resolution) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        Effect.flatMap(poolFor(repo), pool =>
                            conflictResolveGit(
                                repoCwd(repo),
                                paths,
                                resolution,
                                pool,
                                env,
                            ),
                        ),
                    ),
                ),
            conflictSaveMerged: (repoId, path, content, encoding) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        conflictSaveMergedGit(
                            repoCwd(repo),
                            path,
                            content,
                            encoding,
                            env,
                        ),
                    ),
                ),
            conflictMarkResolved: (repoId, paths) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        conflictMarkResolvedGit(repoCwd(repo), paths, env),
                    ),
                ),
            conflictMarkUnresolved: (repoId, paths) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        conflictMarkUnresolvedGit(repoCwd(repo), paths, env),
                    ),
                ),
            cherryPick: (repoId, commits, recordOrigin, mainline, noCommit) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        Effect.suspend(() =>
                            cherryPickGit(
                                repoCwd(repo),
                                repo.gitDir,
                                detectInProgress(repo.gitDir),
                                commits,
                                { recordOrigin, mainline, noCommit },
                                env,
                            ),
                        ),
                    ),
                ),
            revert: (repoId, commits, mainline, noCommit, message) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        Effect.suspend(() =>
                            revertGit(
                                repoCwd(repo),
                                repo.gitDir,
                                detectInProgress(repo.gitDir),
                                commits,
                                { mainline, noCommit, message },
                                env,
                            ),
                        ),
                    ),
                ),
            opContinue: (repoId, message, allowEmpty) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        Effect.suspend(() =>
                            opContinueGit(
                                repoCwd(repo),
                                repo.gitDir,
                                detectInProgress(repo.gitDir),
                                { message, allowEmpty },
                                env,
                            ),
                        ).pipe(
                            Effect.tap(() => reapRebaseSidecar(repo.gitDir)),
                        ),
                    ),
                ),
            opAbort: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        Effect.suspend(() =>
                            opAbortGit(
                                repoCwd(repo),
                                detectInProgress(repo.gitDir),
                                env,
                            ),
                        ).pipe(
                            Effect.tap(() => reapRebaseSidecar(repo.gitDir)),
                        ),
                    ),
                ),
            opSkip: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        Effect.suspend(() =>
                            opSkipGit(
                                repoCwd(repo),
                                repo.gitDir,
                                detectInProgress(repo.gitDir),
                                env,
                            ),
                        ).pipe(
                            Effect.tap(() => reapRebaseSidecar(repo.gitDir)),
                        ),
                    ),
                ),
            blame: (repoId, path, rev, startLine, endLine, force) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    Effect.flatMap(poolFor(repo), pool =>
                        blameGit(
                            repoCwd(repo),
                            pool,
                            path,
                            { rev, startLine, endLine, force },
                            env,
                        ),
                    ),
                ),
            fileHistory: (repoId, path, limit, cursor, startRev) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    fileHistoryGit(
                        repoCwd(repo),
                        path,
                        { limit, cursor, startRev },
                        env,
                    ),
                ),

            // ── repository maintenance (P5) ─────────────────────────────────────────
            // Hold the per-repo lock for the whole gc run (REQ-P5-GC-003); mid-op state
            // (rebase/merge/bisect) is a UI warn-only concern, not a server block.
            gc: (repoId, aggressive, prune) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        gcGit(repoCwd(repo), aggressive, prune),
                    ),
                ),

            // ── clean working directory (P5) ────────────────────────────────────────
            cleanPreview: (repoId, directories, ignored) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    cleanPreviewGit(repoCwd(repo), directories, ignored),
                ),
            clean: (repoId, paths, directories, ignored) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        cleanGit(repoCwd(repo), paths, directories, ignored),
                    ),
                ),

            // ── archive export (P5) ─────────────────────────────────────────────────
            archivePrepare: (repoId, treeish, format, prefix, subPath) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    archivePrepareGit(
                        repoCwd(repo),
                        repoId,
                        treeish,
                        format,
                        prefix,
                        subPath,
                    ),
                ),
            archiveStream: (repoId, treeish, format, prefix, subPath) =>
                Stream.unwrap(
                    Effect.map(resolveById(repoId), repo =>
                        archiveStreamGit(
                            repoCwd(repo),
                            treeish,
                            format,
                            prefix,
                            subPath,
                        ),
                    ),
                ),

            // ── reflog viewer (P5) ──────────────────────────────────────────────────
            reflogList: (repoId, limit, ref, cursor) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    reflogListGit(repoCwd(repo), limit, ref, cursor, env),
                ),

            // ── bisect (P5) ─────────────────────────────────────────────────────────
            // Mutations hold the repo lock; the idle/in-progress precheck runs inside the
            // git fn (post-lock fs read). Status is a lockless read.
            bisectStart: (repoId, bad, good) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        bisectStartGit(
                            repoCwd(repo),
                            repo.gitDir,
                            bad,
                            good,
                            env,
                        ),
                    ),
                ),
            bisectMark: (repoId, mark) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        bisectMarkGit(repoCwd(repo), repo.gitDir, mark, env),
                    ),
                ),
            bisectReset: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        bisectResetGit(repoCwd(repo), env),
                    ),
                ),
            bisectStatus: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    bisectStatusGit(repoCwd(repo), repo.gitDir, env),
                ),

            // ── submodules (P5) ───────────────────────────────────────────────────
            // List is a lockless read; mutations hold the repo lock. Remove needs the
            // common git dir to clear the cached `modules/<NAME>` (the .gitmodules
            // subsection name, which only equals the path for a default add) after deinit + rm.
            submoduleList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    submoduleListGit(repoCwd(repo), env),
                ),
            submoduleUpdate: (repoId, paths, init, recursive, force) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        submoduleUpdateGit(
                            repoCwd(repo),
                            { paths, init, recursive, force },
                            env,
                        ),
                    ),
                ),
            submoduleSync: (repoId, paths, recursive) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        submoduleSyncGit(
                            repoCwd(repo),
                            { paths, recursive },
                            env,
                        ),
                    ),
                ),
            submoduleAdd: (repoId, url, path, branch) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        submoduleAddGit(repoCwd(repo), url, path, branch, env),
                    ),
                ),
            submoduleRemove: (repoId, path) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        submoduleRemoveGit(
                            repoCwd(repo),
                            repo.commonDir,
                            path,
                            env,
                        ),
                    ),
                ),

            // ── settings & git config (P5) ────────────────────────────────────────
            // Git config: reads are lockless; writes hold the repo lock. App settings
            // go to the host config.json — NOT git, NOT a repo — so NO lock, NO repoId.
            configList: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    configListGit(repoCwd(repo), env),
                ),
            configGet: (repoId, key, configScope) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    configGetGit(repoCwd(repo), key, configScope, env),
                ),
            configSet: (repoId, key, value, configScope) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        configSetGit(
                            repoCwd(repo),
                            key,
                            value,
                            configScope,
                            env,
                        ),
                    ),
                ),
            configUnset: (repoId, key, configScope) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        configUnsetGit(repoCwd(repo), key, configScope, env),
                    ),
                ),
            appSettingsGet: () =>
                Effect.map(configStore.getAppSettings(), toAppSettings),
            appSettingsSet: patch =>
                Effect.map(
                    configStore.setAppSettings({
                        theme: patch.theme,
                        locale: patch.locale,
                        keybindings:
                            patch.keybindings === undefined
                                ? undefined
                                : fromKeyBindings(patch.keybindings),
                    }),
                    toAppSettings,
                ),

            // ── interactive rebase (P5) ───────────────────────────────────────────
            // Plan + status are lockless reads; start scripts `git rebase -i` under the
            // repo lock (it reads its own machine state to classify the outcome).
            rebasePlan: (repoId, upstream, onto) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    rebasePlanGit(repoCwd(repo), upstream, onto, env),
                ),
            rebaseStart: (repoId, upstream, steps, onto) =>
                Effect.flatMap(resolveById(repoId), repo =>
                    locks.withRepoLock(repoId)(
                        rebaseStartGit(
                            repoCwd(repo),
                            repo.gitDir,
                            upstream,
                            steps,
                            onto,
                            env,
                        ),
                    ),
                ),
            rebaseStatus: repoId =>
                Effect.flatMap(resolveById(repoId), repo =>
                    rebaseStatusGit(repoCwd(repo), repo.gitDir, env),
                ),
        };
        return api;
    });

/** A `Layer` providing the live {@link GitEngine}, owning the engine's scope. */
export const gitEngineLayer = (
    opts?: MakeGitEngineOptions,
): Layer.Layer<GitEngine, GitError> =>
    Layer.effect(GitEngine, makeGitEngine(opts));
