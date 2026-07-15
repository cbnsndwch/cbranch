// @cbranch/rpc-contract — the single, transport-agnostic source of truth for the
// cbranch RPC surface: the `@effect/rpc` method catalog (`CbranchRpcs`), every
// payload/success Schema, and the canonical `GitError` union. Imported UNCHANGED by
// both the server (apps/web-server) and the client (packages/ui) — this *is* the
// "single contract" guarantee (14 §2).
//
// This package exports ONLY the group + Schemas. Transport layers live in the apps;
// every `effect/unstable/*` symbol stays quarantined in ./effect-rpc-adapter.ts,
// reachable by consumers via the "@cbranch/rpc-contract/effect-rpc-adapter" subpath
// (DECISIONS D3/D10). It is intentionally NOT re-exported here.

// Primitives: branded scalar ids (value + inferred type).
export * from './schemas/primitives';

// Canonical error model: GitErrorCode (closed union) + the single GitError class.
export * from './schemas/errors';

// Connection bootstrap: protocol/version/capability handshake.
export * from './schemas/system';

// Liveness: the Domain invalidation set + InvalidationEvent.
export * from './schemas/live';

// Query payloads: LogQuery, DiffSpec.
export * from './schemas/queries';

// Domain / authored P1 success Schemas (Signature, CommitSummary, CommitDetail,
// CommitTree, RepoState, RepoHandle, RecentRepo, ChangeCode, DiffLine, Hunk, DiffFile,
// FileContent, DownloadDescriptor, FileContentResult).
export * from './schemas/domain';

// P2 working-tree (stage & commit) Schemas: StatusEntry, StatusBranch,
// WorkingTreeStatus, HunkSelection, PatchSelection, CommitInput, CommitCreated,
// CommitMessage.
export * from './schemas/working-tree';

// P3 branch/sync/remote/worktree/stash/tag Schemas.
export * from './schemas/branches';

// P4 conflict / sequencer / blame / file-history Schemas.
export * from './schemas/phase4';

// P5 power-feature Schemas: gc / clean / archive / reflog / bisect / submodules /
// settings-config / interactive-rebase (each slice appends; D18).
export * from './schemas/phase5';

// P6 completion & utilities Schemas: repo init / command log / metadata files / notes /
// patch interchange (each slice appends).
export * from './schemas/phase6';

// Multi-repository consulting workspaces: engagement partitions + open-repo sessions.
export * from './schemas/engagements';

// Host-bounded filesystem exploration for repository/folder pickers.
export * from './schemas/filesystem';

// Host-credential forge metadata (GitHub PR list; no credential fields).
export * from './schemas/forge';

// Plugin payload/result Schemas are authored in the transport-neutral plugin contract;
// re-export the status Schema used by the existing RPC facade.
export { PluginRuntimeStatus } from '@cbranch/plugin-contract';
export type { PluginRuntimeStatus as PluginRuntimeStatusType } from '@cbranch/plugin-contract';

// The P1 method catalog.
export * from './rpc/group';

// --- P0 compatibility bridge (do NOT extend) ---
// The P0 scaffolds in @cbranch/core, @cbranch/web-server and @cbranch/vscode-ext
// reference these placeholders to have a compiling cross-package import before the
// real contract existed. Kept so those packages compile UNCHANGED; remove once they
// import the real Schemas/group above.
export const version = '0.0.0' as const;

/** @deprecated P0 placeholder; superseded by the real Schemas + `CbranchRpcs`. */
export type RpcContractPlaceholder = {
    readonly version: typeof version;
};
