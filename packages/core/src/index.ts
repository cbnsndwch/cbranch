// @cbranch/core — transport-agnostic Git orchestration (the GitEngine).
//
// P0 scaffold only. The host-git backend (child_process, cat-file --batch pool,
// --no-optional-locks reads, repoId hashing, per-repoId Effect.Semaphore(1)) lands
// in P1 (see docs/spec/02-architecture.md, 05-phase1-browse.md).
//
// Dependency direction (REQ-ARCH-007): core depends on @cbranch/rpc-contract for
// TYPES ONLY — note the `import type` below.

import type { RpcContractPlaceholder } from "@cbranch/rpc-contract";

export const version = "0.0.0" as const;

/** Placeholder for the GitEngine interface; realized in P1. */
export type GitEnginePlaceholder = {
  readonly version: typeof version;
  readonly contract: RpcContractPlaceholder["version"];
};
