import type {
    EngagementId,
    WorkspaceIntelligenceRun,
    WorkspaceIntelligenceRunEvent,
} from '@cbranch/rpc-contract';
import { WorkspaceIntelligencePresentation } from '@cbranch/rpc-contract';

import type { WorkspaceIntelligenceFileSystem } from './ports';
import type { WorkspaceIntelligenceAnalysis } from './analysis';
import { deterministicAnalyzerRegistry } from './analyzer-registry';
import {
    defaultWorkspaceIntelligenceAnalysisSettings,
    normalizeWorkspaceIntelligenceAnalysisSettings,
    type WorkspaceIntelligenceAnalysisSettings,
} from './analysis-settings';

export const WORKSPACE_INTELLIGENCE_SCHEMA_VERSION = 1;
/** Maximum graph records that one host response may expose to the browser. */
export const MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES = 2_000;
/** A one-hop neighborhood reserves one node for its selected anchor. */
export const MAX_WORKSPACE_INTELLIGENCE_NEIGHBORHOOD_EDGES =
    MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES - 1;
/** Persisted graph layout is bounded to the browser's maximum graph surface. */
export const MAX_WORKSPACE_INTELLIGENCE_PRESENTATION_NODES =
    MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES;
const MIN_READABLE_WORKSPACE_INTELLIGENCE_SCHEMA_VERSION = 0;

export interface WorkspaceIntelligenceArtifactStoreOptions {
    readonly rootDirectory: string;
    readonly fileSystem: WorkspaceIntelligenceFileSystem;
    readonly digest: (text: string) => Promise<string>;
}

interface IntegrityDocument {
    readonly schemaVersion: number;
    readonly files: Readonly<Record<string, string>>;
}

const isReadableSchemaVersion = (value: unknown): value is number =>
    typeof value === 'number' &&
    value >= MIN_READABLE_WORKSPACE_INTELLIGENCE_SCHEMA_VERSION &&
    value <= WORKSPACE_INTELLIGENCE_SCHEMA_VERSION;

/**
 * Version 0 manifests predate an explicit workspace membership snapshot. The
 * selected analysis subset was the only persisted membership data, so retain
 * it as the in-memory compatibility snapshot. Artifacts are never rewritten.
 */
const migrateRunManifest = (
    value: unknown,
): WorkspaceIntelligenceRun | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const document = value as {
        readonly schemaVersion?: unknown;
        readonly run?: unknown;
    };
    if (!isReadableSchemaVersion(document.schemaVersion)) return undefined;
    if (document.run === null || typeof document.run !== 'object')
        return undefined;
    const run = document.run as WorkspaceIntelligenceRun;
    if (
        document.schemaVersion === 0 &&
        !Array.isArray(run.workspaceRepoIds) &&
        Array.isArray(run.repoIds)
    )
        return { ...run, workspaceRepoIds: run.repoIds };
    return run;
};

export interface WorkspaceIntelligenceStoredGraphNode {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly repoId: string;
    readonly evidence: ReadonlyArray<unknown>;
}

export interface WorkspaceIntelligenceStoredGraphEdge {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
    readonly evidence: ReadonlyArray<unknown>;
}

/** A bounded, host-selected graph record safe to provide to an inference runner. */
export interface WorkspaceIntelligenceInferenceEvidence {
    readonly id: string;
    readonly content: string;
}

export interface WorkspaceIntelligenceGraphDiff {
    readonly addedNodeIds: ReadonlyArray<string>;
    readonly removedNodeIds: ReadonlyArray<string>;
    readonly changedNodeIds: ReadonlyArray<string>;
    readonly addedEdgeIds: ReadonlyArray<string>;
    readonly removedEdgeIds: ReadonlyArray<string>;
    readonly changedEdgeIds: ReadonlyArray<string>;
    readonly addedComponentIds: ReadonlyArray<string>;
    readonly removedComponentIds: ReadonlyArray<string>;
    readonly changedComponentIds: ReadonlyArray<string>;
    readonly addedContractIds: ReadonlyArray<string>;
    readonly removedContractIds: ReadonlyArray<string>;
    readonly changedContractIds: ReadonlyArray<string>;
    readonly addedChannelIds: ReadonlyArray<string>;
    readonly removedChannelIds: ReadonlyArray<string>;
    readonly changedChannelIds: ReadonlyArray<string>;
    readonly addedFindingIds: ReadonlyArray<string>;
    readonly removedFindingIds: ReadonlyArray<string>;
    readonly changedFindingIds: ReadonlyArray<string>;
}

export interface WorkspaceIntelligenceComponentOverride {
    readonly componentId: string;
    readonly displayName?: string;
    readonly kind?: string;
    readonly suppressed?: boolean;
    readonly note?: string;
    /**
     * Workspace-local presentation group. Components with the same non-empty
     * value are rendered as one reversible curated boundary.
     */
    readonly mergeGroup?: string;
    /** Human-facing label for a presentation group. */
    readonly mergeGroupLabel?: string;
    /** Read-time presentation status; never written into curation storage. */
    readonly isOrphaned?: boolean;
}

export type WorkspaceIntelligenceCurationActionKind =
    | 'component.merge'
    | 'component.split'
    | 'component.rename'
    | 'component.reclassify'
    | 'component.suppress'
    | 'component.annotate'
    | 'component.clear'
    | 'edge.confirm'
    | 'edge.reject'
    | 'edge.annotate'
    | 'edge.clear';

export interface WorkspaceIntelligenceCurationAction {
    readonly id: string;
    readonly at: number;
    readonly actor: string;
    readonly kind: WorkspaceIntelligenceCurationActionKind;
    readonly targetId: string;
    readonly evidence: ReadonlyArray<unknown>;
    readonly metadata?: unknown;
}

export interface WorkspaceIntelligenceCurationActionRequest {
    readonly actor?: string;
    readonly kind: WorkspaceIntelligenceCurationActionKind;
    readonly targetId: string;
    readonly evidence?: ReadonlyArray<unknown>;
    readonly metadata?: unknown;
}

interface WorkspaceIntelligenceCurationState {
    readonly schemaVersion: number;
    readonly componentOverrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>;
    readonly edgeActions: ReadonlyArray<WorkspaceIntelligenceCurationAction>;
}

export interface WorkspaceIntelligenceArchiveEntry {
    readonly path: string;
    readonly text: string;
}

export interface WorkspaceIntelligenceFinding {
    readonly id: string;
    readonly kind: string;
    readonly severity: 'info' | 'warning';
    readonly message: string;
    readonly nodeIds: ReadonlyArray<string>;
}

const join = (...parts: ReadonlyArray<string>): string =>
    parts.join('/').replaceAll(/\/+/g, '/');

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const MERMAID_NODE_LIMIT = 100;
const MERMAID_EDGE_LIMIT = 200;
const FINDING_LIMIT = 200;
const GRAPH_CACHE_LIMIT = 8;

const defaultPresentation = (
    runId: WorkspaceIntelligenceRun['id'],
): WorkspaceIntelligencePresentation =>
    new WorkspaceIntelligencePresentation({
        schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
        runId,
        expandedNodeIds: [],
        nodePositions: [],
        showInferredEdges: false,
        minimumConfidenceTier: 'low',
    });

/**
 * Presentation is mutable and non-authoritative. Corrupt or oversized state
 * is bounded or discarded; it can never make a validated run unreadable.
 */
const normalizePresentation = (
    value: unknown,
    runId: WorkspaceIntelligenceRun['id'],
): WorkspaceIntelligencePresentation => {
    if (value === null || typeof value !== 'object')
        return defaultPresentation(runId);
    const presentation = value as {
        readonly selectedNodeId?: unknown;
        readonly expandedNodeIds?: unknown;
        readonly nodePositions?: unknown;
        readonly showInferredEdges?: unknown;
        readonly minimumConfidenceTier?: unknown;
    };
    const expandedNodeIds = Array.isArray(presentation.expandedNodeIds)
        ? [
              ...new Set(
                  presentation.expandedNodeIds.filter(
                      (nodeId): nodeId is string =>
                          typeof nodeId === 'string' && nodeId.length <= 1_024,
                  ),
              ),
          ].slice(0, MAX_WORKSPACE_INTELLIGENCE_PRESENTATION_NODES)
        : [];
    const nodePositions = Array.isArray(presentation.nodePositions)
        ? [
              ...new Map(
                  presentation.nodePositions.flatMap(position => {
                      if (position === null || typeof position !== 'object')
                          return [];
                      const item = position as {
                          readonly nodeId?: unknown;
                          readonly x?: unknown;
                          readonly y?: unknown;
                      };
                      return typeof item.nodeId === 'string' &&
                          item.nodeId.length <= 1_024 &&
                          typeof item.x === 'number' &&
                          Number.isFinite(item.x) &&
                          typeof item.y === 'number' &&
                          Number.isFinite(item.y)
                          ? [
                                [
                                    item.nodeId,
                                    {
                                        nodeId: item.nodeId,
                                        x: item.x,
                                        y: item.y,
                                    },
                                ] as const,
                            ]
                          : [];
                  }),
              ).values(),
          ]
              .slice(0, MAX_WORKSPACE_INTELLIGENCE_PRESENTATION_NODES)
              .toSorted((left, right) =>
                  left.nodeId.localeCompare(right.nodeId),
              )
        : [];
    return new WorkspaceIntelligencePresentation({
        schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
        runId,
        ...(typeof presentation.selectedNodeId === 'string' &&
        presentation.selectedNodeId.length <= 1_024
            ? { selectedNodeId: presentation.selectedNodeId }
            : {}),
        expandedNodeIds,
        nodePositions,
        showInferredEdges: presentation.showInferredEdges === true,
        minimumConfidenceTier:
            presentation.minimumConfidenceTier === 'medium' ||
            presentation.minimumConfidenceTier === 'high'
                ? presentation.minimumConfidenceTier
                : 'low',
    });
};

const mermaidLabel = (value: string): string =>
    value
        .replaceAll('"', "'")
        .replaceAll(/[\r\n]+/g, ' ')
        .slice(0, 120);

/** A bounded, deterministic component/package sketch for the Markdown report. */
const mermaid = (
    analyses: ReadonlyArray<WorkspaceIntelligenceAnalysis>,
): string => {
    const nodes = analyses
        .flatMap(analysis => analysis.nodes)
        .flatMap(value => {
            const id = value.id;
            const label = value.label;
            return typeof id === 'string' && typeof label === 'string'
                ? [{ id, label }]
                : [];
        })
        .sort((left, right) => left.id.localeCompare(right.id));
    const uniqueNodes = [
        ...new Map(nodes.map(value => [value.id, value])).values(),
    ].slice(0, MERMAID_NODE_LIMIT);
    const aliases = new Map(
        uniqueNodes.map((value, index) => [value.id, `N${index + 1}`]),
    );
    const edges = analyses
        .flatMap(analysis => analysis.edges)
        .flatMap(value => {
            const from = value.from;
            const to = value.to;
            const kind = value.kind;
            return typeof from === 'string' &&
                typeof to === 'string' &&
                typeof kind === 'string' &&
                aliases.has(from) &&
                aliases.has(to)
                ? [{ from, to, kind }]
                : [];
        })
        .sort((left, right) =>
            `${left.from}\0${left.to}\0${left.kind}`.localeCompare(
                `${right.from}\0${right.to}\0${right.kind}`,
            ),
        )
        .slice(0, MERMAID_EDGE_LIMIT);
    const lines = ['flowchart LR'];
    for (const value of uniqueNodes)
        lines.push(`${aliases.get(value.id)}["${mermaidLabel(value.label)}"]`);
    for (const edge of edges)
        lines.push(
            `${aliases.get(edge.from)} -->|${mermaidLabel(edge.kind)}| ${aliases.get(edge.to)}`,
        );
    if (nodes.length > uniqueNodes.length || edges.length >= MERMAID_EDGE_LIMIT)
        lines.push(
            'TRUNCATED["Architecture sketch is bounded; inspect graph artifacts for all records."]',
        );
    return lines.join('\n');
};

const storedNode = (
    value: Record<string, unknown>,
): WorkspaceIntelligenceStoredGraphNode | undefined =>
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.label === 'string' &&
    typeof value.repoId === 'string'
        ? {
              id: value.id,
              kind: value.kind,
              label: value.label,
              repoId: value.repoId,
              evidence: Array.isArray(value.evidence) ? value.evidence : [],
          }
        : undefined;

const storedEdge = (
    value: Record<string, unknown>,
): WorkspaceIntelligenceStoredGraphEdge | undefined =>
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.kind === 'string'
        ? {
              from: value.from,
              to: value.to,
              kind: value.kind,
              evidence: Array.isArray(value.evidence) ? value.evidence : [],
          }
        : undefined;

interface CachedGraph {
    readonly nodes: ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>;
    readonly edges: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>;
}

const mergeEvidence = (
    ...values: ReadonlyArray<ReadonlyArray<unknown>>
): ReadonlyArray<unknown> =>
    [
        ...new Map(
            values.flat().map(value => [JSON.stringify(value), value]),
        ).values(),
    ].toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

const curationActionKinds = new Set<WorkspaceIntelligenceCurationActionKind>([
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

const storedCurationAction = (
    value: unknown,
): WorkspaceIntelligenceCurationAction | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string' &&
        typeof record.at === 'number' &&
        typeof record.actor === 'string' &&
        typeof record.kind === 'string' &&
        curationActionKinds.has(
            record.kind as WorkspaceIntelligenceCurationActionKind,
        ) &&
        typeof record.targetId === 'string' &&
        Array.isArray(record.evidence)
        ? {
              id: record.id,
              at: record.at,
              actor: record.actor,
              kind: record.kind as WorkspaceIntelligenceCurationActionKind,
              targetId: record.targetId,
              evidence: record.evidence,
              ...(record.metadata === undefined
                  ? {}
                  : { metadata: record.metadata }),
          }
        : undefined;
};

const mergeGraphNodes = (
    values: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<WorkspaceIntelligenceStoredGraphNode> => {
    const result = new Map<string, WorkspaceIntelligenceStoredGraphNode>();
    for (const value of values) {
        const record = storedNode(value);
        if (record === undefined) continue;
        const existing = result.get(record.id);
        result.set(
            record.id,
            existing === undefined
                ? record
                : {
                      ...existing,
                      evidence: mergeEvidence(
                          existing.evidence,
                          record.evidence,
                      ),
                  },
        );
    }
    return [...result.values()].toSorted((left, right) =>
        left.id.localeCompare(right.id),
    );
};

const mergeGraphEdges = (
    values: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge> => {
    const result = new Map<string, WorkspaceIntelligenceStoredGraphEdge>();
    for (const value of values) {
        const record = storedEdge(value);
        if (record === undefined) continue;
        const key = `${record.from}\0${record.kind}\0${record.to}`;
        const existing = result.get(key);
        result.set(
            key,
            existing === undefined
                ? record
                : {
                      ...existing,
                      evidence: mergeEvidence(
                          existing.evidence,
                          record.evidence,
                      ),
                  },
        );
    }
    return [...result.values()].toSorted((left, right) =>
        `${left.from}\0${left.kind}\0${left.to}`.localeCompare(
            `${right.from}\0${right.kind}\0${right.to}`,
        ),
    );
};

/** Deterministic architecture-only findings; no source or host paths are retained. */
const findings = (
    nodes: ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>,
    edges: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>,
    unknowns: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<WorkspaceIntelligenceFinding> => {
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const result: WorkspaceIntelligenceFinding[] = [];
    const add = (finding: WorkspaceIntelligenceFinding) => {
        if (result.length < FINDING_LIMIT) result.push(finding);
    };
    const unresolvedKinds = new Set([
        'imports',
        'depends-on',
        'references',
        'calls',
        'uses',
        'implements',
        'exposes-contract',
        'consumes-contract',
        'publishes',
        'subscribes',
        'invokes',
    ]);
    for (const edge of edges) {
        if (
            unresolvedKinds.has(edge.kind) &&
            nodeById.has(edge.from) &&
            !nodeById.has(edge.to)
        )
            add({
                id: `unresolved:${edge.from}\0${edge.kind}\0${edge.to}`,
                kind: 'architecture.unresolved-reference',
                severity: 'warning',
                message: `Unresolved ${edge.kind} target: ${edge.to}.`,
                nodeIds: [edge.from],
            });
    }

    const adjacency = new Map<string, string[]>();
    const degree = new Map<string, number>();
    const crossRepository = new Map<string, string[]>();
    for (const node of nodes) {
        adjacency.set(node.id, []);
        degree.set(node.id, 0);
    }
    for (const edge of edges) {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (from === undefined || to === undefined) continue;
        adjacency.get(from.id)?.push(to.id);
        degree.set(from.id, (degree.get(from.id) ?? 0) + 1);
        degree.set(to.id, (degree.get(to.id) ?? 0) + 1);
        if (
            from.repoId !== to.repoId &&
            from.kind !== 'external.dependency' &&
            to.kind !== 'external.dependency'
        ) {
            const key = `${from.repoId}\0${to.repoId}`;
            crossRepository.set(key, [
                ...(crossRepository.get(key) ?? []),
                from.id,
                to.id,
            ]);
        }
    }
    for (const [key, nodeIds] of crossRepository) {
        const [fromRepoId, toRepoId] = key.split('\0');
        add({
            id: `cross-repository:${key}`,
            kind: 'architecture.cross-repository-dependency',
            severity: 'info',
            message: `Verified graph relationships cross from ${fromRepoId} to ${toRepoId}.`,
            nodeIds: [...new Set(nodeIds)].toSorted(),
        });
    }
    for (const [nodeId, count] of degree) {
        if (count < 12) continue;
        add({
            id: `high-coupling:${nodeId}`,
            kind: 'architecture.high-coupling',
            severity: 'info',
            message: `${nodeId} has ${count} verified graph relationships.`,
            nodeIds: [nodeId],
        });
    }

    const state = new Map<string, 'active' | 'complete'>();
    const seenCycles = new Set<string>();
    for (const start of [...nodeById.keys()].toSorted()) {
        if (state.has(start) || result.length >= FINDING_LIMIT) continue;
        const stack: Array<{ id: string; next: number }> = [
            { id: start, next: 0 },
        ];
        const activeIndex = new Map([[start, 0]]);
        state.set(start, 'active');
        while (stack.length > 0 && result.length < FINDING_LIMIT) {
            const frame = stack.at(-1);
            if (frame === undefined) break;
            const nextId = adjacency.get(frame.id)?.[frame.next];
            if (nextId === undefined) {
                state.set(frame.id, 'complete');
                activeIndex.delete(frame.id);
                stack.pop();
                continue;
            }
            frame.next += 1;
            if (state.get(nextId) === 'active') {
                const index = activeIndex.get(nextId);
                if (index === undefined) continue;
                const cycle = stack.slice(index).map(item => item.id);
                const key = [...cycle].toSorted().join('\0');
                if (seenCycles.has(key)) continue;
                seenCycles.add(key);
                add({
                    id: `cycle:${key}`,
                    kind: 'architecture.cycle',
                    severity: 'warning',
                    message: `Verified dependency cycle involving ${cycle.length} graph nodes.`,
                    nodeIds: [...cycle].toSorted(),
                });
                continue;
            }
            if (state.has(nextId)) continue;
            state.set(nextId, 'active');
            activeIndex.set(nextId, stack.length);
            stack.push({ id: nextId, next: 0 });
        }
    }

    const unknownCounts = new Map<string, number>();
    for (const unknown of unknowns) {
        if (typeof unknown.kind !== 'string') continue;
        unknownCounts.set(
            unknown.kind,
            (unknownCounts.get(unknown.kind) ?? 0) + 1,
        );
    }
    for (const [kind, count] of unknownCounts)
        add({
            id: `capability-gap:${kind}`,
            kind: 'architecture.capability-gap',
            severity: 'warning',
            message: `${count} explicit ${kind} observation${count === 1 ? '' : 's'} limit this report.`,
            nodeIds: [],
        });
    return result.toSorted((left, right) => left.id.localeCompare(right.id));
};

/**
 * Filesystem-backed immutable run artifacts. All mutations are atomic whole-file
 * replacements; completed runs are only finalized once and subsequently read-only.
 */
export class WorkspaceIntelligenceArtifactStore {
    readonly #root: string;
    readonly #fs: WorkspaceIntelligenceFileSystem;
    readonly #digest: (text: string) => Promise<string>;
    readonly #graphCache = new Map<string, CachedGraph>();

    constructor(options: WorkspaceIntelligenceArtifactStoreOptions) {
        this.#root = options.rootDirectory;
        this.#fs = options.fileSystem;
        this.#digest = options.digest;
    }

    workspaceDirectory(engagementId: EngagementId): string {
        return join(this.#root, 'workspaces', engagementId);
    }

    /** Mutable workspace policy; immutable runs retain their own effective snapshot. */
    async readAnalysisSettings(
        engagementId: EngagementId,
    ): Promise<WorkspaceIntelligenceAnalysisSettings> {
        const text = await this.#fs.readText(
            join(this.workspaceDirectory(engagementId), 'settings.json'),
        );
        if (text === undefined)
            return defaultWorkspaceIntelligenceAnalysisSettings;
        try {
            const document = JSON.parse(text) as {
                readonly settings?: WorkspaceIntelligenceAnalysisSettings;
            };
            if (document.settings === undefined)
                return defaultWorkspaceIntelligenceAnalysisSettings;
            return normalizeWorkspaceIntelligenceAnalysisSettings(
                document.settings,
            );
        } catch {
            // Mutable settings must not make validated immutable run history unreadable.
            return defaultWorkspaceIntelligenceAnalysisSettings;
        }
    }

    async writeAnalysisSettings(
        engagementId: EngagementId,
        settings: WorkspaceIntelligenceAnalysisSettings,
    ): Promise<WorkspaceIntelligenceAnalysisSettings> {
        const normalized =
            normalizeWorkspaceIntelligenceAnalysisSettings(settings);
        await this.#fs.mkdir(this.workspaceDirectory(engagementId));
        await this.writeAtomic(
            join(this.workspaceDirectory(engagementId), 'settings.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                settings: normalized,
            }),
        );
        return normalized;
    }

    curationDirectory(engagementId: EngagementId): string {
        return join(this.workspaceDirectory(engagementId), 'curation');
    }

    presentationDirectory(engagementId: EngagementId): string {
        return join(this.workspaceDirectory(engagementId), 'presentation');
    }

    async readPresentation(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRun['id'],
    ): Promise<WorkspaceIntelligencePresentation> {
        const text = await this.#fs.readText(
            join(this.presentationDirectory(engagementId), `${runId}.json`),
        );
        if (text === undefined) return defaultPresentation(runId);
        try {
            return normalizePresentation(JSON.parse(text), runId);
        } catch {
            return defaultPresentation(runId);
        }
    }

    async writePresentation(
        engagementId: EngagementId,
        presentation: WorkspaceIntelligencePresentation,
    ): Promise<WorkspaceIntelligencePresentation> {
        const normalized = normalizePresentation(
            presentation,
            presentation.runId,
        );
        const directory = this.presentationDirectory(engagementId);
        await this.#fs.mkdir(directory);
        await this.writeAtomic(
            join(directory, `${normalized.runId}.json`),
            json(normalized),
        );
        return normalized;
    }

    async readComponentOverrides(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceComponentOverride>> {
        const text = await this.#fs.readText(
            join(
                this.curationDirectory(engagementId),
                'component-overrides.json',
            ),
        );
        if (text === undefined) return [];
        try {
            const document = JSON.parse(text) as {
                readonly overrides?: unknown;
            };
            return Array.isArray(document.overrides)
                ? (document.overrides as WorkspaceIntelligenceComponentOverride[])
                : [];
        } catch {
            // Curation is mutable presentation data. It must never make a
            // separately validated immutable run unreadable.
            return [];
        }
    }

    async writeComponentOverrides(
        engagementId: EngagementId,
        overrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
    ): Promise<void> {
        const directory = this.curationDirectory(engagementId);
        await this.#fs.mkdir(directory);
        await this.writeAtomic(
            join(directory, 'component-overrides.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                overrides: [...overrides].toSorted((left, right) =>
                    left.componentId.localeCompare(right.componentId),
                ),
            }),
        );
        await this.writeCurationState(
            engagementId,
            overrides,
            await this.readCurationActions(engagementId),
        );
    }

    /** Reads the durable audit history; malformed entries fail closed by omission. */
    async readCurationActions(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceCurationAction>> {
        const text = await this.#fs.readText(
            join(this.curationDirectory(engagementId), 'actions.jsonl'),
        );
        if (text === undefined || text.trim() === '') return [];
        return text
            .trim()
            .split('\n')
            .flatMap(line => {
                try {
                    const action = storedCurationAction(JSON.parse(line));
                    return action === undefined ? [] : [action];
                } catch {
                    return [];
                }
            });
    }

    /**
     * Rewrites the append-only JSONL log atomically and refreshes its compact
     * workspace projection. The log itself is intentionally excluded from a
     * run archive.
     */
    async writeCurationActions(
        engagementId: EngagementId,
        actions: ReadonlyArray<WorkspaceIntelligenceCurationAction>,
    ): Promise<void> {
        const directory = this.curationDirectory(engagementId);
        await this.#fs.mkdir(directory);
        await this.writeAtomic(
            join(directory, 'actions.jsonl'),
            actions.map(action => JSON.stringify(action)).join('\n'),
        );
        await this.writeCurationState(
            engagementId,
            await this.readComponentOverrides(engagementId),
            actions,
        );
    }

    async readCurationState(
        engagementId: EngagementId,
    ): Promise<WorkspaceIntelligenceCurationState | undefined> {
        const text = await this.#fs.readText(
            join(this.curationDirectory(engagementId), 'current-state.json'),
        );
        if (text === undefined) return undefined;
        try {
            const value = JSON.parse(text) as {
                readonly schemaVersion?: unknown;
                readonly componentOverrides?: unknown;
                readonly edgeActions?: unknown;
            };
            if (
                !isReadableSchemaVersion(value.schemaVersion) ||
                !Array.isArray(value.componentOverrides) ||
                !Array.isArray(value.edgeActions)
            )
                return undefined;
            return {
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                componentOverrides:
                    value.componentOverrides as WorkspaceIntelligenceComponentOverride[],
                edgeActions: value.edgeActions.flatMap(candidate => {
                    const action = storedCurationAction(candidate);
                    return action === undefined ? [] : [action];
                }),
            };
        } catch {
            return undefined;
        }
    }

    runDirectory(engagementId: EngagementId, runId: string): string {
        return join(this.workspaceDirectory(engagementId), 'runs', runId);
    }

    async deleteRun(engagementId: EngagementId, runId: string): Promise<void> {
        this.#graphCache.delete(this.#graphCacheKey(engagementId, runId));
        await this.#fs.remove(this.runDirectory(engagementId, runId));
        // Optional inference children cannot outlive their deterministic parent.
        // The workspace-level preferred pointer is intentionally retained as
        // mutable presentation state; it resolves to no attempt after cleanup.
        await this.#fs.remove(
            join(this.workspaceDirectory(engagementId), 'enrichments', runId),
        );
        // Rebuildable semantic caches are similarly scoped to one immutable run.
        await this.#fs.remove(
            join(this.workspaceDirectory(engagementId), 'semantic', runId),
        );
        await this.#fs.remove(
            join(this.presentationDirectory(engagementId), `${runId}.json`),
        );
    }

    /** Removes only derived and immutable run history, never workspace curation. */
    async clearRunHistory(engagementId: EngagementId): Promise<void> {
        const prefix = `${engagementId}\0`;
        for (const key of this.#graphCache.keys())
            if (key.startsWith(prefix)) this.#graphCache.delete(key);
        const directory = this.workspaceDirectory(engagementId);
        await Promise.all([
            this.#fs.remove(join(directory, 'runs')),
            this.#fs.remove(join(directory, 'enrichments')),
            this.#fs.remove(join(directory, 'semantic')),
            this.#fs.remove(join(directory, 'presentation')),
            this.#fs.remove(join(directory, 'current.json')),
        ]);
    }

    /**
     * Collects the immutable selected run and a point-in-time curation snapshot
     * for an export. It deliberately excludes workspace settings and curation
     * history, and never reads repository source paths.
     */
    async archiveEntries(
        engagementId: EngagementId,
        runId: string,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceArchiveEntry>> {
        const directory = this.runDirectory(engagementId, runId);
        const integrityText = await this.#fs.readText(
            join(directory, 'integrity.json'),
        );
        if (integrityText === undefined)
            throw new Error(
                'Run archive is unavailable without integrity data.',
            );
        const integrity = JSON.parse(integrityText) as IntegrityDocument;
        const files = await Promise.all(
            Object.keys(integrity.files)
                .toSorted()
                .map(async path => {
                    const text = await this.#fs.readText(join(directory, path));
                    if (text === undefined)
                        throw new Error(`Run archive is missing ${path}.`);
                    return { path: `run/${path}`, text };
                }),
        );
        const overrides = await this.readComponentOverrides(engagementId);
        return [
            ...files,
            { path: 'run/integrity.json', text: integrityText },
            {
                path: 'curation/component-overrides.json',
                text: json({
                    schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                    overrides,
                }),
            },
            {
                path: 'archive-manifest.json',
                text: json({
                    schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                    runId,
                    format: 'workspace-intelligence-artifact-export',
                }),
            },
        ].toSorted((left, right) => left.path.localeCompare(right.path));
    }

    async writeRun(
        run: WorkspaceIntelligenceRun,
        events: ReadonlyArray<WorkspaceIntelligenceRunEvent>,
    ): Promise<void> {
        const directory = this.runDirectory(run.engagementId, run.id);
        await this.#fs.mkdir(join(directory, 'graph'));
        await this.#fs.mkdir(join(directory, 'repositories'));
        await this.writeAtomic(
            join(directory, 'manifest.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                run,
            }),
        );
        await this.writeAtomic(
            join(directory, 'coverage.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                coverage: run.coverage,
            }),
        );
        await this.writeAtomic(
            join(directory, 'events.jsonl'),
            events.map(event => JSON.stringify(event)).join('\n') +
                (events.length === 0 ? '' : '\n'),
        );
    }

    async finalize(
        run: WorkspaceIntelligenceRun,
        events: ReadonlyArray<WorkspaceIntelligenceRunEvent>,
        analyses: ReadonlyArray<WorkspaceIntelligenceAnalysis> = [],
    ): Promise<void> {
        this.#graphCache.delete(this.#graphCacheKey(run.engagementId, run.id));
        await this.writeRun(run, events);
        const directory = this.runDirectory(run.engagementId, run.id);
        const architectureSketch = mermaid(analyses);
        const graphNodeRecords = mergeGraphNodes(
            analyses.flatMap(analysis => analysis.nodes),
        );
        const graphEdgeRecords = mergeGraphEdges(
            analyses.flatMap(analysis => analysis.edges),
        );
        const unknowns = analyses.flatMap(analysis => analysis.unknowns);
        const analyzerIds = new Set(
            analyses.flatMap(analysis => analysis.analyzerIds ?? []),
        );
        const analyzers = deterministicAnalyzerRegistry
            .filter(analyzer =>
                analyzerIds.has(`${analyzer.id}@${analyzer.version}`),
            )
            .map(analyzer => ({
                id: analyzer.id,
                version: analyzer.version,
                capabilities: analyzer.capabilities,
                limitations: analyzer.limitations,
            }));
        const architectureFindings = findings(
            graphNodeRecords,
            graphEdgeRecords,
            unknowns,
        );
        const externalDependencyCount = graphNodeRecords.filter(
            node => node.kind === 'external.dependency',
        ).length;
        const report = [
            '# Workspace Intelligence',
            '',
            `Run: \`${run.id}\``,
            `Workspace: \`${run.engagementId}\``,
            `State: ${run.state}`,
            '',
            '## Coverage',
            '',
            run.coverage.summary,
            '',
            `Repositories completed: ${run.coverage.completedRepositoryCount}/${run.coverage.repositoryCount}`,
            `Analyzers executed: ${run.coverage.analyzerCount}`,
            `External dependencies: ${externalDependencyCount}`,
            `Analyzer registry entries: ${analyzers.length}`,
            '',
            ...analyses.flatMap(analysis => analysis.report),
            '',
            '## Architecture integrity',
            '',
            architectureFindings.length === 0
                ? 'No deterministic architecture-integrity findings were identified.'
                : architectureFindings
                      .map(
                          finding =>
                              `- **${finding.severity}** \`${finding.kind}\`: ${finding.message}`,
                      )
                      .join('\n'),
            '',
            '## Architecture sketch',
            '',
            '```mermaid',
            architectureSketch,
            '```',
            '',
        ].join('\n');
        await this.writeAtomic(join(directory, 'report.md'), report);
        await this.writeAtomic(
            join(directory, 'graph', 'architecture.mmd'),
            `${architectureSketch}\n`,
        );
        await this.writeAtomic(
            join(directory, 'graph', 'nodes.jsonl'),
            graphNodeRecords.map(value => JSON.stringify(value)).join('\n'),
        );
        await this.writeAtomic(
            join(directory, 'graph', 'edges.jsonl'),
            graphEdgeRecords.map(value => JSON.stringify(value)).join('\n'),
        );
        await this.writeAtomic(
            join(directory, 'graph', 'index.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                nodeCount: graphNodeRecords.length,
                edgeCount: graphEdgeRecords.length,
                nodeIds: graphNodeRecords.map(value => value.id),
            }),
        );
        await this.writeAtomic(
            join(directory, 'analyzers.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                analyzers,
            }),
        );
        await this.writeAtomic(
            join(directory, 'findings.jsonl'),
            architectureFindings.map(value => JSON.stringify(value)).join('\n'),
        );
        await this.writeAtomic(
            join(directory, 'unknowns.jsonl'),
            unknowns.map(value => JSON.stringify(value)).join('\n'),
        );
        for (const analysis of analyses) {
            if (analysis.repository === undefined) continue;
            const repositoryDirectory = join(
                directory,
                'repositories',
                analysis.repository.repoId,
            );
            await this.#fs.mkdir(repositoryDirectory);
            await this.writeAtomic(
                join(repositoryDirectory, 'manifest.json'),
                json({
                    schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                    repository: analysis.repository,
                }),
            );
            await this.writeAtomic(
                join(repositoryDirectory, 'analysis.json'),
                json({
                    schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                    analysis,
                }),
            );
        }
        await this.writeIntegrity(run.engagementId, run.id, analyses);
    }

    /**
     * Reads a complete per-repository result only for materializing a new,
     * independent run. Old artifacts without this file simply are not reusable.
     */
    async readRepositoryAnalysis(
        engagementId: EngagementId,
        runId: string,
        repoId: string,
    ): Promise<WorkspaceIntelligenceAnalysis | undefined> {
        const text = await this.#fs.readText(
            join(
                this.runDirectory(engagementId, runId),
                'repositories',
                repoId,
                'analysis.json',
            ),
        );
        if (text === undefined) return undefined;
        const document = JSON.parse(text) as {
            readonly analysis?: WorkspaceIntelligenceAnalysis;
        };
        return document.analysis;
    }

    async readRun(
        engagementId: EngagementId,
        runId: string,
    ): Promise<WorkspaceIntelligenceRun | undefined> {
        const text = await this.#fs.readText(
            join(this.runDirectory(engagementId, runId), 'manifest.json'),
        );
        if (text === undefined) return undefined;
        return migrateRunManifest(JSON.parse(text));
    }

    async readEvents(
        engagementId: EngagementId,
        runId: string,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceRunEvent>> {
        const text = await this.#fs.readText(
            join(this.runDirectory(engagementId, runId), 'events.jsonl'),
        );
        if (text === undefined || text.trim() === '') return [];
        return text
            .trim()
            .split('\n')
            .map(line => JSON.parse(line) as WorkspaceIntelligenceRunEvent);
    }

    async readReport(
        engagementId: EngagementId,
        runId: string,
    ): Promise<
        | {
              readonly markdown: string;
              readonly nodeCount: number;
              readonly edgeCount: number;
              readonly findingCount: number;
              readonly unknownCount: number;
          }
        | undefined
    > {
        const directory = this.runDirectory(engagementId, runId);
        const markdown = await this.#fs.readText(join(directory, 'report.md'));
        if (markdown === undefined) return undefined;
        const count = async (file: string): Promise<number> => {
            const text = await this.#fs.readText(join(directory, file));
            return text === undefined || text === ''
                ? 0
                : text.split('\n').length;
        };
        return {
            markdown,
            nodeCount: await count('graph/nodes.jsonl'),
            edgeCount: await count('graph/edges.jsonl'),
            findingCount: await count('findings.jsonl'),
            unknownCount: await count('unknowns.jsonl'),
        };
    }

    /** Reads at most `limit` matching nodes; canonical graph artifacts stay host-side. */
    async searchGraph(
        engagementId: EngagementId,
        runId: string,
        query: string,
        limit: number,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>> {
        const { nodes } = await this.#readGraph(engagementId, runId);
        const normalized = query.trim().toLowerCase();
        return nodes
            .filter(
                node =>
                    normalized === '' ||
                    `${node.id}\n${node.kind}\n${node.label}`
                        .toLowerCase()
                        .includes(normalized),
            )
            .sort((left, right) =>
                `${left.label}\0${left.id}`.localeCompare(
                    `${right.label}\0${right.id}`,
                ),
            )
            .slice(0, limit);
    }

    /** Resolves bounded stable node IDs without transferring the full graph. */
    async graphNodesByIds(
        engagementId: EngagementId,
        runId: string,
        requestedNodeIds: ReadonlyArray<string>,
        requestedLimit: number,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>> {
        const limit = Math.max(
            1,
            Math.min(
                Math.floor(requestedLimit),
                MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES,
            ),
        );
        const ids = [...new Set(requestedNodeIds)].slice(0, limit);
        if (ids.length === 0) return [];
        const byId = new Map(
            (await this.#readGraph(engagementId, runId)).nodes.map(node => [
                node.id,
                node,
            ]),
        );
        return ids.flatMap(id => {
            const node = byId.get(id);
            return node === undefined ? [] : [node];
        });
    }

    /**
     * Provides a bounded lexical/graph evidence set for optional enrichment.
     * This intentionally exposes only persisted deterministic graph records;
     * it never reopens source files or grants a provider repository access.
     */
    async inferenceEvidence(
        engagementId: EngagementId,
        runId: string,
        requestedLimit = 120,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceInferenceEvidence>> {
        const limit = Math.max(1, Math.min(Math.floor(requestedLimit), 200));
        const { nodes } = await this.#readGraph(engagementId, runId);
        const priority = (kind: string): number =>
            kind === 'component'
                ? 0
                : kind.startsWith('contract.') || kind.startsWith('channel.')
                  ? 1
                  : kind.startsWith('architecture.')
                    ? 2
                    : 3;
        return nodes
            .filter(node => node.id.length <= 512)
            .toSorted(
                (left, right) =>
                    priority(left.kind) - priority(right.kind) ||
                    left.id.localeCompare(right.id),
            )
            .slice(0, limit)
            .map(node => ({
                id: node.id,
                content: [
                    `ID: ${node.id}`,
                    `Kind: ${node.kind}`,
                    `Label: ${node.label}`,
                    `Deterministic evidence: ${JSON.stringify(node.evidence)}`,
                ]
                    .join('\n')
                    .slice(0, 12_000),
            }));
    }

    async neighborhoodGraph(
        engagementId: EngagementId,
        runId: string,
        nodeId: string,
        limit: number,
    ): Promise<{
        readonly nodes: ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>;
        readonly edges: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>;
    }> {
        const { nodes, edges: graphEdges } = await this.#readGraph(
            engagementId,
            runId,
        );
        if (!nodes.some(node => node.id === nodeId))
            return { nodes: [], edges: [] };
        const edgeLimit = Math.max(
            1,
            Math.min(
                Math.floor(limit),
                MAX_WORKSPACE_INTELLIGENCE_NEIGHBORHOOD_EDGES,
            ),
        );
        const edges = graphEdges
            .filter(edge => edge.from === nodeId || edge.to === nodeId)
            .slice(0, edgeLimit);
        const ids = new Set([
            nodeId,
            ...edges.flatMap(edge => [edge.from, edge.to]),
        ]);
        return {
            nodes: nodes
                .filter(node => ids.has(node.id))
                .slice(0, edgeLimit + 1),
            edges,
        };
    }

    /**
     * Bounded neighborhood expansion for a curated display group. The raw
     * component IDs remain the query anchors; callers transform the returned
     * projection only after this canonical read.
     */
    async neighborhoodGraphForNodes(
        engagementId: EngagementId,
        runId: string,
        nodeIds: ReadonlyArray<string>,
        limit: number,
    ): Promise<{
        readonly nodes: ReadonlyArray<WorkspaceIntelligenceStoredGraphNode>;
        readonly edges: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>;
    }> {
        const { nodes, edges: graphEdges } = await this.#readGraph(
            engagementId,
            runId,
        );
        const anchors = new Set(nodeIds);
        const maxNodeCount = Math.min(
            limit + 1,
            MAX_WORKSPACE_INTELLIGENCE_GRAPH_NODES,
        );
        const resolvedAnchors = nodes
            .filter(node => anchors.has(node.id))
            .slice(0, maxNodeCount);
        if (resolvedAnchors.length === 0) return { nodes: [], edges: [] };
        const resolvedAnchorIds = new Set(resolvedAnchors.map(node => node.id));
        const edges = graphEdges
            .filter(
                edge =>
                    resolvedAnchorIds.has(edge.from) ||
                    resolvedAnchorIds.has(edge.to),
            )
            .slice(0, Math.max(0, maxNodeCount - resolvedAnchors.length));
        const ids = new Set([
            ...resolvedAnchors.map(node => node.id),
            ...edges.flatMap(edge => [edge.from, edge.to]),
        ]);
        return {
            nodes: nodes
                .filter(node => ids.has(node.id))
                .slice(0, maxNodeCount),
            edges,
        };
    }

    /** Stable component IDs in a run, used only for read-time curation status. */
    async componentIds(
        engagementId: EngagementId,
        runId: string,
    ): Promise<ReadonlySet<string>> {
        const { nodes } = await this.#readGraph(engagementId, runId);
        return new Set(
            nodes
                .filter(node => node.kind === 'component')
                .map(node => node.id),
        );
    }

    async diffGraph(
        engagementId: EngagementId,
        fromRunId: string,
        toRunId: string,
    ): Promise<WorkspaceIntelligenceGraphDiff> {
        const [fromGraph, toGraph, fromFindings, toFindings] =
            await Promise.all([
                this.#readGraph(engagementId, fromRunId),
                this.#readGraph(engagementId, toRunId),
                this.#readFindingRecords(engagementId, fromRunId),
                this.#readFindingRecords(engagementId, toRunId),
            ]);
        const records = <A extends { readonly id: string }>(
            values: ReadonlyArray<A>,
        ): ReadonlyMap<string, A> =>
            new Map(values.map(value => [value.id, value]));
        const edges = (
            values: ReadonlyArray<WorkspaceIntelligenceStoredGraphEdge>,
        ): ReadonlyMap<string, WorkspaceIntelligenceStoredGraphEdge> =>
            new Map(
                values.map(value => [
                    `${value.from}\0${value.kind}\0${value.to}`,
                    value,
                ]),
            );
        const difference = <A>(
            left: ReadonlyMap<string, A>,
            right: ReadonlyMap<string, A>,
        ): ReadonlyArray<string> =>
            [...left.keys()].filter(value => !right.has(value)).toSorted();
        const changed = <A>(
            left: ReadonlyMap<string, A>,
            right: ReadonlyMap<string, A>,
        ): ReadonlyArray<string> =>
            [...left]
                .flatMap(([id, value]) =>
                    JSON.stringify(value) === JSON.stringify(right.get(id))
                        ? []
                        : right.has(id)
                          ? [id]
                          : [],
                )
                .toSorted();
        const fromNodes = records(fromGraph.nodes);
        const toNodes = records(toGraph.nodes);
        const fromEdges = edges(fromGraph.edges);
        const toEdges = edges(toGraph.edges);
        const fromFindingRecords = records(fromFindings);
        const toFindingRecords = records(toFindings);
        const addedNodeIds = difference(toNodes, fromNodes);
        const removedNodeIds = difference(fromNodes, toNodes);
        const changedNodeIds = changed(fromNodes, toNodes);
        const idsByKind = (
            ids: ReadonlyArray<string>,
            values: ReadonlyMap<string, WorkspaceIntelligenceStoredGraphNode>,
            predicate: (kind: string) => boolean,
        ): ReadonlyArray<string> =>
            ids.filter(id => {
                const node = values.get(id);
                return node !== undefined && predicate(node.kind);
            });
        const component = (kind: string): boolean => kind === 'component';
        const contract = (kind: string): boolean =>
            kind.startsWith('contract.');
        const channel = (kind: string): boolean => kind.startsWith('channel.');
        return {
            addedNodeIds,
            removedNodeIds,
            changedNodeIds,
            addedEdgeIds: difference(toEdges, fromEdges),
            removedEdgeIds: difference(fromEdges, toEdges),
            changedEdgeIds: changed(fromEdges, toEdges),
            addedComponentIds: idsByKind(addedNodeIds, toNodes, component),
            removedComponentIds: idsByKind(
                removedNodeIds,
                fromNodes,
                component,
            ),
            changedComponentIds: idsByKind(changedNodeIds, toNodes, component),
            addedContractIds: idsByKind(addedNodeIds, toNodes, contract),
            removedContractIds: idsByKind(removedNodeIds, fromNodes, contract),
            changedContractIds: idsByKind(changedNodeIds, toNodes, contract),
            addedChannelIds: idsByKind(addedNodeIds, toNodes, channel),
            removedChannelIds: idsByKind(removedNodeIds, fromNodes, channel),
            changedChannelIds: idsByKind(changedNodeIds, toNodes, channel),
            addedFindingIds: difference(toFindingRecords, fromFindingRecords),
            removedFindingIds: difference(fromFindingRecords, toFindingRecords),
            changedFindingIds: changed(fromFindingRecords, toFindingRecords),
        };
    }

    async listRuns(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceRun>> {
        const entries = await this.#fs.listDirectory(
            join(this.workspaceDirectory(engagementId), 'runs'),
        );
        const runs = await Promise.all(
            entries.map(entry => this.readRun(engagementId, entry)),
        );
        return runs.filter(
            (run): run is WorkspaceIntelligenceRun => run !== undefined,
        );
    }

    async listWorkspaceIds(): Promise<ReadonlyArray<EngagementId>> {
        return this.#fs.listDirectory(
            join(this.#root, 'workspaces'),
        ) as Promise<ReadonlyArray<EngagementId>>;
    }

    async currentRunId(
        engagementId: EngagementId,
    ): Promise<string | undefined> {
        const text = await this.#fs.readText(
            join(this.workspaceDirectory(engagementId), 'current.json'),
        );
        if (text === undefined) return undefined;
        return (JSON.parse(text) as { readonly runId?: string }).runId;
    }

    async setCurrent(run: WorkspaceIntelligenceRun): Promise<void> {
        await this.#fs.mkdir(this.workspaceDirectory(run.engagementId));
        await this.writeAtomic(
            join(this.workspaceDirectory(run.engagementId), 'current.json'),
            json({ runId: run.id }),
        );
    }

    async clearCurrent(engagementId: EngagementId): Promise<void> {
        await this.#fs.remove(
            join(this.workspaceDirectory(engagementId), 'current.json'),
        );
    }

    async verifyRun(
        engagementId: EngagementId,
        runId: string,
    ): Promise<boolean> {
        const directory = this.runDirectory(engagementId, runId);
        const text = await this.#fs.readText(join(directory, 'integrity.json'));
        if (text === undefined) return false;
        const integrity = JSON.parse(text) as IntegrityDocument;
        if (!isReadableSchemaVersion(integrity.schemaVersion)) return false;
        for (const [file, expected] of Object.entries(integrity.files)) {
            const content = await this.#fs.readText(join(directory, file));
            if (
                content === undefined ||
                (await this.#digest(content)) !== expected
            )
                return false;
        }
        return true;
    }

    #graphCacheKey(engagementId: EngagementId, runId: string): string {
        return `${engagementId}\0${runId}`;
    }

    async #readFindingRecords(
        engagementId: EngagementId,
        runId: string,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceFinding>> {
        const text = await this.#fs.readText(
            join(this.runDirectory(engagementId, runId), 'findings.jsonl'),
        );
        if (text === undefined || text.trim() === '') return [];
        return text
            .trim()
            .split('\n')
            .flatMap(line => {
                try {
                    const value = JSON.parse(line) as Record<string, unknown>;
                    return typeof value.id === 'string' &&
                        typeof value.kind === 'string' &&
                        (value.severity === 'info' ||
                            value.severity === 'warning') &&
                        typeof value.message === 'string' &&
                        Array.isArray(value.nodeIds)
                        ? [
                              {
                                  id: value.id,
                                  kind: value.kind,
                                  severity: value.severity,
                                  message: value.message,
                                  nodeIds: value.nodeIds.filter(
                                      (nodeId): nodeId is string =>
                                          typeof nodeId === 'string',
                                  ),
                              },
                          ]
                        : [];
                } catch {
                    return [];
                }
            });
    }

    async #readGraph(
        engagementId: EngagementId,
        runId: string,
    ): Promise<CachedGraph> {
        const key = this.#graphCacheKey(engagementId, runId);
        const cached = this.#graphCache.get(key);
        if (cached !== undefined) {
            this.#graphCache.delete(key);
            this.#graphCache.set(key, cached);
            return cached;
        }
        const directory = this.runDirectory(engagementId, runId);
        const [nodeText, edgeText] = await Promise.all([
            this.#fs.readText(join(directory, 'graph', 'nodes.jsonl')),
            this.#fs.readText(join(directory, 'graph', 'edges.jsonl')),
        ]);
        const graph: CachedGraph = {
            nodes:
                nodeText === undefined || nodeText.trim() === ''
                    ? []
                    : nodeText
                          .trim()
                          .split('\n')
                          .flatMap(
                              line =>
                                  storedNode(
                                      JSON.parse(line) as Record<
                                          string,
                                          unknown
                                      >,
                                  ) ?? [],
                          ),
            edges:
                edgeText === undefined || edgeText.trim() === ''
                    ? []
                    : edgeText
                          .trim()
                          .split('\n')
                          .flatMap(
                              line =>
                                  storedEdge(
                                      JSON.parse(line) as Record<
                                          string,
                                          unknown
                                      >,
                                  ) ?? [],
                          ),
        };
        this.#graphCache.set(key, graph);
        if (this.#graphCache.size > GRAPH_CACHE_LIMIT) {
            const oldestKey = this.#graphCache.keys().next().value;
            if (oldestKey !== undefined) this.#graphCache.delete(oldestKey);
        }
        return graph;
    }

    private async writeIntegrity(
        engagementId: EngagementId,
        runId: string,
        analyses: ReadonlyArray<WorkspaceIntelligenceAnalysis>,
    ): Promise<void> {
        const directory = this.runDirectory(engagementId, runId);
        const files = [
            'manifest.json',
            'coverage.json',
            'events.jsonl',
            'report.md',
            'graph/architecture.mmd',
            'graph/nodes.jsonl',
            'graph/edges.jsonl',
            'graph/index.json',
            'analyzers.json',
            'findings.jsonl',
            'unknowns.jsonl',
            ...analyses.flatMap(analysis =>
                analysis.repository === undefined
                    ? []
                    : [
                          `repositories/${analysis.repository.repoId}/manifest.json`,
                          `repositories/${analysis.repository.repoId}/analysis.json`,
                      ],
            ),
        ];
        const entries = await Promise.all(
            files.map(async file => {
                const content = await this.#fs.readText(join(directory, file));
                if (content === undefined)
                    throw new Error(`Missing finalized artifact ${file}`);
                return [file, await this.#digest(content)] as const;
            }),
        );
        await this.writeAtomic(
            join(directory, 'integrity.json'),
            json({
                schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
                files: Object.fromEntries(entries),
            } satisfies IntegrityDocument),
        );
    }

    private async writeCurationState(
        engagementId: EngagementId,
        componentOverrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
        actions: ReadonlyArray<WorkspaceIntelligenceCurationAction>,
    ): Promise<void> {
        const edgeActions = new Map<
            string,
            WorkspaceIntelligenceCurationAction
        >();
        for (const action of actions) {
            if (!action.kind.startsWith('edge.')) continue;
            if (action.kind === 'edge.clear') {
                edgeActions.delete(action.targetId);
                continue;
            }
            if (action.kind === 'edge.annotate') continue;
            edgeActions.set(action.targetId, action);
        }
        const state: WorkspaceIntelligenceCurationState = {
            schemaVersion: WORKSPACE_INTELLIGENCE_SCHEMA_VERSION,
            componentOverrides: [...componentOverrides].toSorted(
                (left, right) =>
                    left.componentId.localeCompare(right.componentId),
            ),
            edgeActions: [...edgeActions.values()].toSorted((left, right) =>
                `${left.targetId}\0${left.id}`.localeCompare(
                    `${right.targetId}\0${right.id}`,
                ),
            ),
        };
        await this.writeAtomic(
            join(this.curationDirectory(engagementId), 'current-state.json'),
            json(state),
        );
    }

    private async writeAtomic(path: string, text: string): Promise<void> {
        const temporary = `${path}.tmp`;
        await this.#fs.writeText(temporary, text);
        await this.#fs.rename(temporary, path);
    }
}
