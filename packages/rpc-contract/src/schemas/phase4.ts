// P4 success schemas: conflicts, cherry-pick/revert sequencer, blame, file history.
// (docs/spec/08-phase4-cherrypick-conflicts.md + 11-conflict-merge-kdiff3.md;
// DECISIONS D17.) Every record is a `Schema.Class` so the class name doubles as the
// exported wire type; closed enumerations are `Schema.Literals`.

import { Schema } from "effect";

import { ChangeCode } from "./domain";
import { Oid } from "./primitives";

// ─── Closed unions ──────────────────────────────────────────────────────────────

/**
 * The conflict class derived from which index stages are present for a path
 * (stage 1 = base, 2 = ours, 3 = theirs); see REQ-CN-002 / REQ-CONFLICT-002.
 */
export const ConflictClassification = Schema.Literals([
  "bothModified",
  "bothAdded",
  "bothDeleted",
  "addedByUs",
  "addedByThem",
  "deletedByUs",
  "deletedByThem",
]);
export type ConflictClassification = typeof ConflictClassification.Type;

/** A whole-file resolution choice (REQ-CN-004 / REQ-WHOLE-030/031). */
export const ConflictResolution = Schema.Literals([
  "ours",
  "theirs",
  "base",
  "keepFile",
  "deleteFile",
]);
export type ConflictResolution = typeof ConflictResolution.Type;

/** Transport encoding for blob content (mirrors {@link FileContent} `encoding`). */
export const ContentEncoding = Schema.Literals(["utf8", "base64"]);
export type ContentEncoding = typeof ContentEncoding.Type;

/**
 * The in-progress operation kind (mirrors {@link RepoState} `inProgress`), used to
 * route the continue/abort/skip verb set (REQ-CN-001).
 */
export const OperationKind = Schema.Literals([
  "none",
  "merge",
  "rebase",
  "cherryPick",
  "revert",
  "am",
  "bisect",
]);
export type OperationKind = typeof OperationKind.Type;

/** The non-error result of a cherry-pick / revert / continuation step (D17). */
export const SequencerOutcome = Schema.Literals([
  "completed",
  "staged",
  "conflicts",
  "empty",
]);
export type SequencerOutcome = typeof SequencerOutcome.Type;

// ─── Conflict enumeration ───────────────────────────────────────────────────────

export class ConflictFile extends Schema.Class<ConflictFile>("ConflictFile")({
  path: Schema.String,
  classification: ConflictClassification,
  hasBase: Schema.Boolean,
  hasOurs: Schema.Boolean,
  hasTheirs: Schema.Boolean,
  isBinary: Schema.Boolean,
  isSubmodule: Schema.Boolean,
}) {}

export class OperationProgress extends Schema.Class<OperationProgress>(
  "OperationProgress",
)({
  current: Schema.Number,
  total: Schema.Number,
  currentOid: Schema.optional(Oid),
  currentSubject: Schema.optional(Schema.String),
}) {}

export class ConflictListing extends Schema.Class<ConflictListing>(
  "ConflictListing",
)({
  operation: OperationKind,
  progress: Schema.optional(OperationProgress),
  conflicted: Schema.Array(ConflictFile),
  // The authoritative still-conflicted count (= conflicted.length). "Resolved" is
  // relative to the operation's initial set, which only the client tracks, so it is
  // derived there (initial − stillConflicted), not reported here.
  conflictedCount: Schema.Number,
  // canContinue = kind ∈ {merge,rebase,cherryPick,revert} && conflictedCount == 0;
  // canSkip = kind == rebase (am/bisect/none → both false; Phase-5 surface).
  canContinue: Schema.Boolean,
  canSkip: Schema.Boolean,
}) {}

// ─── Three sides + merged seed (merge editor / kdiff3) ──────────────────────────

export class ConflictStage extends Schema.Class<ConflictStage>("ConflictStage")(
  {
    present: Schema.Boolean,
    isBinary: Schema.Boolean,
    encoding: ContentEncoding,
    content: Schema.String,
    oid: Schema.optional(Oid),
    size: Schema.Number,
  },
) {}

export class ConflictSides extends Schema.Class<ConflictSides>("ConflictSides")(
  {
    path: Schema.String,
    classification: ConflictClassification,
    isBinary: Schema.Boolean,
    isSubmodule: Schema.Boolean,
    base: ConflictStage,
    ours: ConflictStage,
    theirs: ConflictStage,
    // The working-tree bytes git wrote = the editor's Result seed (REQ-MERGE-015).
    merged: ConflictStage,
    mergeable: Schema.Boolean,
    reason: Schema.optional(
      Schema.Literals(["binary", "oversize", "submodule"]),
    ),
  },
) {}

// ─── Cherry-pick / revert / continuation result ─────────────────────────────────

export class SequencerResult extends Schema.Class<SequencerResult>(
  "SequencerResult",
)({
  outcome: SequencerOutcome,
  operation: OperationKind,
  committed: Schema.Number,
  newCommitOid: Schema.optional(Oid),
  // The stop/empty offender on a partially-applied range (conflicts/empty outcome).
  currentOid: Schema.optional(Oid),
  currentSubject: Schema.optional(Schema.String),
}) {}

// ─── Blame ──────────────────────────────────────────────────────────────────────

export class BlameCommit extends Schema.Class<BlameCommit>("BlameCommit")({
  oid: Oid,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authorTime: Schema.Number,
  authorTzMinutes: Schema.Number,
  summary: Schema.String,
  filename: Schema.String,
  previousOid: Schema.optional(Oid),
  previousPath: Schema.optional(Schema.String),
}) {}

export class BlameLine extends Schema.Class<BlameLine>("BlameLine")({
  ownerOid: Oid,
  finalLineNo: Schema.Number,
  origLineNo: Schema.Number,
  content: Schema.String,
}) {}

export class BlameData extends Schema.Class<BlameData>("BlameData")({
  path: Schema.String,
  rev: Schema.String,
  commits: Schema.Array(BlameCommit),
  lines: Schema.Array(BlameLine),
}) {}

export class BlameTooLarge extends Schema.Class<BlameTooLarge>("BlameTooLarge")(
  {
    path: Schema.String,
    rev: Schema.String,
    byteSize: Schema.Number,
    lineCount: Schema.Number,
  },
) {}

/**
 * The `blame` result: inline {@link BlameData} or a {@link BlameTooLarge} cap arm
 * (REQ-EDGE-010). The two are disjoint on required fields (`lines`/`commits` vs
 * `byteSize`), so the union decodes unambiguously (mirrors {@link FileContentResult}).
 */
export const BlameResult = Schema.Union([BlameData, BlameTooLarge]);
export type BlameResult = typeof BlameResult.Type;

// ─── File history ───────────────────────────────────────────────────────────────

export class FileHistoryEntry extends Schema.Class<FileHistoryEntry>(
  "FileHistoryEntry",
)({
  oid: Oid,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authorDate: Schema.String,
  subject: Schema.String,
  path: Schema.String,
  status: ChangeCode,
  // Set on a `--follow` rename row, with the numeric R<score>/C<score>.
  oldPath: Schema.optional(Schema.String),
  renameScore: Schema.optional(Schema.Number),
}) {}

export class FileHistoryPage extends Schema.Class<FileHistoryPage>(
  "FileHistoryPage",
)({
  entries: Schema.Array(FileHistoryEntry),
  nextCursor: Schema.optional(Schema.String),
}) {}
