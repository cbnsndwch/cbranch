// P6 success/payload schemas: completion & repository utilities — repo init, the Git
// command log, repository metadata-file editors, git notes, and patch interchange.
// (docs/spec/17-phase6-completion-and-utilities.md §"RPC contract additions".) Every
// record is a `Schema.Class` so the class name doubles as the exported wire type; closed
// enumerations are `Schema.Literals`. Each P6 feature slice APPENDS its schemas here.
// Reuse `Oid`/`RepoId` from `primitives` rather than re-declaring.

import { Schema } from 'effect';

import { RepoId } from './primitives';

// ─── repo.init ───────────────────────────────────────────────────────────────────

/**
 * The result of `repo.init` (REQ-P6-INIT-001/005): the id of the freshly created
 * repository, already added to the recent list so the client can switch to it.
 */
export class RepoInitResult extends Schema.Class<RepoInitResult>(
    'RepoInitResult',
)({
    repoId: RepoId,
}) {}

// ─── commandLog.* ──────────────────────────────────────────────────────────────

/**
 * One recorded host-`git` invocation for the Git command log (REQ-P6-CLOG-001/002).
 * `argv` is the exact spawned argument vector (never a reconstructed shell string) with
 * credential tokens redacted; `exitCode` is absent when the process was killed;
 * `stderrExcerpt` is a bounded, credential-scrubbed excerpt present only on failure —
 * there is deliberately no stdout/object-byte channel. `seq` is a monotonic id for
 * ordering + keying. The working directory doubles as the repo association for filtering.
 */
export class CommandLogEntry extends Schema.Class<CommandLogEntry>(
    'CommandLogEntry',
)({
    seq: Schema.Number,
    argv: Schema.Array(Schema.String),
    cwd: Schema.String,
    startedAt: Schema.Number,
    durationMs: Schema.Number,
    exitCode: Schema.optional(Schema.Number),
    success: Schema.Boolean,
    stderrExcerpt: Schema.optional(Schema.String),
}) {}
