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

import { type GitError, type RepoId } from "@cbranch/rpc-contract";
import { RepoHandle } from "@cbranch/rpc-contract";
import { Effect, Layer, Scope, Stream } from "effect";

import { type ConfigStore, makeConfigStore } from "../config/config-store";
import { type CatFilePool, makeCatFilePool } from "../git/cat-file-pool";
import { gitError } from "../git/errors";
import { detectGitVersion } from "../git/version";
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

const coreB = (method: string): GitError => gitError("gitFailed", `${method} is not implemented yet (core-B)`);

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
    const locations = new Map<string, ResolvedRepo>();
    const pools = new Map<string, CatFilePool>();

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

      // core-B stubs (typed; complete interface; bodies filled by core-B).
      subscribe: () => Stream.fail(coreB("repo.subscribe")),
      logStream: () => Stream.fail(coreB("log.stream")),
      commitDetail: () => Effect.fail(coreB("commit.detail")),
      commitDiff: () => Effect.fail(coreB("commit.diff")),
      diffWorkingFile: () => Effect.fail(coreB("diff.workingFile")),
      fileContentAtRev: () => Effect.fail(coreB("file.contentAtRev")),

      // Object-read infra (implemented now; consumed by core-B's history/diff/content).
      readObject: (repoId, rev) =>
        Effect.flatMap(resolveById(repoId), (repo) => Effect.flatMap(poolFor(repo), (p) => p.readObject(rev))),
      objectInfo: (repoId, rev) =>
        Effect.flatMap(resolveById(repoId), (repo) => Effect.flatMap(poolFor(repo), (p) => p.objectInfo(rev))),
    };
    return api;
  });

/** A `Layer` providing the live {@link GitEngine}, owning the engine's scope. */
export const gitEngineLayer = (opts?: MakeGitEngineOptions): Layer.Layer<GitEngine, GitError> =>
  Layer.effect(GitEngine, makeGitEngine(opts));
