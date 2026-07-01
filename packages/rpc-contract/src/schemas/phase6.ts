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
