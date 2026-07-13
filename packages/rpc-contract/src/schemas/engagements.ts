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

/** URL-safe, user-editable workspace handle. Unique within one cbranch config. */
export const EngagementSlug = Schema.String.pipe(
    Schema.brand('cbranch/EngagementSlug'),
);
export type EngagementSlug = typeof EngagementSlug.Type;

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

/** A repository found directly below a host-selected workspace import directory. */
export class EngagementDirectoryCandidate extends Schema.Class<EngagementDirectoryCandidate>(
    'EngagementDirectoryCandidate',
)({
    name: Schema.String,
    root: Schema.String,
    repoId: RepoId,
}) {}

/** Bounded, shallow repository discovery for a workspace directory import. */
export class EngagementDirectoryPreview extends Schema.Class<EngagementDirectoryPreview>(
    'EngagementDirectoryPreview',
)({
    path: Schema.String,
    candidates: Schema.Array(EngagementDirectoryCandidate),
    truncated: Schema.Boolean,
}) {}

/** Add discovered repositories to an existing workspace. */
export const ExistingEngagementDirectoryImportTarget = Schema.Struct({
    kind: Schema.Literal('existing'),
    engagementId: EngagementId,
});
export type ExistingEngagementDirectoryImportTarget =
    typeof ExistingEngagementDirectoryImportTarget.Type;

/** Create a workspace and add the discovered repositories to it. */
export const NewEngagementDirectoryImportTarget = Schema.Struct({
    kind: Schema.Literal('new'),
    name: Schema.String,
    color: EngagementColor,
    slug: Schema.optional(EngagementSlug),
});
export type NewEngagementDirectoryImportTarget =
    typeof NewEngagementDirectoryImportTarget.Type;

export const EngagementDirectoryImportTarget = Schema.Union([
    ExistingEngagementDirectoryImportTarget,
    NewEngagementDirectoryImportTarget,
]);
export type EngagementDirectoryImportTarget =
    typeof EngagementDirectoryImportTarget.Type;

/**
 * One engagement and its isolated repository session. `repositories` is authoritative
 * membership. `openRepoIds` is ordered like the tab strip and is always a subset of it;
 * `activeRepoId`, when present, is always one of the open repositories.
 */
export class Engagement extends Schema.Class<Engagement>('Engagement')({
    id: EngagementId,
    name: Schema.String,
    slug: EngagementSlug,
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
