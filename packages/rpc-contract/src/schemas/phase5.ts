// P5 success schemas: power features — repository maintenance (gc), clean, archive,
// reflog, bisect, submodules, settings/config, interactive rebase.
// (docs/spec/09-phase5-power.md; DECISIONS D18.) Every record is a `Schema.Class` so
// the class name doubles as the exported wire type; closed enumerations are
// `Schema.Literals`. Each P5 feature slice APPENDS its schemas to this one file — one
// consolidated set, no duplication (D18); reuse `Oid`/`RepoId` from `primitives` and
// `CommitSummary` from `domain` rather than re-declaring.

import { Schema } from "effect";

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
