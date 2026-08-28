import {
    type EngagementId,
    RepoId,
    WorkspaceIntelligenceCoverage,
    WorkspaceIntelligenceGraphNode,
    WorkspaceIntelligenceGraphEdge,
    WorkspaceIntelligenceGraphNeighborhood,
    WorkspaceIntelligenceGraphDiff,
    WorkspaceIntelligenceGraphSearchResult,
    WorkspaceIntelligencePresentation,
    type WorkspaceIntelligenceEventKind,
    WorkspaceIntelligenceRun,
    WorkspaceIntelligenceReport,
    WorkspaceIntelligenceRunEvent,
    WorkspaceIntelligenceRunId,
    type WorkspaceIntelligenceRunState,
} from '@cbranch/rpc-contract';

import {
    MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES,
    MAX_WORKSPACE_INTELLIGENCE_NEIGHBORHOOD_EDGES,
    WorkspaceIntelligenceArtifactStore,
    type WorkspaceIntelligenceComponentOverride,
    type WorkspaceIntelligenceArchiveEntry,
    type WorkspaceIntelligenceGraphDiff as ArtifactGraphDiff,
    type WorkspaceIntelligenceCurationAction,
    type WorkspaceIntelligenceCurationActionKind,
    type WorkspaceIntelligenceCurationActionRequest,
    type WorkspaceIntelligenceStoredGraphEdge,
    type WorkspaceIntelligenceStoredGraphNode,
} from './artifact-store';
import type { WorkspaceIntelligenceAnalysis } from './analysis';
import {
    defaultWorkspaceIntelligenceAnalysisSettings,
    normalizeWorkspaceIntelligenceAnalysisSettings,
    type WorkspaceIntelligenceAnalysisSettings as AnalysisSettings,
} from './analysis-settings';
import type {
    WorkspaceIntelligenceRepository,
    WorkspaceIntelligenceRuntime,
    WorkspaceIntelligenceWorkspace,
    WorkspaceIntelligenceWorkspacePort,
} from './ports';

type ActiveRun = {
    run: WorkspaceIntelligenceRun;
    events: WorkspaceIntelligenceRunEvent[];
    analyses: WorkspaceIntelligenceAnalysis[];
    repositories: ReadonlyArray<WorkspaceIntelligenceRepository>;
    cancelled: boolean;
    executionStarted: boolean;
};

interface CuratedGraphProjection {
    readonly nodes: ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>;
    readonly edges: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>;
}

const terminalStates = new Set<WorkspaceIntelligenceRunState>([
    'completed',
    'partial',
    'failed',
    'cancelled',
    'interrupted',
]);

const isTerminal = (state: WorkspaceIntelligenceRunState): boolean =>
    terminalStates.has(state);

const componentGroupIdPrefix = 'curation:component-group:';

const componentGroupNodeId = (group: string): string =>
    `${componentGroupIdPrefix}${encodeURIComponent(group)}`;

const componentGroupFromNodeId = (nodeId: string): string | undefined => {
    if (!nodeId.startsWith(componentGroupIdPrefix)) return undefined;
    try {
        const group = decodeURIComponent(
            nodeId.slice(componentGroupIdPrefix.length),
        );
        return group === '' ? undefined : group;
    } catch {
        return undefined;
    }
};

const edgeCurationTarget = (
    edge: WorkspaceIntelligenceStoredGraphEdge,
): string => `${edge.from}\0${edge.kind}\0${edge.to}`;

const mergeEvidence = (
    values: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyArray<unknown> =>
    [
        ...new Map(
            values.flat().map(value => [JSON.stringify(value), value]),
        ).values(),
    ].toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

export class WorkspaceIntelligenceError extends Error {
    constructor(
        readonly code: 'engagementNotFound' | 'repoNotFound' | 'repoLocked',
        message: string,
    ) {
        super(message);
        this.name = 'WorkspaceIntelligenceError';
    }
}

export interface WorkspaceIntelligenceManagerOptions {
    readonly store: WorkspaceIntelligenceArtifactStore;
    readonly workspace: WorkspaceIntelligenceWorkspacePort;
    readonly runtime: WorkspaceIntelligenceRuntime;
    /** Bound simultaneous analysis work across all workspace runs in this host. */
    readonly maxConcurrentRuns?: number;
}

/**
 * Host-independent background run manager. Its only inputs are authoritative
 * workspace resolution, storage ports, and a deliberately no-op M1 repository step.
 */
export class WorkspaceIntelligenceManager {
    readonly #store: WorkspaceIntelligenceArtifactStore;
    readonly #workspace: WorkspaceIntelligenceWorkspacePort;
    readonly #runtime: WorkspaceIntelligenceRuntime;
    readonly #active = new Map<string, ActiveRun>();
    readonly #activeByEngagement = new Map<EngagementId, string>();
    readonly #listeners = new Map<string, Set<() => void>>();
    readonly #curationWrites = new Map<EngagementId, Promise<void>>();
    readonly #pendingRunIds: string[] = [];
    readonly #maxConcurrentRuns: number;
    #runningCount = 0;
    #nextCurationActionId = 0;

    constructor(options: WorkspaceIntelligenceManagerOptions) {
        const maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
        if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1)
            throw new RangeError(
                'Workspace Intelligence maxConcurrentRuns must be a positive integer.',
            );
        this.#store = options.store;
        this.#workspace = options.workspace;
        this.#runtime = options.runtime;
        this.#maxConcurrentRuns = maxConcurrentRuns;
    }

    async start(
        engagementId: EngagementId,
        requestedRepoIds?: ReadonlyArray<RepoId>,
        requestedSettings?: AnalysisSettings,
    ): Promise<WorkspaceIntelligenceRun> {
        const workspace = await this.#workspace.resolveWorkspace(engagementId);
        if (workspace === undefined)
            throw new WorkspaceIntelligenceError(
                'engagementNotFound',
                'Workspace not found.',
            );
        const repositories = this.validateScope(
            workspace.repositories,
            requestedRepoIds,
        );
        const analysisSettings = normalizeWorkspaceIntelligenceAnalysisSettings(
            requestedSettings ??
                (await this.#store.readAnalysisSettings(engagementId)),
        );
        const activeId = this.#activeByEngagement.get(engagementId);
        if (activeId !== undefined) {
            const active = this.#active.get(activeId)!;
            if (this.sameScope(active.run.repoIds, repositories))
                return active.run;
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'A Workspace Intelligence run is already active for this workspace.',
            );
        }

        const now = this.#runtime.now();
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make(this.#runtime.nextRunId()),
            engagementId,
            workspaceRepoIds: workspace.repositories.map(
                repository => repository.repoId,
            ),
            repoIds: repositories.map(repository => repository.repoId),
            state: 'queued',
            createdAt: now,
            eventSequence: 0,
            isCurrent: false,
            isValid: false,
            analysisSettings,
            coverage: this.coverage(repositories.length, 0, false, 'Queued.'),
        });
        const active: ActiveRun = {
            run,
            events: [],
            analyses: [],
            repositories,
            cancelled: false,
            executionStarted: false,
        };
        this.#active.set(run.id, active);
        this.#activeByEngagement.set(engagementId, run.id);
        await this.record(active, 'queued', 'Run queued.');
        this.enqueue(active);
        return active.run;
    }

    /** Reads the mutable workspace policy after authoritative membership validation. */
    async analysisSettings(
        engagementId: EngagementId,
    ): Promise<AnalysisSettings> {
        await this.requireWorkspace(engagementId);
        return this.#store.readAnalysisSettings(engagementId);
    }

    /** Changes only future-run defaults; existing immutable run snapshots remain unchanged. */
    async setAnalysisSettings(
        engagementId: EngagementId,
        settings: AnalysisSettings,
    ): Promise<AnalysisSettings> {
        await this.requireWorkspace(engagementId);
        return this.#store.writeAnalysisSettings(
            engagementId,
            normalizeWorkspaceIntelligenceAnalysisSettings(settings),
        );
    }

    /** Workspace-local layout/filter state remains separate from run artifacts. */
    async presentation(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRun['id'],
    ): Promise<WorkspaceIntelligencePresentation> {
        await this.get(engagementId, runId);
        return this.#store.readPresentation(engagementId, runId);
    }

    async setPresentation(
        engagementId: EngagementId,
        presentation: WorkspaceIntelligencePresentation,
    ): Promise<WorkspaceIntelligencePresentation> {
        await this.get(engagementId, presentation.runId);
        return this.#store.writePresentation(engagementId, presentation);
    }

    async get(
        engagementId: EngagementId,
        runId: string,
    ): Promise<WorkspaceIntelligenceRun> {
        const active = this.#active.get(runId);
        if (active !== undefined) {
            this.assertEngagement(active.run, engagementId);
            return this.withCurrent(active.run);
        }
        const run = await this.#store.readRun(engagementId, runId);
        if (run === undefined)
            throw new WorkspaceIntelligenceError(
                'repoNotFound',
                'Run not found.',
            );
        return this.withCurrent(await this.withIntegrity(run));
    }

    async list(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceRun>> {
        const runs = await this.#store.listRuns(engagementId);
        const hydrated = await Promise.all(
            runs.map(async run =>
                this.withCurrent(await this.withIntegrity(run)),
            ),
        );
        for (const active of this.#active.values()) {
            if (active.run.engagementId !== engagementId) continue;
            const index = hydrated.findIndex(run => run.id === active.run.id);
            if (index === -1) hydrated.push(await this.withCurrent(active.run));
            else hydrated[index] = await this.withCurrent(active.run);
        }
        const withStaleness = await Promise.all(
            hydrated.map(run => this.withStaleness(run)),
        );
        return withStaleness.toSorted(
            (left, right) => right.createdAt - left.createdAt,
        );
    }

    async report(
        engagementId: EngagementId,
        runId: string,
    ): Promise<WorkspaceIntelligenceReport> {
        const run = await this.get(engagementId, runId);
        this.assertReadable(run);
        const report = await this.#store.readReport(engagementId, runId);
        if (report === undefined)
            throw new WorkspaceIntelligenceError(
                'repoNotFound',
                'The report is not available until the run is finalized.',
            );
        return new WorkspaceIntelligenceReport({
            runId: WorkspaceIntelligenceRunId.make(runId),
            ...report,
        });
    }

    async search(
        engagementId: EngagementId,
        runId: string,
        query: string,
        requestedLimit?: number,
    ): Promise<WorkspaceIntelligenceGraphSearchResult> {
        const run = await this.get(engagementId, runId);
        this.assertReadable(run);
        const limit = Math.max(
            1,
            Math.min(
                Math.floor(requestedLimit ?? 30),
                MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES,
            ),
        );
        const [nodes, overrides] = await Promise.all([
            this.#store.searchGraph(
                engagementId,
                runId,
                query,
                Math.min(limit * 4, MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES * 4),
            ),
            this.#store.readComponentOverrides(engagementId),
        ]);
        return new WorkspaceIntelligenceGraphSearchResult({
            nodes: this.applyComponentCuration(nodes, [], overrides)
                .nodes.slice(0, limit)
                .map(
                    node =>
                        new WorkspaceIntelligenceGraphNode({
                            ...node,
                            repoId: RepoId.make(node.repoId),
                        }),
                ),
        });
    }

    /**
     * Applies normal curation to a bounded caller-ranked node list. Semantic
     * retrieval uses this after ranking host-resident graph chunks; it does not
     * bypass suppression or expose the complete canonical graph.
     */
    async nodesById(
        engagementId: EngagementId,
        runId: string,
        nodeIds: ReadonlyArray<string>,
        requestedLimit?: number,
    ): Promise<WorkspaceIntelligenceGraphSearchResult> {
        const run = await this.get(engagementId, runId);
        this.assertReadable(run);
        const limit = Math.max(
            1,
            Math.min(
                Math.floor(requestedLimit ?? 30),
                MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES,
            ),
        );
        const [nodes, overrides] = await Promise.all([
            this.#store.graphNodesByIds(engagementId, runId, nodeIds, limit),
            this.#store.readComponentOverrides(engagementId),
        ]);
        return new WorkspaceIntelligenceGraphSearchResult({
            nodes: this.applyComponentCuration(nodes, [], overrides)
                .nodes.slice(0, limit)
                .map(
                    node =>
                        new WorkspaceIntelligenceGraphNode({
                            ...node,
                            repoId: RepoId.make(node.repoId),
                        }),
                ),
        });
    }

    async neighborhood(
        engagementId: EngagementId,
        runId: string,
        nodeId: string,
        requestedLimit?: number,
    ): Promise<WorkspaceIntelligenceGraphNeighborhood> {
        const run = await this.get(engagementId, runId);
        this.assertReadable(run);
        const limit = Math.max(
            1,
            Math.min(
                Math.floor(requestedLimit ?? 30),
                MAX_WORKSPACE_INTELLIGENCE_NEIGHBORHOOD_EDGES,
            ),
        );
        const [overrides, curationState] = await Promise.all([
            this.#store.readComponentOverrides(engagementId),
            this.#store.readCurationState(engagementId),
        ]);
        const groupMemberIds = this.componentGroupMemberIds(nodeId, overrides);
        const graph =
            groupMemberIds === undefined
                ? await this.#store.neighborhoodGraph(
                      engagementId,
                      runId,
                      nodeId,
                      limit,
                  )
                : await this.#store.neighborhoodGraphForNodes(
                      engagementId,
                      runId,
                      groupMemberIds,
                      limit,
                  );
        const rejectedEdgeIds = new Set(
            (curationState?.edgeActions ?? [])
                .filter(action => action.kind === 'edge.reject')
                .map(action => action.targetId),
        );
        const curated = this.applyComponentCuration(
            graph.nodes,
            graph.edges.filter(
                edge => !rejectedEdgeIds.has(edgeCurationTarget(edge)),
            ),
            overrides,
        );
        return new WorkspaceIntelligenceGraphNeighborhood({
            nodes: curated.nodes.map(
                node =>
                    new WorkspaceIntelligenceGraphNode({
                        ...node,
                        repoId: RepoId.make(node.repoId),
                    }),
            ),
            edges: curated.edges.map(
                edge => new WorkspaceIntelligenceGraphEdge(edge),
            ),
        });
    }

    async diff(
        engagementId: EngagementId,
        fromRunId: string,
        toRunId: string,
    ): Promise<WorkspaceIntelligenceGraphDiff> {
        const [from, to] = await Promise.all([
            this.get(engagementId, fromRunId),
            this.get(engagementId, toRunId),
        ]);
        this.assertReadable(from);
        this.assertReadable(to);
        const diff: ArtifactGraphDiff = await this.#store.diffGraph(
            engagementId,
            fromRunId,
            toRunId,
        );
        const difference = (
            left: ReadonlyArray<RepoId>,
            right: ReadonlyArray<RepoId>,
        ): ReadonlyArray<RepoId> =>
            left.filter(repoId => !right.includes(repoId)).toSorted();
        return new WorkspaceIntelligenceGraphDiff({
            ...diff,
            addedRepoIds: difference(to.repoIds, from.repoIds),
            removedRepoIds: difference(from.repoIds, to.repoIds),
            isCoverageChanged:
                JSON.stringify(from.coverage) !== JSON.stringify(to.coverage),
        });
    }

    async componentOverrides(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceComponentOverride>> {
        const workspace = await this.#workspace.resolveWorkspace(engagementId);
        if (workspace === undefined)
            throw new WorkspaceIntelligenceError(
                'engagementNotFound',
                'Workspace not found.',
            );
        const overrides =
            await this.#store.readComponentOverrides(engagementId);
        const currentRunId = await this.#store.currentRunId(engagementId);
        if (currentRunId === undefined) return overrides;
        try {
            const current = await this.get(engagementId, currentRunId);
            if (!current.isValid) return overrides;
            const componentIds = await this.#store.componentIds(
                engagementId,
                currentRunId,
            );
            return overrides.map(override => ({
                ...override,
                isOrphaned: !componentIds.has(override.componentId),
            }));
        } catch {
            // Curation status must not make a separately valid run unavailable.
            return overrides;
        }
    }

    async setComponentOverrides(
        engagementId: EngagementId,
        overrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceComponentOverride>> {
        return this.withCurationWrite(engagementId, async () => {
            await this.componentOverrides(engagementId);
            const previous =
                await this.#store.readComponentOverrides(engagementId);
            const persisted = overrides.map(
                ({ isOrphaned: _isOrphaned, ...override }) => override,
            );
            if (persisted.some(override => override.componentId.trim() === ''))
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'A component override requires a stable component ID.',
                );
            if (
                new Set(persisted.map(override => override.componentId))
                    .size !== persisted.length
            )
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'Component overrides must have unique stable component IDs.',
                );
            if (
                persisted.some(
                    override =>
                        override.mergeGroup !== undefined &&
                        override.mergeGroup.trim() === '',
                )
            )
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'A component merge group cannot be blank.',
                );
            if (
                persisted.some(
                    override =>
                        override.mergeGroup === undefined &&
                        override.mergeGroupLabel !== undefined,
                )
            )
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'A component merge label requires a merge group.',
                );
            for (const group of new Set(
                persisted.flatMap(override =>
                    override.mergeGroup === undefined
                        ? []
                        : [override.mergeGroup],
                ),
            )) {
                const labels = new Set(
                    persisted.flatMap(override =>
                        override.mergeGroup === group &&
                        override.mergeGroupLabel !== undefined
                            ? [override.mergeGroupLabel]
                            : [],
                    ),
                );
                if (labels.size > 1)
                    throw new WorkspaceIntelligenceError(
                        'repoNotFound',
                        'A component merge group must use one display label.',
                    );
            }
            await this.#store.writeComponentOverrides(engagementId, persisted);
            const actions = this.componentOverrideActions(previous, persisted);
            if (actions.length > 0)
                await this.#store.writeCurationActions(engagementId, [
                    ...(await this.#store.readCurationActions(engagementId)),
                    ...actions,
                ]);
            return this.componentOverrides(engagementId);
        });
    }

    async curationActions(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceCurationAction>> {
        await this.componentOverrides(engagementId);
        return this.#store.readCurationActions(engagementId);
    }

    async appendCurationAction(
        engagementId: EngagementId,
        request: WorkspaceIntelligenceCurationActionRequest,
    ): Promise<WorkspaceIntelligenceCurationAction> {
        return this.withCurationWrite(engagementId, async () => {
            await this.componentOverrides(engagementId);
            if (!request.kind.startsWith('edge.'))
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'Component curation is recorded through component overrides.',
                );
            if (request.targetId.trim() === '')
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'A curation action requires a stable target ID.',
                );
            const action = this.curationAction(request);
            await this.#store.writeCurationActions(engagementId, [
                ...(await this.#store.readCurationActions(engagementId)),
                action,
            ]);
            return action;
        });
    }

    /** Explicitly clears all mutable workspace curation, never any run artifact. */
    async clearCurationActions(engagementId: EngagementId): Promise<void> {
        await this.withCurationWrite(engagementId, async () => {
            await this.componentOverrides(engagementId);
            await this.#store.writeComponentOverrides(engagementId, []);
            await this.#store.writeCurationActions(engagementId, []);
        });
    }

    /** Only explicit, non-current finalized history can be cleaned up. */
    async deleteRun(engagementId: EngagementId, runId: string): Promise<void> {
        if (this.#active.has(runId))
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'An active run cannot be deleted.',
            );
        const run = await this.get(engagementId, runId);
        if (run.isCurrent)
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'The current run is protected from deletion.',
            );
        await this.#store.deleteRun(engagementId, runId);
    }

    /** Selects a validated finalized artifact as the reusable current run. */
    async setCurrent(engagementId: EngagementId, runId: string): Promise<void> {
        if (this.#active.has(runId))
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'An active run cannot become current.',
            );
        const run = await this.get(engagementId, runId);
        this.assertReadable(run);
        await this.#store.setCurrent(run);
    }

    /** Clears only the mutable current pointer; no artifact is deleted. */
    async clearCurrent(engagementId: EngagementId): Promise<void> {
        if (this.#activeByEngagement.has(engagementId))
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'The current run cannot be cleared while analysis is active.',
            );
        await this.#store.clearCurrent(engagementId);
    }

    /** Explicitly removes all historical run artifacts and their derived children. */
    async clearRunHistory(engagementId: EngagementId): Promise<void> {
        if (this.#activeByEngagement.has(engagementId))
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'Run history cannot be cleared while analysis is active.',
            );
        await this.#store.clearRunHistory(engagementId);
    }

    async prepareArchive(
        engagementId: EngagementId,
        runId: string,
    ): Promise<void> {
        this.assertReadable(await this.get(engagementId, runId));
    }

    async archiveEntries(
        engagementId: EngagementId,
        runId: string,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceArchiveEntry>> {
        await this.prepareArchive(engagementId, runId);
        return this.#store.archiveEntries(engagementId, runId);
    }

    async cancel(
        engagementId: EngagementId,
        runId: string,
    ): Promise<WorkspaceIntelligenceRun> {
        const active = this.#active.get(runId);
        if (active === undefined) return this.get(engagementId, runId);
        this.assertEngagement(active.run, engagementId);
        if (!isTerminal(active.run.state) && !active.cancelled) {
            active.cancelled = true;
            await this.transition(
                active,
                'cancelling',
                'Cancellation requested.',
            );
            if (!active.executionStarted)
                await this.finishQueuedCancellation(active);
        }
        return this.withCurrent(active.run);
    }

    async *subscribe(
        engagementId: EngagementId,
        runId: string,
        afterSequence = 0,
    ): AsyncIterable<WorkspaceIntelligenceRunEvent> {
        const run = await this.get(engagementId, runId);
        let sequence = afterSequence;
        try {
            while (true) {
                const events = await this.eventsFor(run, runId);
                const unseen = events.filter(
                    event => event.sequence > sequence,
                );
                for (const event of unseen) {
                    sequence = event.sequence;
                    yield event;
                }
                const current = await this.get(engagementId, runId);
                // A terminal state is emitted before the final report/current pointer is
                // atomically materialized. Keep the stream open until the worker has
                // finalized and removed its active record, then let the caller refresh.
                if (isTerminal(current.state) && !this.#active.has(runId))
                    return;
                await this.awaitEvent(runId);
            }
        } finally {
            // `awaitEvent` removes its own resolver if the generator is closed.
        }
    }

    /** Reconcile interrupted jobs at host startup; no process is ever resurrected. */
    async reconcile(): Promise<void> {
        const workspaceIds = await this.#store.listWorkspaceIds();
        for (const engagementId of workspaceIds) {
            const runs = await this.#store.listRuns(engagementId);
            for (const run of runs) {
                if (isTerminal(run.state)) continue;
                const events = [
                    ...(await this.#store.readEvents(engagementId, run.id)),
                ];
                const finishedAt = this.#runtime.now();
                const interrupted = new WorkspaceIntelligenceRun({
                    ...run,
                    state: 'interrupted',
                    finishedAt,
                    eventSequence: run.eventSequence + 1,
                    isValid: false,
                    coverage: this.coverage(
                        run.coverage.repositoryCount,
                        run.coverage.completedRepositoryCount,
                        true,
                        'Interrupted by a host restart before a repository boundary could resume.',
                    ),
                });
                events.push(
                    new WorkspaceIntelligenceRunEvent({
                        runId: interrupted.id,
                        engagementId,
                        sequence: interrupted.eventSequence,
                        kind: 'reconciled',
                        state: 'interrupted',
                        at: finishedAt,
                        message: 'Run reconciled after host restart.',
                        coverage: interrupted.coverage,
                    }),
                );
                await this.#store.finalize(interrupted, events);
            }
        }
    }

    /**
     * Starts queued runs only while this host has capacity. A run remains
     * durably queued until this method marks its execution as started, so a
     * duplicate request can still return the original run ID and cancellation
     * can finish without invoking repository analysis.
     */
    private enqueue(active: ActiveRun): void {
        this.#pendingRunIds.push(active.run.id);
        this.drainQueue();
    }

    private drainQueue(): void {
        while (this.#runningCount < this.#maxConcurrentRuns) {
            const runId = this.#pendingRunIds.shift();
            if (runId === undefined) return;
            const active = this.#active.get(runId);
            if (
                active === undefined ||
                active.executionStarted ||
                active.cancelled
            )
                continue;
            active.executionStarted = true;
            this.#runningCount += 1;
            void this.execute(active, active.repositories).finally(() => {
                this.#runningCount -= 1;
                this.drainQueue();
            });
        }
    }

    private async finishQueuedCancellation(active: ActiveRun): Promise<void> {
        this.#pendingRunIds.splice(
            0,
            this.#pendingRunIds.length,
            ...this.#pendingRunIds.filter(runId => runId !== active.run.id),
        );
        await this.finishCancelled(active);
        this.#active.delete(active.run.id);
        this.#activeByEngagement.delete(active.run.engagementId);
        this.notify(active.run.id);
        this.drainQueue();
    }

    private async execute(
        active: ActiveRun,
        repositories: ReadonlyArray<WorkspaceIntelligenceRepository>,
    ): Promise<void> {
        try {
            await this.transition(
                active,
                'preparing',
                'Preparing workspace snapshot.',
            );
            if (active.cancelled) return this.finishCancelled(active);
            await this.transition(
                active,
                'running',
                'Running foundational analysis.',
            );
            let completed = 0;
            for (const repository of repositories) {
                if (active.cancelled) return this.finishCancelled(active);
                const reused = await this.reusableAnalysis(
                    active.run.engagementId,
                    repository,
                    this.settingsFor(active.run),
                );
                const analysis =
                    reused ??
                    (await this.#runtime.analyzeRepository?.(
                        repository,
                        this.settingsFor(active.run),
                    ));
                if (analysis !== undefined) active.analyses.push(analysis);
                completed += 1;
                await this.cover(
                    active,
                    completed,
                    reused === undefined
                        ? 'Repository boundary completed.'
                        : 'Repository analysis reused from the validated current run.',
                );
            }
            if (active.cancelled) return this.finishCancelled(active);
            const isPartial = active.analyses.some(
                analysis => analysis.isPartial === true,
            );
            await this.transition(
                active,
                isPartial ? 'partial' : 'completed',
                active.analyses.length > 0
                    ? isPartial
                        ? 'Deterministic analysis completed with partial coverage.'
                        : 'Deterministic analysis completed.'
                    : 'Foundational run completed.',
                isPartial,
                true,
                active.analyses.length > 0
                    ? isPartial
                        ? 'Deterministic source analysis completed with explicit capability gaps and partial input coverage.'
                        : 'Deterministic source analysis completed with explicit capability gaps.'
                    : 'Foundational report complete. No language analyzers have run yet.',
            );
            await this.#store.finalize(
                active.run,
                active.events,
                active.analyses,
            );
            await this.#store.setCurrent(active.run);
        } catch (error) {
            if (active.cancelled) return this.finishCancelled(active);
            await this.transition(
                active,
                'failed',
                error instanceof Error ? error.message : 'Run failed.',
                true,
            );
            await this.#store.finalize(
                active.run,
                active.events,
                active.analyses,
            );
        } finally {
            this.#active.delete(active.run.id);
            this.#activeByEngagement.delete(active.run.engagementId);
            this.notify(active.run.id);
        }
    }

    private async finishCancelled(active: ActiveRun): Promise<void> {
        await this.transition(active, 'cancelled', 'Run cancelled.', true);
        await this.#store.finalize(active.run, active.events, active.analyses);
    }

    private async transition(
        active: ActiveRun,
        state: WorkspaceIntelligenceRunState,
        message: string,
        partial = false,
        valid = false,
        coverageSummary?: string,
    ): Promise<void> {
        const now = this.#runtime.now();
        const startedAt =
            active.run.startedAt ?? (state === 'preparing' ? now : undefined);
        active.run = new WorkspaceIntelligenceRun({
            ...active.run,
            state,
            startedAt,
            finishedAt: isTerminal(state) ? now : active.run.finishedAt,
            isValid: valid,
            coverage: this.coverage(
                active.run.coverage.repositoryCount,
                active.run.coverage.completedRepositoryCount,
                partial,
                coverageSummary ?? message,
                active.run.coverage.analyzerCount,
            ),
        });
        await this.record(
            active,
            isTerminal(state)
                ? state === 'cancelled'
                    ? 'cancelled'
                    : 'completed'
                : 'stateChanged',
            message,
        );
    }

    private async cover(
        active: ActiveRun,
        completed: number,
        message: string,
    ): Promise<void> {
        active.run = new WorkspaceIntelligenceRun({
            ...active.run,
            coverage: this.coverage(
                active.run.coverage.repositoryCount,
                completed,
                false,
                active.analyses.length > 0
                    ? 'Deterministic repository analysis completed at a repository boundary.'
                    : 'Foundational repository boundaries completed. No language analyzers have run yet.',
                active.analyses.reduce(
                    (count, analysis) => count + analysis.analyzerCount,
                    0,
                ),
            ),
        });
        await this.record(active, 'coverageUpdated', message);
    }

    private async record(
        active: ActiveRun,
        kind: WorkspaceIntelligenceEventKind,
        message: string,
    ): Promise<void> {
        const sequence = active.run.eventSequence + 1;
        active.run = new WorkspaceIntelligenceRun({
            ...active.run,
            eventSequence: sequence,
        });
        const event = new WorkspaceIntelligenceRunEvent({
            runId: active.run.id,
            engagementId: active.run.engagementId,
            sequence,
            kind,
            state: active.run.state,
            at: this.#runtime.now(),
            message,
            coverage: active.run.coverage,
        });
        active.events.push(event);
        await this.#store.writeRun(active.run, active.events);
        this.notify(active.run.id);
    }

    private coverage(
        repositoryCount: number,
        completedRepositoryCount: number,
        isPartial: boolean,
        summary: string,
        analyzerCount = 0,
    ): WorkspaceIntelligenceCoverage {
        return new WorkspaceIntelligenceCoverage({
            repositoryCount,
            completedRepositoryCount,
            analyzerCount,
            isPartial,
            summary,
        });
    }

    /**
     * Reuse is deliberately conservative. It reads only the current validated
     * snapshot, requires the host's fresh fingerprint and analyzer version to
     * match, and returns an analysis that finalize writes into the new run.
     */
    private async reusableAnalysis(
        engagementId: EngagementId,
        repository: WorkspaceIntelligenceRepository,
        settings: AnalysisSettings,
    ): Promise<WorkspaceIntelligenceAnalysis | undefined> {
        if (this.#runtime.fingerprintRepository === undefined) return undefined;
        try {
            const fingerprint = await this.#runtime.fingerprintRepository(
                repository,
                settings,
            );
            if (fingerprint === undefined) return undefined;
            const currentRunId = await this.#store.currentRunId(engagementId);
            if (currentRunId === undefined) return undefined;
            const current = await this.get(engagementId, currentRunId);
            if (!current.isValid) return undefined;
            if (
                JSON.stringify(this.settingsFor(current)) !==
                JSON.stringify(settings)
            )
                return undefined;
            const analysis = await this.#store.readRepositoryAnalysis(
                engagementId,
                currentRunId,
                repository.repoId,
            );
            if (
                analysis?.repository?.repoId !== repository.repoId ||
                analysis.repository.sourceFingerprint !== fingerprint ||
                (this.#runtime.analyzerVersion !== undefined &&
                    analysis.repository.analyzerVersion !==
                        this.#runtime.analyzerVersion)
            )
                return undefined;
            return analysis;
        } catch {
            // Reuse is an optimization. A missing/corrupt predecessor must never
            // make a new analysis impossible.
            return undefined;
        }
    }

    private settingsFor(run: WorkspaceIntelligenceRun): AnalysisSettings {
        return normalizeWorkspaceIntelligenceAnalysisSettings(
            run.analysisSettings ??
                defaultWorkspaceIntelligenceAnalysisSettings,
        );
    }

    private async requireWorkspace(
        engagementId: EngagementId,
    ): Promise<WorkspaceIntelligenceWorkspace> {
        const workspace = await this.#workspace.resolveWorkspace(engagementId);
        if (workspace === undefined)
            throw new WorkspaceIntelligenceError(
                'engagementNotFound',
                'Workspace not found.',
            );
        return workspace;
    }

    private validateScope(
        members: ReadonlyArray<WorkspaceIntelligenceRepository>,
        requested: ReadonlyArray<RepoId> | undefined,
    ): ReadonlyArray<WorkspaceIntelligenceRepository> {
        if (requested === undefined) {
            if (members.length === 0)
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'Workspace has no repositories to analyze.',
                );
            return members;
        }
        if (requested.length === 0)
            throw new WorkspaceIntelligenceError(
                'repoNotFound',
                'The repository subset cannot be empty.',
            );
        const memberById = new Map(
            members.map(member => [member.repoId, member]),
        );
        const seen = new Set<RepoId>();
        return requested.map(repoId => {
            if (seen.has(repoId))
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'The repository subset contains duplicate repository IDs.',
                );
            seen.add(repoId);
            const member = memberById.get(repoId);
            if (member === undefined)
                throw new WorkspaceIntelligenceError(
                    'repoNotFound',
                    'A requested repository is not a workspace member.',
                );
            return member;
        });
    }

    private sameScope(
        left: ReadonlyArray<RepoId>,
        right: ReadonlyArray<WorkspaceIntelligenceRepository>,
    ): boolean {
        return (
            left.length === right.length &&
            left.every((repoId, index) => repoId === right[index]?.repoId)
        );
    }

    private assertEngagement(
        run: WorkspaceIntelligenceRun,
        engagementId: EngagementId,
    ): void {
        if (run.engagementId !== engagementId)
            throw new WorkspaceIntelligenceError(
                'repoNotFound',
                'Run not found.',
            );
    }

    /** Curation is presentation data: it never mutates an immutable run graph. */
    private applyComponentCuration(
        nodes: ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>,
        edges: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>,
        overrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
    ): CuratedGraphProjection {
        const overridesByComponentId = new Map(
            overrides.map(override => [override.componentId, override]),
        );
        const sourceComponentIds = new Set(
            nodes
                .filter(node => node.kind === 'component')
                .map(node => node.id),
        );
        const visibleNodes = nodes.flatMap(node => {
            if (node.kind !== 'component') return [node];
            const override = overridesByComponentId.get(node.id);
            if (override?.suppressed) return [];
            return [
                {
                    ...node,
                    label: override?.displayName ?? node.label,
                    kind: override?.kind ?? node.kind,
                },
            ];
        });
        const membersByGroup = new Map<
            string,
            WorkspaceIntelligenceStoredGraphNode[]
        >();
        for (const node of visibleNodes) {
            if (!sourceComponentIds.has(node.id)) continue;
            const group = overridesByComponentId.get(node.id)?.mergeGroup;
            if (group === undefined) continue;
            const members = membersByGroup.get(group) ?? [];
            members.push(node);
            membersByGroup.set(group, members);
        }
        const renderedIdBySourceId = new Map(
            visibleNodes.map(node => [node.id, node.id]),
        );
        const groupNodes: WorkspaceIntelligenceStoredGraphNode[] = [];
        for (const [group, members] of membersByGroup) {
            if (members.length < 2) continue;
            const groupId = componentGroupNodeId(group);
            for (const member of members)
                renderedIdBySourceId.set(member.id, groupId);
            const label = overrides.find(
                override =>
                    override.mergeGroup === group &&
                    override.mergeGroupLabel !== undefined,
            )?.mergeGroupLabel;
            groupNodes.push({
                id: groupId,
                kind: 'component.group',
                label: label ?? group,
                repoId: members.map(member => member.repoId).toSorted()[0]!,
                evidence: mergeEvidence(members.map(member => member.evidence)),
            });
        }
        const groupedSourceIds = new Set(
            [...renderedIdBySourceId.entries()]
                .filter(([sourceId, renderedId]) => sourceId !== renderedId)
                .map(([sourceId]) => sourceId),
        );
        const renderedNodes = [
            ...visibleNodes.filter(node => !groupedSourceIds.has(node.id)),
            ...groupNodes,
        ].toSorted((left, right) =>
            `${left.label}\0${left.id}`.localeCompare(
                `${right.label}\0${right.id}`,
            ),
        );
        const renderedEdges = [
            ...new Map(
                edges
                    .flatMap(edge => {
                        const from = renderedIdBySourceId.get(edge.from);
                        const to = renderedIdBySourceId.get(edge.to);
                        if (
                            from === undefined ||
                            to === undefined ||
                            from === to
                        )
                            return [];
                        return [{ ...edge, from, to }];
                    })
                    .map(edge => [
                        `${edge.from}\0${edge.kind}\0${edge.to}`,
                        edge,
                    ]),
            ).values(),
        ]
            .map(edge => ({
                ...edge,
                evidence: mergeEvidence(
                    edges
                        .filter(candidate => {
                            const from = renderedIdBySourceId.get(
                                candidate.from,
                            );
                            const to = renderedIdBySourceId.get(candidate.to);
                            return (
                                from === edge.from &&
                                to === edge.to &&
                                candidate.kind === edge.kind &&
                                from !== to
                            );
                        })
                        .map(candidate => candidate.evidence),
                ),
            }))
            .toSorted((left, right) =>
                `${left.from}\0${left.kind}\0${left.to}`.localeCompare(
                    `${right.from}\0${right.kind}\0${right.to}`,
                ),
            );
        return { nodes: renderedNodes, edges: renderedEdges };
    }

    private componentGroupMemberIds(
        nodeId: string,
        overrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
    ): ReadonlyArray<string> | undefined {
        const group =
            componentGroupFromNodeId(nodeId) ??
            overrides.find(override => override.componentId === nodeId)
                ?.mergeGroup;
        if (group === undefined) return undefined;
        return overrides
            .filter(override => override.mergeGroup === group)
            .map(override => override.componentId);
    }

    private componentOverrideActions(
        previous: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
        overrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
    ): ReadonlyArray<WorkspaceIntelligenceCurationAction> {
        const before = new Map(
            previous.map(override => [override.componentId, override]),
        );
        const after = new Map(
            overrides.map(override => [override.componentId, override]),
        );
        return [...new Set([...before.keys(), ...after.keys()])]
            .toSorted()
            .flatMap(componentId => {
                const was = before.get(componentId);
                const next = after.get(componentId);
                if (JSON.stringify(was) === JSON.stringify(next)) return [];
                const kind = this.componentOverrideActionKind(was, next);
                return [
                    this.curationAction({
                        kind,
                        targetId: componentId,
                        metadata: { override: next ?? null },
                    }),
                ];
            });
    }

    private componentOverrideActionKind(
        previous: WorkspaceIntelligenceComponentOverride | undefined,
        next: WorkspaceIntelligenceComponentOverride | undefined,
    ): WorkspaceIntelligenceCurationActionKind {
        if (next === undefined) return 'component.clear';
        if (previous?.mergeGroup !== next.mergeGroup)
            return next.mergeGroup === undefined
                ? 'component.split'
                : 'component.merge';
        if (previous?.displayName !== next.displayName)
            return 'component.rename';
        if (previous?.kind !== next.kind) return 'component.reclassify';
        if (previous?.suppressed !== next.suppressed)
            return 'component.suppress';
        return 'component.annotate';
    }

    private curationAction(
        request: WorkspaceIntelligenceCurationActionRequest,
    ): WorkspaceIntelligenceCurationAction {
        return {
            id: `curation-${this.#runtime.now()}-${++this.#nextCurationActionId}`,
            at: this.#runtime.now(),
            actor: request.actor?.trim() || 'local-user',
            kind: request.kind,
            targetId: request.targetId,
            evidence: request.evidence ?? [],
            ...(request.metadata === undefined
                ? {}
                : { metadata: request.metadata }),
        };
    }

    private async withCurationWrite<A>(
        engagementId: EngagementId,
        operation: () => Promise<A>,
    ): Promise<A> {
        const previous = this.#curationWrites.get(engagementId);
        let release: () => void;
        const next = new Promise<void>(resolve => {
            release = resolve;
        });
        this.#curationWrites.set(engagementId, next);
        await previous;
        try {
            return await operation();
        } finally {
            release!();
            if (this.#curationWrites.get(engagementId) === next)
                this.#curationWrites.delete(engagementId);
        }
    }

    private assertReadable(run: WorkspaceIntelligenceRun): void {
        if (!run.isValid)
            throw new WorkspaceIntelligenceError(
                'repoLocked',
                'This run is not a validated finalized artifact.',
            );
    }

    private async withCurrent(
        run: WorkspaceIntelligenceRun,
    ): Promise<WorkspaceIntelligenceRun> {
        const currentId = await this.#store.currentRunId(run.engagementId);
        return new WorkspaceIntelligenceRun({
            ...run,
            isCurrent: currentId === run.id,
        });
    }

    /**
     * Staleness is an ephemeral comparison of a current artifact's recorded
     * source fingerprints with host-owned repository inputs. It never mutates
     * history and is intentionally unavailable when the host cannot probe.
     */
    private async withStaleness(
        run: WorkspaceIntelligenceRun,
    ): Promise<WorkspaceIntelligenceRun> {
        if (
            !run.isCurrent ||
            !run.isValid ||
            this.#runtime.fingerprintRepository === undefined
        )
            return new WorkspaceIntelligenceRun({ ...run, isStale: false });
        try {
            const settings = this.settingsFor(run);
            const workspace = await this.#workspace.resolveWorkspace(
                run.engagementId,
            );
            if (workspace === undefined)
                return new WorkspaceIntelligenceRun({ ...run, isStale: true });
            const members = new Map(
                workspace.repositories.map(repository => [
                    repository.repoId,
                    repository,
                ]),
            );
            const checks = await Promise.all(
                run.repoIds.map(async repoId => {
                    const repository = members.get(repoId);
                    if (repository === undefined) return true;
                    const [fingerprint, analysis] = await Promise.all([
                        this.#runtime.fingerprintRepository?.(
                            repository,
                            settings,
                        ),
                        this.#store.readRepositoryAnalysis(
                            run.engagementId,
                            run.id,
                            repoId,
                        ),
                    ]);
                    // Legacy artifacts may not have a reusable repository result.
                    // Their freshness is unknown rather than falsely stale.
                    return (
                        fingerprint !== undefined &&
                        analysis?.repository !== undefined &&
                        analysis.repository.sourceFingerprint !== fingerprint
                    );
                }),
            );
            return new WorkspaceIntelligenceRun({
                ...run,
                isStale: checks.some(Boolean),
            });
        } catch {
            return new WorkspaceIntelligenceRun({ ...run, isStale: false });
        }
    }

    private async withIntegrity(
        run: WorkspaceIntelligenceRun,
    ): Promise<WorkspaceIntelligenceRun> {
        if (!isTerminal(run.state)) return run;
        return new WorkspaceIntelligenceRun({
            ...run,
            isValid:
                run.isValid &&
                (await this.#store.verifyRun(run.engagementId, run.id)),
        });
    }

    private async eventsFor(
        run: WorkspaceIntelligenceRun,
        runId: string,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceRunEvent>> {
        const active = this.#active.get(runId);
        return active === undefined
            ? this.#store.readEvents(run.engagementId, runId)
            : active.events;
    }

    private async awaitEvent(runId: string): Promise<void> {
        await new Promise<void>(resolve => {
            const listeners =
                this.#listeners.get(runId) ?? new Set<() => void>();
            listeners.add(resolve);
            this.#listeners.set(runId, listeners);
        });
    }

    private notify(runId: string): void {
        const listeners = this.#listeners.get(runId);
        if (listeners === undefined) return;
        this.#listeners.delete(runId);
        for (const listener of listeners) listener();
    }
}
