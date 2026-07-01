// Liveness / invalidation bus types (docs/spec/14-rpc-contract.md §5 / DECISIONS D8).
//
// Liveness is a WS invalidation bus (see 15-sync-protocol.md): the server pushes
// which DOMAINS changed and the client invalidates + refetches the matching queries.
// There are no row-level deltas — only the closed `Domain` set below.

import { Schema } from 'effect';

import { RepoId } from './primitives';

/**
 * The closed set of invalidation domains (14 §5, VERBATIM). Each client query key's
 * `domain` is drawn from this set (CACHE-003); a post-commit invalidation, for
 * example, is `["status", "commits", "refs"]` (DECISIONS D6).
 */
export const Domain = Schema.Literals([
    'refs',
    'status',
    'stash',
    'worktrees',
    'tags',
    'commits',
    'config',
    'inProgress',
]);
export type Domain = typeof Domain.Type;

/**
 * A single push from `repo.subscribe`: the set of domains that changed for a repo
 * (14 §5). The class name doubles as the exported wire type.
 */
export class InvalidationEvent extends Schema.Class<InvalidationEvent>(
    'InvalidationEvent',
)({
    repoId: RepoId,
    domains: Schema.Array(Domain),
}) {}
