// Forge integration schemas. Credentials never cross this contract; the host adapter uses
// the operator's existing CLI login and returns only repository/PR metadata.

import { Schema } from 'effect';

import { Oid, RepoId } from './primitives';

export const PullRequestListState = Schema.Literals([
    'open',
    'closed',
    'merged',
    'all',
]);
export type PullRequestListState = typeof PullRequestListState.Type;

export const PullRequestState = Schema.Literals(['open', 'closed', 'merged']);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestReviewDecision = Schema.Literals([
    'approved',
    'changesRequested',
    'reviewRequired',
    'none',
]);
export type PullRequestReviewDecision = typeof PullRequestReviewDecision.Type;

export class PullRequestCheckSummary extends Schema.Class<PullRequestCheckSummary>(
    'PullRequestCheckSummary',
)({
    total: Schema.Number,
    passed: Schema.Number,
    failed: Schema.Number,
    pending: Schema.Number,
}) {}

export class GitHubPullRequest extends Schema.Class<GitHubPullRequest>(
    'GitHubPullRequest',
)({
    repoId: RepoId,
    repository: Schema.String,
    number: Schema.Number,
    title: Schema.String,
    url: Schema.String,
    state: PullRequestState,
    isDraft: Schema.Boolean,
    headRefName: Schema.String,
    headRefOid: Schema.optional(Oid),
    baseRefName: Schema.String,
    authorLogin: Schema.String,
    authorName: Schema.optional(Schema.String),
    reviewerLogins: Schema.Array(Schema.String),
    reviewDecision: PullRequestReviewDecision,
    checks: PullRequestCheckSummary,
    updatedAt: Schema.String,
}) {}

/** One local commit in the exact merge-base..HEAD range shown before PR creation. */
export class PullRequestPreviewCommit extends Schema.Class<PullRequestPreviewCommit>(
    'PullRequestPreviewCommit',
)({
    oid: Oid,
    subject: Schema.String,
    authorName: Schema.String,
    authoredAt: Schema.String,
}) {}

/** Host-computed, immutable-at-display-time preview for a focused repository PR. */
export class GitHubPullRequestPreview extends Schema.Class<GitHubPullRequestPreview>(
    'GitHubPullRequestPreview',
)({
    repoId: RepoId,
    repository: Schema.String,
    repositoryUrl: Schema.String,
    headRefName: Schema.String,
    headOid: Oid,
    baseRefName: Schema.String,
    baseOid: Oid,
    mergeBaseOid: Oid,
    publishedHeadOid: Schema.optional(Oid),
    headPublished: Schema.Boolean,
    commits: Schema.Array(PullRequestPreviewCommit),
}) {}

/** Minimal result needed to navigate to and cache-bust after `gh pr create`. */
export class GitHubPullRequestCreated extends Schema.Class<GitHubPullRequestCreated>(
    'GitHubPullRequestCreated',
)({
    repoId: RepoId,
    repository: Schema.String,
    number: Schema.Number,
    url: Schema.String,
}) {}

/** Stable identity for a host-persisted, engagement-scoped PR coordination set. */
export const ChangeSetId = Schema.String.pipe(
    Schema.brand('cbranch/ChangeSetId'),
);
export type ChangeSetId = typeof ChangeSetId.Type;

/** A PR snapshot in a change set. Array order is the dependency/display order. */
export class ChangeSetPullRequest extends Schema.Class<ChangeSetPullRequest>(
    'ChangeSetPullRequest',
)({
    repoId: RepoId,
    repository: Schema.String,
    number: Schema.Number,
    title: Schema.String,
    url: Schema.String,
    headRefName: Schema.String,
    headRefOid: Schema.optional(Oid),
    baseRefName: Schema.String,
    dependencyNote: Schema.String,
}) {}

/** Named, ordered coordination record containing PRs from one engagement only. */
export class PullRequestChangeSet extends Schema.Class<PullRequestChangeSet>(
    'PullRequestChangeSet',
)({
    id: ChangeSetId,
    name: Schema.String,
    description: Schema.String,
    pullRequests: Schema.Array(ChangeSetPullRequest),
    createdAt: Schema.Number,
    updatedAt: Schema.Number,
}) {}

export class ForgeRateLimit extends Schema.Class<ForgeRateLimit>(
    'ForgeRateLimit',
)({
    remaining: Schema.Number,
    resetAt: Schema.Number,
}) {}

export class GitHubPullRequestList extends Schema.Class<GitHubPullRequestList>(
    'GitHubPullRequestList',
)({
    repoId: RepoId,
    repository: Schema.String,
    repositoryUrl: Schema.String,
    pullRequests: Schema.Array(GitHubPullRequest),
    rateLimit: Schema.optional(ForgeRateLimit),
}) {}
