// Canonical error model (docs/spec/14-rpc-contract.md §4 / DECISIONS D8).
//
// ONE tagged-error class — `"GitError"` — whose `code` field is the single closed
// union of every failure code. This is the sole error type crossing the wire;
// there is no separate `EngineError` (closes audit blocker #3). Streaming RPCs put
// the same `GitError` on their per-item error channel (the top-level error becomes
// `Never` under `stream: true`, per 14 §4).

import { Schema } from "effect";

/**
 * The closed set of failure codes carried by {@link GitError.code} (14 §4, VERBATIM).
 * Grouped exactly as the spec groups them; the order is not significant but the
 * 23 string literals are reproduced verbatim and must not drift.
 */
export const GitErrorCode = Schema.Literals([
  // process / environment
  "hostGitMissing",
  "hostGitTooOld",
  "gitFailed",
  "fsError",
  "permissionDenied",
  "repoUnavailable",
  // concurrency / lifecycle
  "repoLocked",
  "lockTimeout",
  "cancelled",
  // domain
  "repoNotFound",
  "notARepository",
  "dirtyWorkingTree",
  "nonFastForward",
  "mergeConflict",
  "hookRejected",
  "authRequired",
  "authFailed",
  "networkError",
  "refExists",
  "invalidRefName",
  "emptyOrAlreadyApplied",
  "detachedHead",
  "unsupportedRepoShape",
]);
export type GitErrorCode = typeof GitErrorCode.Type;

/**
 * The canonical, single tagged error union (14 §4).
 *
 * `_tag` (`"GitError"`) is auto-injected by `Schema.TaggedErrorClass` (the v4 name —
 * `Schema.TaggedError` does NOT exist at this pin). `detail` carries optional,
 * per-code structured extras (e.g. conflicting paths, the rejected ref); any stderr
 * excerpt placed there MUST be credential-scrubbed (DM-072 / RPC-031).
 *
 * `repo.open` is logically narrower (repoNotFound | notARepository | fsError) but
 * still uses this single class; the narrowing is documented at the method, not
 * modeled as a second error type (DECISIONS D7).
 */
export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  code: GitErrorCode,
  message: Schema.String,
  detail: Schema.optional(Schema.Unknown),
}) {}
