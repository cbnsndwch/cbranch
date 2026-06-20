// P3 success schemas: branches, merge, sync, remotes, worktrees, stash, tags.
// (docs/spec/07-phase3-branches-sync.md; DECISIONS D16)

import { Schema } from "effect";

import { Oid } from "./primitives";

// ─── Branch ───────────────────────────────────────────────────────────────────

export class BranchUpstream extends Schema.Class<BranchUpstream>(
  "BranchUpstream",
)({
  ref: Schema.String,
  name: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
}) {}

export class BranchInfo extends Schema.Class<BranchInfo>("BranchInfo")({
  name: Schema.String,
  fullRef: Schema.String,
  tipOid: Oid,
  tipSubject: Schema.String,
  isCurrent: Schema.Boolean,
  upstream: Schema.optional(BranchUpstream),
  isRemote: Schema.Boolean,
  remoteName: Schema.optional(Schema.String),
}) {}

export class BranchListing extends Schema.Class<BranchListing>("BranchListing")(
  {
    localBranches: Schema.Array(BranchInfo),
    remoteBranches: Schema.Array(BranchInfo),
    currentBranch: Schema.optional(Schema.String),
    detachedHead: Schema.optional(Oid),
  },
) {}

export const BranchSwitchStrategy = Schema.Literals([
  "carry",
  "stash",
  "discard",
]);
export type BranchSwitchStrategy = typeof BranchSwitchStrategy.Type;

// ─── Merge ────────────────────────────────────────────────────────────────────

export const MergeMode = Schema.Literals(["ff", "ff-only", "no-ff", "squash"]);
export type MergeMode = typeof MergeMode.Type;

export const MergeResultMode = Schema.Literals([
  "fastForward",
  "merge",
  "squash",
  "alreadyUpToDate",
]);
export type MergeResultMode = typeof MergeResultMode.Type;

export class MergeResult extends Schema.Class<MergeResult>("MergeResult")({
  mode: MergeResultMode,
  commitOid: Schema.optional(Oid),
  newTipOid: Schema.optional(Oid),
  staged: Schema.optional(Schema.Boolean),
}) {}

// ─── Sync (streaming) ─────────────────────────────────────────────────────────

export class SyncProgressEvent extends Schema.Class<SyncProgressEvent>(
  "SyncProgressEvent",
)({
  _tag: Schema.Literal("progress"),
  text: Schema.String,
}) {}

export class SyncRefUpdate extends Schema.Class<SyncRefUpdate>("SyncRefUpdate")(
  {
    _tag: Schema.Literal("refUpdate"),
    summary: Schema.String,
    localRef: Schema.String,
    remoteRef: Schema.String,
    fromOid: Schema.optional(Oid),
    toOid: Schema.optional(Oid),
  },
) {}

export const SyncEvent = Schema.Union([SyncProgressEvent, SyncRefUpdate]);
export type SyncEvent = typeof SyncEvent.Type;

// ─── Remote ───────────────────────────────────────────────────────────────────

export class RemoteInfo extends Schema.Class<RemoteInfo>("RemoteInfo")({
  name: Schema.String,
  fetchUrl: Schema.String,
  pushUrl: Schema.optional(Schema.String),
}) {}

// ─── Worktree ─────────────────────────────────────────────────────────────────

export class WorktreeInfo extends Schema.Class<WorktreeInfo>("WorktreeInfo")({
  path: Schema.String,
  headOid: Schema.optional(Oid),
  branch: Schema.optional(Schema.String),
  isMain: Schema.Boolean,
  isBare: Schema.Boolean,
  isDetached: Schema.Boolean,
  isLocked: Schema.Boolean,
  isPrunable: Schema.Boolean,
  lockReason: Schema.optional(Schema.String),
  prunableReason: Schema.optional(Schema.String),
}) {}

// ─── Stash ────────────────────────────────────────────────────────────────────

export class StashEntry extends Schema.Class<StashEntry>("StashEntry")({
  index: Schema.Number,
  ref: Schema.String,
  message: Schema.String,
  branch: Schema.String,
  headOid: Oid,
  subject: Schema.String,
}) {}

// ─── Tag ──────────────────────────────────────────────────────────────────────

export const TagType = Schema.Literals(["lightweight", "annotated", "signed"]);
export type TagType = typeof TagType.Type;

export class TagInfo extends Schema.Class<TagInfo>("TagInfo")({
  name: Schema.String,
  fullRef: Schema.String,
  objectOid: Oid,
  targetOid: Oid,
  isAnnotated: Schema.Boolean,
  taggerName: Schema.optional(Schema.String),
  taggerEmail: Schema.optional(Schema.String),
  taggerDate: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
}) {}
