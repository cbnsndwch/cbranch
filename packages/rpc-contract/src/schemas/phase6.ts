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

// ─── metaFile.* ────────────────────────────────────────────────────────────────

/**
 * The CLOSED, enumerated set of editable repository metadata files (REQ-P6-META-001).
 * `gitignore`/`gitattributes`/`mailmap` live at the repository root; `info-exclude` is
 * the private `.git/info/exclude` inside the git dir. The set is fixed — this feature is
 * never a general file read/write primitive (REQ-P6-META-004).
 */
export const MetaFile = Schema.Literals([
    'gitignore',
    'gitattributes',
    'mailmap',
    'info-exclude',
]);
export type MetaFile = typeof MetaFile.Type;

/**
 * The current content of a metadata file (REQ-P6-META-002). `exists` is false when the
 * file is not yet on disk (the editor opens empty and creates it on save).
 */
export class MetaFileContent extends Schema.Class<MetaFileContent>(
    'MetaFileContent',
)({
    file: MetaFile,
    exists: Schema.Boolean,
    text: Schema.String,
}) {}
