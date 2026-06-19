// @cbranch/rpc-contract — typed RPC surface (single source of truth).
//
// P0 scaffold only: a compiling placeholder. The real `RpcGroup` method catalog,
// payload/success Schemas, the canonical `GitError` union, and the
// `InvalidationEvent`/`Domain` schema land in P1 (see docs/spec/14-rpc-contract.md).
//
// MANDATORY quarantine rule (REQ-STACK-023 / D10): every `effect/unstable/*` import
// is confined to ./effect-rpc-adapter.ts — do NOT import unstable Effect modules
// anywhere else in this package.

export const version = "0.0.0" as const;

/** Placeholder contract shape; replaced by the authored Schemas in P1. */
export type RpcContractPlaceholder = {
  readonly version: typeof version;
};
