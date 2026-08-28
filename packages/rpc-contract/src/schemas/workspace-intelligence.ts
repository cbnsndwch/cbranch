// Workspace Intelligence wire schemas (docs/spec/25, docs/spec/14 §8).
//
// These schemas deliberately describe durable run metadata rather than analyzer output.
// M1 can therefore expose truthful lifecycle/coverage before any language analyzer ships.

import { Schema } from 'effect';

import { EngagementId } from './engagements';
import { RepoId } from './primitives';

export const WorkspaceIntelligenceRunId = Schema.String.pipe(
    Schema.brand('cbranch/WorkspaceIntelligenceRunId'),
);
export type WorkspaceIntelligenceRunId = typeof WorkspaceIntelligenceRunId.Type;

export const WorkspaceIntelligenceRunState = Schema.Literals([
    'queued',
    'preparing',
    'running',
    'cancelling',
    'completed',
    'partial',
    'failed',
    'cancelled',
    'interrupted',
    'recovering',
]);
export type WorkspaceIntelligenceRunState =
    typeof WorkspaceIntelligenceRunState.Type;

export const WorkspaceIntelligenceEventKind = Schema.Literals([
    'queued',
    'stateChanged',
    'coverageUpdated',
    'completed',
    'cancelled',
    'reconciled',
]);
export type WorkspaceIntelligenceEventKind =
    typeof WorkspaceIntelligenceEventKind.Type;

export class WorkspaceIntelligenceCoverage extends Schema.Class<WorkspaceIntelligenceCoverage>(
    'WorkspaceIntelligenceCoverage',
)({
    repositoryCount: Schema.Number,
    completedRepositoryCount: Schema.Number,
    analyzerCount: Schema.Number,
    isPartial: Schema.Boolean,
    summary: Schema.String,
}) {}

/**
 * Workspace-local deterministic source scope and resource budgets. Values are
 * persisted outside immutable runs; a run records the exact effective policy.
 */
export const WorkspaceIntelligenceAnalysisSettings = Schema.Struct({
    includePatterns: Schema.Array(Schema.String),
    excludePatterns: Schema.Array(Schema.String),
    maxSourceFiles: Schema.Number,
    maxSourceFileBytes: Schema.Number,
    maxRepositorySourceBytes: Schema.Number,
    maxRepositoryDurationMs: Schema.Number,
    maxGraphNodes: Schema.Number,
    maxGraphEdges: Schema.Number,
});
export type WorkspaceIntelligenceAnalysisSettings = Schema.Schema.Type<
    typeof WorkspaceIntelligenceAnalysisSettings
>;

export class WorkspaceIntelligenceRun extends Schema.Class<WorkspaceIntelligenceRun>(
    'WorkspaceIntelligenceRun',
)({
    id: WorkspaceIntelligenceRunId,
    engagementId: EngagementId,
    /** Exact member snapshot, distinct from the optionally selected analysis subset. */
    workspaceRepoIds: Schema.Array(RepoId),
    repoIds: Schema.Array(RepoId),
    state: WorkspaceIntelligenceRunState,
    createdAt: Schema.Number,
    startedAt: Schema.optional(Schema.Number),
    finishedAt: Schema.optional(Schema.Number),
    eventSequence: Schema.Number,
    isCurrent: Schema.Boolean,
    isValid: Schema.Boolean,
    /** Freshly evaluated presentation state; never persisted into an immutable run. */
    isStale: Schema.optional(Schema.Boolean),
    /** Exact effective scope/budget snapshot for new runs; absent on legacy runs. */
    analysisSettings: Schema.optional(WorkspaceIntelligenceAnalysisSettings),
    coverage: WorkspaceIntelligenceCoverage,
}) {}

export class WorkspaceIntelligenceRunEvent extends Schema.Class<WorkspaceIntelligenceRunEvent>(
    'WorkspaceIntelligenceRunEvent',
)({
    runId: WorkspaceIntelligenceRunId,
    engagementId: EngagementId,
    sequence: Schema.Number,
    kind: WorkspaceIntelligenceEventKind,
    state: WorkspaceIntelligenceRunState,
    at: Schema.Number,
    message: Schema.String,
    coverage: WorkspaceIntelligenceCoverage,
}) {}

export class WorkspaceIntelligenceReport extends Schema.Class<WorkspaceIntelligenceReport>(
    'WorkspaceIntelligenceReport',
)({
    runId: WorkspaceIntelligenceRunId,
    markdown: Schema.String,
    nodeCount: Schema.Number,
    edgeCount: Schema.Number,
    findingCount: Schema.optional(Schema.Number),
    unknownCount: Schema.Number,
}) {}

/** Optional provider output remains a separate immutable child of a run. */
export const WorkspaceIntelligenceEnrichmentState = Schema.Literals([
    'completed',
    'failed',
    'cancelled',
]);
export type WorkspaceIntelligenceEnrichmentState =
    typeof WorkspaceIntelligenceEnrichmentState.Type;

export const WorkspaceIntelligenceConfidenceTier = Schema.Literals([
    'low',
    'medium',
    'high',
]);
export type WorkspaceIntelligenceConfidenceTier =
    typeof WorkspaceIntelligenceConfidenceTier.Type;

export class WorkspaceIntelligenceInferredEdge extends Schema.Class<WorkspaceIntelligenceInferredEdge>(
    'WorkspaceIntelligenceInferredEdge',
)({
    from: Schema.String,
    to: Schema.String,
    kind: Schema.String,
    confidence: Schema.Number,
    confidenceTier: WorkspaceIntelligenceConfidenceTier,
    evidenceIds: Schema.Array(Schema.String),
    rationale: Schema.String,
}) {}

export class WorkspaceIntelligenceEnrichmentFailure extends Schema.Class<WorkspaceIntelligenceEnrichmentFailure>(
    'WorkspaceIntelligenceEnrichmentFailure',
)({
    code: Schema.Literals([
        'invalidStructuredOutput',
        'providerFailure',
        'cancelled',
    ]),
    message: Schema.String,
    repairAttempted: Schema.Boolean,
}) {}

export class WorkspaceIntelligenceEnrichmentUsage extends Schema.Class<WorkspaceIntelligenceEnrichmentUsage>(
    'WorkspaceIntelligenceEnrichmentUsage',
)({
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
}) {}

/** No prompt, raw response, source content, secret, or profile endpoint is exposed. */
export class WorkspaceIntelligenceEnrichmentAttempt extends Schema.Class<WorkspaceIntelligenceEnrichmentAttempt>(
    'WorkspaceIntelligenceEnrichmentAttempt',
)({
    id: Schema.String,
    runId: WorkspaceIntelligenceRunId,
    profileId: Schema.String,
    modelId: Schema.String,
    promptSchemaVersion: Schema.String,
    createdAt: Schema.Number,
    completedAt: Schema.Number,
    evidenceIds: Schema.Array(Schema.String),
    state: WorkspaceIntelligenceEnrichmentState,
    repairAttempted: Schema.Boolean,
    inferredEdges: Schema.Array(WorkspaceIntelligenceInferredEdge),
    summary: Schema.optional(Schema.String),
    usage: Schema.optional(WorkspaceIntelligenceEnrichmentUsage),
    durationMs: Schema.optional(Schema.Number),
    failure: Schema.optional(WorkspaceIntelligenceEnrichmentFailure),
}) {}

/** Bounded graph records used by search/neighborhood RPCs, never whole artifacts. */
export class WorkspaceIntelligenceGraphNode extends Schema.Class<WorkspaceIntelligenceGraphNode>(
    'WorkspaceIntelligenceGraphNode',
)({
    id: Schema.String,
    kind: Schema.String,
    label: Schema.String,
    repoId: RepoId,
    evidence: Schema.Array(Schema.Unknown),
}) {}

export class WorkspaceIntelligenceGraphEdge extends Schema.Class<WorkspaceIntelligenceGraphEdge>(
    'WorkspaceIntelligenceGraphEdge',
)({
    from: Schema.String,
    to: Schema.String,
    kind: Schema.String,
    evidence: Schema.Array(Schema.Unknown),
}) {}

export class WorkspaceIntelligenceGraphSearchResult extends Schema.Class<WorkspaceIntelligenceGraphSearchResult>(
    'WorkspaceIntelligenceGraphSearchResult',
)({
    nodes: Schema.Array(WorkspaceIntelligenceGraphNode),
}) {}

/** Semantic retrieval is opt-in and may transparently return lexical fallback. */
export class WorkspaceIntelligenceSemanticSearchResult extends Schema.Class<WorkspaceIntelligenceSemanticSearchResult>(
    'WorkspaceIntelligenceSemanticSearchResult',
)({
    mode: Schema.Literals(['semantic', 'lexical-fallback']),
    nodes: Schema.Array(WorkspaceIntelligenceGraphNode),
    /** Safe status only; provider errors and response text are never exposed. */
    message: Schema.optional(Schema.String),
}) {}

export class WorkspaceIntelligenceGraphNeighborhood extends Schema.Class<WorkspaceIntelligenceGraphNeighborhood>(
    'WorkspaceIntelligenceGraphNeighborhood',
)({
    nodes: Schema.Array(WorkspaceIntelligenceGraphNode),
    edges: Schema.Array(WorkspaceIntelligenceGraphEdge),
}) {}

export class WorkspaceIntelligenceGraphDiff extends Schema.Class<WorkspaceIntelligenceGraphDiff>(
    'WorkspaceIntelligenceGraphDiff',
)({
    addedNodeIds: Schema.Array(Schema.String),
    removedNodeIds: Schema.Array(Schema.String),
    changedNodeIds: Schema.optional(Schema.Array(Schema.String)),
    addedEdgeIds: Schema.optional(Schema.Array(Schema.String)),
    removedEdgeIds: Schema.optional(Schema.Array(Schema.String)),
    changedEdgeIds: Schema.optional(Schema.Array(Schema.String)),
    addedComponentIds: Schema.optional(Schema.Array(Schema.String)),
    removedComponentIds: Schema.optional(Schema.Array(Schema.String)),
    changedComponentIds: Schema.optional(Schema.Array(Schema.String)),
    addedContractIds: Schema.optional(Schema.Array(Schema.String)),
    removedContractIds: Schema.optional(Schema.Array(Schema.String)),
    changedContractIds: Schema.optional(Schema.Array(Schema.String)),
    addedChannelIds: Schema.optional(Schema.Array(Schema.String)),
    removedChannelIds: Schema.optional(Schema.Array(Schema.String)),
    changedChannelIds: Schema.optional(Schema.Array(Schema.String)),
    addedFindingIds: Schema.optional(Schema.Array(Schema.String)),
    removedFindingIds: Schema.optional(Schema.Array(Schema.String)),
    changedFindingIds: Schema.optional(Schema.Array(Schema.String)),
    addedRepoIds: Schema.optional(Schema.Array(RepoId)),
    removedRepoIds: Schema.optional(Schema.Array(RepoId)),
    isCoverageChanged: Schema.optional(Schema.Boolean),
}) {}

/** A user-controlled graph coordinate; never part of an immutable run artifact. */
export class WorkspaceIntelligenceGraphPosition extends Schema.Class<WorkspaceIntelligenceGraphPosition>(
    'WorkspaceIntelligenceGraphPosition',
)({
    nodeId: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
}) {}

/**
 * Per-run, workspace-local exploration state. This deliberately contains no
 * graph records or source evidence: canonical artifacts remain host-owned and
 * immutable while a user's layout and visibility choices survive a refresh.
 */
export class WorkspaceIntelligencePresentation extends Schema.Class<WorkspaceIntelligencePresentation>(
    'WorkspaceIntelligencePresentation',
)({
    schemaVersion: Schema.Number,
    runId: WorkspaceIntelligenceRunId,
    selectedNodeId: Schema.optional(Schema.String),
    expandedNodeIds: Schema.Array(Schema.String),
    nodePositions: Schema.Array(WorkspaceIntelligenceGraphPosition),
    showInferredEdges: Schema.Boolean,
    minimumConfidenceTier: Schema.Literals(['low', 'medium', 'high']),
}) {}

/** A server-minted pointer to a selected immutable run artifact export. */
export class WorkspaceIntelligenceArchiveDescriptor extends Schema.Class<WorkspaceIntelligenceArchiveDescriptor>(
    'WorkspaceIntelligenceArchiveDescriptor',
)({
    url: Schema.String,
    filename: Schema.String,
    contentType: Schema.String,
}) {}

export class WorkspaceIntelligenceComponentOverride extends Schema.Class<WorkspaceIntelligenceComponentOverride>(
    'WorkspaceIntelligenceComponentOverride',
)({
    componentId: Schema.String,
    displayName: Schema.optional(Schema.String),
    kind: Schema.optional(Schema.String),
    suppressed: Schema.optional(Schema.Boolean),
    note: Schema.optional(Schema.String),
    mergeGroup: Schema.optional(Schema.String),
    mergeGroupLabel: Schema.optional(Schema.String),
    /** Read-time status only; it is never persisted in component curation. */
    isOrphaned: Schema.optional(Schema.Boolean),
}) {}

/** Workspace-local curation actions never alter immutable analyzer artifacts. */
export const WorkspaceIntelligenceCurationActionKind = Schema.Literals([
    'component.merge',
    'component.split',
    'component.rename',
    'component.reclassify',
    'component.suppress',
    'component.annotate',
    'component.clear',
    'edge.confirm',
    'edge.reject',
    'edge.annotate',
    'edge.clear',
]);
export type WorkspaceIntelligenceCurationActionKind =
    typeof WorkspaceIntelligenceCurationActionKind.Type;

export class WorkspaceIntelligenceCurationAction extends Schema.Class<WorkspaceIntelligenceCurationAction>(
    'WorkspaceIntelligenceCurationAction',
)({
    id: Schema.String,
    at: Schema.Number,
    actor: Schema.String,
    kind: WorkspaceIntelligenceCurationActionKind,
    targetId: Schema.String,
    evidence: Schema.Array(Schema.Unknown),
    metadata: Schema.optional(Schema.Unknown),
}) {}

export class WorkspaceIntelligenceCurationActionRequest extends Schema.Class<WorkspaceIntelligenceCurationActionRequest>(
    'WorkspaceIntelligenceCurationActionRequest',
)({
    actor: Schema.optional(Schema.String),
    kind: WorkspaceIntelligenceCurationActionKind,
    targetId: Schema.String,
    evidence: Schema.optional(Schema.Array(Schema.Unknown)),
    metadata: Schema.optional(Schema.Unknown),
}) {}

export class WorkspaceIntelligenceStartInput extends Schema.Class<WorkspaceIntelligenceStartInput>(
    'WorkspaceIntelligenceStartInput',
)({
    engagementId: EngagementId,
    repoIds: Schema.optional(Schema.Array(RepoId)),
    /** One-run advanced override; it never changes saved workspace settings. */
    analysisSettings: Schema.optional(WorkspaceIntelligenceAnalysisSettings),
}) {}

export class WorkspaceIntelligenceAnalysisSettingsInput extends Schema.Class<WorkspaceIntelligenceAnalysisSettingsInput>(
    'WorkspaceIntelligenceAnalysisSettingsInput',
)({
    engagementId: EngagementId,
}) {}

export class WorkspaceIntelligenceAnalysisSettingsSetInput extends Schema.Class<WorkspaceIntelligenceAnalysisSettingsSetInput>(
    'WorkspaceIntelligenceAnalysisSettingsSetInput',
)({
    engagementId: EngagementId,
    settings: WorkspaceIntelligenceAnalysisSettings,
}) {}

export class WorkspaceIntelligenceRunInput extends Schema.Class<WorkspaceIntelligenceRunInput>(
    'WorkspaceIntelligenceRunInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
}) {}

export class WorkspaceIntelligencePresentationSetInput extends Schema.Class<WorkspaceIntelligencePresentationSetInput>(
    'WorkspaceIntelligencePresentationSetInput',
)({
    engagementId: EngagementId,
    presentation: WorkspaceIntelligencePresentation,
}) {}

/** Omitting profileId explicitly uses the workspace generation default. */
export class WorkspaceIntelligenceEnrichmentStartInput extends Schema.Class<WorkspaceIntelligenceEnrichmentStartInput>(
    'WorkspaceIntelligenceEnrichmentStartInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
    profileId: Schema.optional(Schema.String),
    evidenceLimit: Schema.optional(Schema.Number),
}) {}

export class WorkspaceIntelligenceEnrichmentPreferredSetInput extends Schema.Class<WorkspaceIntelligenceEnrichmentPreferredSetInput>(
    'WorkspaceIntelligenceEnrichmentPreferredSetInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
    /** Omit to clear the workspace-local presentation selection. */
    attemptId: Schema.optional(Schema.String),
}) {}

export class WorkspaceIntelligenceRunListInput extends Schema.Class<WorkspaceIntelligenceRunListInput>(
    'WorkspaceIntelligenceRunListInput',
)({
    engagementId: EngagementId,
}) {}

export class WorkspaceIntelligenceArchiveRequestInput extends Schema.Class<WorkspaceIntelligenceArchiveRequestInput>(
    'WorkspaceIntelligenceArchiveRequestInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
}) {}

export class WorkspaceIntelligenceRunSubscribeInput extends Schema.Class<WorkspaceIntelligenceRunSubscribeInput>(
    'WorkspaceIntelligenceRunSubscribeInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
    afterSequence: Schema.optional(Schema.Number),
}) {}

export class WorkspaceIntelligenceGraphSearchInput extends Schema.Class<WorkspaceIntelligenceGraphSearchInput>(
    'WorkspaceIntelligenceGraphSearchInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
}) {}

/** Omit profileId to use the independently selected embedding profile default. */
export class WorkspaceIntelligenceSemanticSearchInput extends Schema.Class<WorkspaceIntelligenceSemanticSearchInput>(
    'WorkspaceIntelligenceSemanticSearchInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
    query: Schema.String,
    limit: Schema.optional(Schema.Number),
    profileId: Schema.optional(Schema.String),
}) {}

export class WorkspaceIntelligenceGraphNeighborhoodInput extends Schema.Class<WorkspaceIntelligenceGraphNeighborhoodInput>(
    'WorkspaceIntelligenceGraphNeighborhoodInput',
)({
    engagementId: EngagementId,
    runId: WorkspaceIntelligenceRunId,
    nodeId: Schema.String,
    limit: Schema.optional(Schema.Number),
}) {}

export class WorkspaceIntelligenceGraphDiffInput extends Schema.Class<WorkspaceIntelligenceGraphDiffInput>(
    'WorkspaceIntelligenceGraphDiffInput',
)({
    engagementId: EngagementId,
    fromRunId: WorkspaceIntelligenceRunId,
    toRunId: WorkspaceIntelligenceRunId,
}) {}

export class WorkspaceIntelligenceComponentOverridesInput extends Schema.Class<WorkspaceIntelligenceComponentOverridesInput>(
    'WorkspaceIntelligenceComponentOverridesInput',
)({
    engagementId: EngagementId,
}) {}

export class WorkspaceIntelligenceComponentOverridesSetInput extends Schema.Class<WorkspaceIntelligenceComponentOverridesSetInput>(
    'WorkspaceIntelligenceComponentOverridesSetInput',
)({
    engagementId: EngagementId,
    overrides: Schema.Array(WorkspaceIntelligenceComponentOverride),
}) {}

export class WorkspaceIntelligenceCurationActionsInput extends Schema.Class<WorkspaceIntelligenceCurationActionsInput>(
    'WorkspaceIntelligenceCurationActionsInput',
)({
    engagementId: EngagementId,
}) {}

export class WorkspaceIntelligenceCurationActionAppendInput extends Schema.Class<WorkspaceIntelligenceCurationActionAppendInput>(
    'WorkspaceIntelligenceCurationActionAppendInput',
)({
    engagementId: EngagementId,
    action: WorkspaceIntelligenceCurationActionRequest,
}) {}
