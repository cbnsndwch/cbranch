// Domain primitives (docs/spec/14-rpc-contract.md §5 / DECISIONS D8).
//
// Branded scalar identifiers shared by every payload/success Schema. `effect/Schema`
// is on Effect's STABLE track, so it is imported directly (NOT through the unstable
// adapter — that quarantine is only for `effect/unstable/*`; see DECISIONS D10).

import { Schema } from 'effect';

/**
 * A Git object id (`repo.open` HEAD, commit oids, tree/blob oids, …).
 *
 * Branded `string` holding the full hexadecimal object name. The contract MUST NOT
 * assume a fixed length: 40 hex chars in a SHA-1 repository, 64 in a SHA-256 one
 * (DM-001 / 14 §5). Kept as a plain branded string — exactly verbatim per 14 §5 —
 * so both widths (and short oids handed back from git) round-trip unchanged.
 */
export const Oid = Schema.String.pipe(Schema.brand('Oid'));
export type Oid = typeof Oid.Type;

/**
 * A repository identity (14 §3.5 / DECISIONS D2): a stable hash of the repository's
 * resolved common git directory, so sibling worktrees of one repository share a
 * single `RepoId` (and thus one mutation lock and one set of synced collections).
 * The contract treats it as an opaque branded `string`.
 */
export const RepoId = Schema.String.pipe(Schema.brand('RepoId'));
export type RepoId = typeof RepoId.Type;
