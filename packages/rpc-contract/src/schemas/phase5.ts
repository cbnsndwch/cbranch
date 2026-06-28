// P5 success schemas: power features — repository maintenance (gc), clean, archive,
// reflog, bisect, submodules, settings/config, interactive rebase.
// (docs/spec/09-phase5-power.md; DECISIONS D18.) Every record is a `Schema.Class` so
// the class name doubles as the exported wire type; closed enumerations are
// `Schema.Literals`. Each P5 feature slice APPENDS its schemas to this one file — one
// consolidated set, no duplication (D18); reuse `Oid`/`RepoId` from `primitives` and
// `CommitSummary` from `domain` rather than re-declaring.

import { Schema } from "effect";

import { CommitSummary } from "./domain";
import { Oid } from "./primitives";

// ─── S1: repository maintenance (gc) ─────────────────────────────────────────────

/**
 * The `git gc` prune behavior (REQ-P5-GC-002). `"now"` maps to `--prune=now` (a
 * deliberate Select opt-in); `"default"` omits `--prune`, keeping git's default
 * expiry. gc removes no tracked content, so neither needs an extra confirmation.
 */
export const GcPrune = Schema.Literals(["default", "now"]);
export type GcPrune = typeof GcPrune.Type;

/**
 * The captured output of a `git gc` run (REQ-P5-GC-003). Both fields are the host
 * git stdout/stderr surfaced for DISPLAY only — never parsed for control flow (a
 * non-zero exit is the authoritative failure, mapped to `gitFailed`).
 */
export class GcResult extends Schema.Class<GcResult>("GcResult")({
  stdout: Schema.String,
  stderr: Schema.String,
}) {}

// ─── S2: clean working directory ─────────────────────────────────────────────────

/**
 * One entry git would remove (REQ-P5-CL-001). `isDirectory` is derived from git's
 * trailing `/`, which the `path` retains so the destructive run can pass it back as a
 * pathspec unchanged.
 */
export class CleanEntry extends Schema.Class<CleanEntry>("CleanEntry")({
  path: Schema.String,
  isDirectory: Schema.Boolean,
}) {}

/** The dry-run preview: exactly what a clean with the same options would remove. */
export class CleanPreview extends Schema.Class<CleanPreview>("CleanPreview")({
  entries: Schema.Array(CleanEntry),
}) {}

/** The destructive clean outcome: the count of previewed entries removed (REQ-P5-CL-005). */
export class CleanResult extends Schema.Class<CleanResult>("CleanResult")({
  removed: Schema.Number,
}) {}

// ─── S3: archive export ──────────────────────────────────────────────────────────

/** A host-git archive format (REQ-P5-AR-002). `tar.gz` is the supported compressed tar. */
export const ArchiveFormat = Schema.Literals(["zip", "tar", "tar.gz"]);
export type ArchiveFormat = typeof ArchiveFormat.Type;

/**
 * A server-minted pointer to a streamed archive download (REQ-P5-AR-004). A sibling of
 * {@link DownloadDescriptor} but **without `size`** — an archive's byte length is
 * unknowable before it streams (D18); the UI reports the size from the downloaded blob.
 * The bytes travel over the HTTP side-channel (`GET /sidechannel/archive`), never the
 * WS/NDJSON bus.
 */
export class ArchiveDescriptor extends Schema.Class<ArchiveDescriptor>(
  "ArchiveDescriptor",
)({
  url: Schema.String,
  filename: Schema.String,
  contentType: Schema.String,
  format: ArchiveFormat,
}) {}

// ─── S4: reflog viewer ───────────────────────────────────────────────────────────

/**
 * One reflog entry (REQ-P5-RL-001). `action` is the `%gs` label before the first `:`
 * (kept an OPEN `Schema.String` — reflog action tokens drift across git versions);
 * `message` is the remainder. `oid` is the entry's RESOLVED commit (writes target it,
 * not `HEAD@{n}`, to dodge the prune/expire reparse race).
 */
export class ReflogEntry extends Schema.Class<ReflogEntry>("ReflogEntry")({
  selector: Schema.String,
  oid: Oid,
  action: Schema.String,
  message: Schema.String,
}) {}

/** A reflog page; `nextCursor` reuses the history skip-cursor codec (present iff a full window). */
export class ReflogPage extends Schema.Class<ReflogPage>("ReflogPage")({
  entries: Schema.Array(ReflogEntry),
  nextCursor: Schema.optional(Schema.String),
}) {}

// ─── S5: bisect ──────────────────────────────────────────────────────────────────

/** A bisect mark verb (REQ-P5-BS-003). Custom terms are out of scope. */
export const BisectMark = Schema.Literals(["good", "bad", "skip"]);
export type BisectMark = typeof BisectMark.Type;

/**
 * The bisect session state — DATA, not error codes: `concluded` (first-bad found) and
 * `unbisectable` (skips can't isolate) are non-error outcomes carried here (D18).
 */
export const BisectState = Schema.Literals([
  "inactive",
  "bisecting",
  "concluded",
  "unbisectable",
]);
export type BisectState = typeof BisectState.Type;

/**
 * Machine-derived bisect status (REQ-P5-BS-002/004). `current`/`firstBad` reuse
 * {@link CommitSummary} (no new commit schema). `revisionsRemaining`/`stepsRemaining` are
 * git's reported estimates; `candidates` is the ambiguous remaining set when
 * `unbisectable`; `startPoint` is the original HEAD restored on reset.
 */
export class BisectStatus extends Schema.Class<BisectStatus>("BisectStatus")({
  state: BisectState,
  current: Schema.optional(CommitSummary),
  badTerm: Schema.String,
  goodTerm: Schema.String,
  revisionsRemaining: Schema.optional(Schema.Number),
  stepsRemaining: Schema.optional(Schema.Number),
  firstBad: Schema.optional(CommitSummary),
  candidates: Schema.optional(Schema.Array(Oid)),
  startPoint: Schema.optional(Schema.String),
}) {}
