// Engagement workspace schemas. Engagements are app-level partitions over repositories:
// they never change git data, but they persist which repositories belong together and
// which of those repositories are open in the engagement's current browser session.

import { Schema } from 'effect';

import { RecentRepo } from './domain';
import { PullRequestChangeSet } from './forge';
import { RepoId } from './primitives';

/** Stable identity for a consulting engagement in the host cbranch config. */
export const EngagementId = Schema.String.pipe(
    Schema.brand('cbranch/EngagementId'),
);
export type EngagementId = typeof EngagementId.Type;

/** Small, closed swatch set used to distinguish engagements in the workspace rail. */
export const EngagementColor = Schema.Literals([
    'teal',
    'blue',
    'violet',
    'amber',
    'rose',
    'slate',
]);
export type EngagementColor = typeof EngagementColor.Type;

/**
 * One engagement and its isolated repository session. `repositories` is authoritative
 * membership. `openRepoIds` is ordered like the tab strip and is always a subset of it;
 * `activeRepoId`, when present, is always one of the open repositories.
 */
export class Engagement extends Schema.Class<Engagement>('Engagement')({
    id: EngagementId,
    name: Schema.String,
    color: EngagementColor,
    avatarUrl: Schema.optional(Schema.String),
    repositories: Schema.Array(RecentRepo),
    openRepoIds: Schema.Array(RepoId),
    activeRepoId: Schema.optional(RepoId),
    changeSets: Schema.Array(PullRequestChangeSet),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
}) {}

/**
 * Complete app-level workspace snapshot. Repositories that have not yet been assigned to
 * an engagement remain available explicitly, but never leak into an engagement overview.
 */
export class EngagementWorkspace extends Schema.Class<EngagementWorkspace>(
    'EngagementWorkspace',
)({
    engagements: Schema.Array(Engagement),
    activeEngagementId: Schema.optional(EngagementId),
    unassignedRepositories: Schema.Array(RecentRepo),
}) {}
