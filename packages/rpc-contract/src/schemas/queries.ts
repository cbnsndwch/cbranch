// Query / request payload Schemas (docs/spec/14-rpc-contract.md §5, VERBATIM fields).
//
// These are the typed payloads for the history feed and diff requests. Optionals are
// present-with-value or absent (no `undefined`-only distinctions — DM-003); the class
// name doubles as the exported wire type.

import { Schema } from 'effect';

import { RepoId } from './primitives';

/**
 * The single history-feed query (`log.stream`, 14 §5/§6).
 *
 * Ordering is FIXED server-side at `--topo-order --date-order` (so every parent
 * sorts below its child); it is not a client option. `cursor` is an opaque server
 * token for resumable windows; `limit` is server-bounded.
 */
export class LogQuery extends Schema.Class<LogQuery>('LogQuery')({
    repoId: RepoId,
    cursor: Schema.optional(Schema.String),
    limit: Schema.Number,
    refScope: Schema.optional(Schema.Literals(['all', 'current', 'pattern'])),
    refPattern: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    author: Schema.optional(Schema.String),
    grep: Schema.optional(Schema.String),
    since: Schema.optional(Schema.String),
    until: Schema.optional(Schema.String),
}) {}

/**
 * A diff request for a commit or range (`commit.diff`, 14 §5).
 */
export class DiffSpec extends Schema.Class<DiffSpec>('DiffSpec')({
    repoId: RepoId,
    target: Schema.String,
    base: Schema.optional(Schema.String),
    paths: Schema.optional(Schema.Array(Schema.String)),
    cached: Schema.Boolean,
    whitespace: Schema.Literals(['show', 'ignore-all', 'ignore-change']),
    context: Schema.Number,
    renames: Schema.Boolean,
    combined: Schema.Boolean,
}) {}
