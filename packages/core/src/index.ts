// @cbranch/core — transport-agnostic Git orchestration (the GitEngine).
//
// The single entry point for all Git behavior (REQ-ARCH-010): a host-`git` backend
// behind the `GitEngine` Context service. Transport-agnostic (REQ-ARCH-002): no HTTP/
// WS/webview symbols here. Depends on @cbranch/rpc-contract for TYPES (REQ-ARCH-007).
//
// P1 (core-A) implements the read-only `repo.*` surface + the host-git infrastructure
// (runGit, error classifier, cat-file pool, repoId, version gate, lock registry,
// config store) + the fixture harness. History/diff/content + the fs watcher are
// core-B and land as typed stubs on the same interface.

// ── the engine ───────────────────────────────────────────────────────────────
export { GitEngine, type GitEngineApi } from "./engine/git-engine";
export { gitEngineLayer, makeGitEngine, type MakeGitEngineOptions } from "./engine/live";

// ── host-git execution infrastructure ──────────────────────────────────────────
export {
  assertNoLeadingDash,
  decodeUtf8,
  type GitResult,
  isHexOid,
  nonInteractiveEnv,
  runGit,
  runGitOk,
  type RunGitOptions,
} from "./git/run-git";
export {
  classifyExit,
  classifyGitSpawnError,
  classifyNodeError,
  gitError,
  gitStderrExcerpt,
  scrubSecrets,
} from "./git/errors";
export {
  atLeast,
  detectGitVersion,
  type GitVersion,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
  parseGitVersion,
} from "./git/version";
export { computeRepoId, isRepoId, normalizeAbsolute } from "./git/repo-id";
export { makeRepoLockRegistry, type RepoLockRegistry } from "./git/locks";
export { type CatFilePool, makeCatFilePool, type ObjectData, type ObjectInfo } from "./git/cat-file-pool";

// ── config store ───────────────────────────────────────────────────────────────
export {
  type Config,
  CONFIG_VERSION,
  type ConfigStore,
  defaultConfig,
  DEFAULT_BIND,
  DEFAULT_THRESHOLDS,
  makeConfigStore,
  type RecentRepoEntry,
  resolveConfigPath,
} from "./config/config-store";

// ── repository operations (parsers + resolvers reused by core-B) ────────────────
export { repoCwd, type ResolvedRepo, resolveRepo } from "./repo/resolve";
export { detectInProgress, parseBranchHeader, readRepoState } from "./repo/state";

// ── test-only fixture harness (NF-TEST-3/4) ────────────────────────────────────
export * from "./testing/fixtures";
export { run, runExit, runScoped, runScopedExit } from "./testing/effect-run";

// ── P0 compatibility bridge (kept so apps/web-server compiles UNCHANGED) ─────────
// The P0 scaffold in apps/web-server references `GitEnginePlaceholder["version"]`.
// Kept here (now with NO dependency on the rpc-contract placeholder) until that app
// migrates to the real `GitEngine`.
export const version = "0.0.0" as const;

/** @deprecated P0 placeholder; superseded by the real {@link GitEngine}. */
export type GitEnginePlaceholder = {
  readonly version: typeof version;
};
