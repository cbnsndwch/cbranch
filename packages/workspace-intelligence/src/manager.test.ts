import {
    EngagementId,
    RepoId,
    WorkspaceIntelligenceCoverage,
    WorkspaceIntelligencePresentation,
    WorkspaceIntelligenceRun,
    WorkspaceIntelligenceRunEvent,
    WorkspaceIntelligenceRunId,
} from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { WorkspaceIntelligenceArtifactStore } from './artifact-store';
import { defaultWorkspaceIntelligenceAnalysisSettings } from './analysis-settings';
import {
    WorkspaceIntelligenceError,
    WorkspaceIntelligenceManager,
} from './manager';
import type {
    WorkspaceIntelligenceFileSystem,
    WorkspaceIntelligenceRuntime,
} from './ports';

class MemoryFileSystem implements WorkspaceIntelligenceFileSystem {
    readonly files = new Map<string, string>();
    readonly bytes = new Map<string, Uint8Array>();
    readonly directories = new Set<string>(['/artifacts']);
    readonly readCounts = new Map<string, number>();

    async mkdir(path: string): Promise<void> {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += `/${part}`;
            this.directories.add(current);
        }
    }

    async readText(path: string): Promise<string | undefined> {
        this.readCounts.set(path, (this.readCounts.get(path) ?? 0) + 1);
        return this.files.get(path);
    }

    async writeText(path: string, text: string): Promise<void> {
        this.files.set(path, text);
    }

    async readBytes(path: string): Promise<Uint8Array | undefined> {
        return this.bytes.get(path);
    }

    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
        this.bytes.set(path, bytes);
    }

    async rename(from: string, to: string): Promise<void> {
        const text = this.files.get(from);
        if (text === undefined) {
            const bytes = this.bytes.get(from);
            if (bytes === undefined)
                throw new Error(`Missing temporary file ${from}`);
            this.bytes.delete(from);
            this.bytes.set(to, bytes);
        } else {
            this.files.delete(from);
            this.files.set(to, text);
        }
    }

    async remove(path: string): Promise<void> {
        const prefix = `${path}/`;
        for (const file of this.files.keys())
            if (file === path || file.startsWith(prefix))
                this.files.delete(file);
        for (const file of this.bytes.keys())
            if (file === path || file.startsWith(prefix))
                this.bytes.delete(file);
        for (const directory of this.directories)
            if (directory === path || directory.startsWith(prefix))
                this.directories.delete(directory);
    }

    async listDirectory(path: string): Promise<ReadonlyArray<string>> {
        const prefix = `${path}/`;
        const entries = new Set<string>();
        for (const value of [
            ...this.files.keys(),
            ...this.bytes.keys(),
            ...this.directories,
        ]) {
            if (!value.startsWith(prefix)) continue;
            const entry = value.slice(prefix.length).split('/')[0];
            if (entry) entries.add(entry);
        }
        return [...entries];
    }
}

const engagementId = EngagementId.make('workspace-a');
const repoA = RepoId.make('repo-a');
const repoB = RepoId.make('repo-b');

const makeRuntime = (
    overrides: Partial<WorkspaceIntelligenceRuntime> = {},
): WorkspaceIntelligenceRuntime => {
    let now = 1_700_000_000_000;
    let id = 0;
    return {
        now: () => ++now,
        nextRunId: () => `run-${++id}`,
        digest: async text => `digest:${text.length}:${text}`,
        ...overrides,
    };
};

const setup = (overrides: Partial<WorkspaceIntelligenceRuntime> = {}) => {
    const fileSystem = new MemoryFileSystem();
    const runtime = makeRuntime(overrides);
    const store = new WorkspaceIntelligenceArtifactStore({
        rootDirectory: '/artifacts',
        fileSystem,
        digest: runtime.digest,
    });
    const manager = new WorkspaceIntelligenceManager({
        store,
        runtime,
        workspace: {
            resolveWorkspace: async id =>
                id === engagementId
                    ? {
                          engagementId,
                          repositories: [
                              { repoId: repoA, root: '/private/a' },
                              { repoId: repoB, root: '/private/b' },
                          ],
                      }
                    : undefined,
        },
    });
    return { fileSystem, manager, runtime, store };
};

const readEvents = async (
    manager: WorkspaceIntelligenceManager,
    runId: string,
    id = engagementId,
) => {
    const events: WorkspaceIntelligenceRunEvent[] = [];
    for await (const event of manager.subscribe(id, runId)) events.push(event);
    return events;
};

const emptyAnalysis = () => ({
    nodes: [],
    edges: [],
    unknowns: [],
    report: [],
    analyzerCount: 0,
});

describe('WorkspaceIntelligenceManager', () => {
    test('persists workspace policy and snapshots it into immutable runs', async () => {
        const { fileSystem, manager } = setup();
        const settings = {
            ...defaultWorkspaceIntelligenceAnalysisSettings,
            includePatterns: ['apps/**'],
            excludePatterns: ['apps/**/generated/**'],
            maxSourceFiles: 42,
            maxGraphEdges: 99,
        };

        await expect(
            manager.setAnalysisSettings(engagementId, settings),
        ).resolves.toEqual(settings);
        await expect(manager.analysisSettings(engagementId)).resolves.toEqual(
            settings,
        );

        const started = await manager.start(engagementId, [repoA]);
        await readEvents(manager, started.id);

        expect(started.analysisSettings).toEqual(settings);
        await expect(
            manager.get(engagementId, started.id),
        ).resolves.toMatchObject({ analysisSettings: settings });
        expect(
            JSON.parse(
                fileSystem.files.get(
                    '/artifacts/workspaces/workspace-a/settings.json',
                ) ?? '',
            ),
        ).toMatchObject({ settings });
    });

    test('rejects unsafe workspace policy values before they are persisted', async () => {
        const { manager } = setup();

        await expect(
            manager.setAnalysisSettings(engagementId, {
                ...defaultWorkspaceIntelligenceAnalysisSettings,
                includePatterns: ['../outside/**'],
            }),
        ).rejects.toThrow('relative globs');
        await expect(
            manager.setAnalysisSettings(engagementId, {
                ...defaultWorkspaceIntelligenceAnalysisSettings,
                maxRepositoryDurationMs: 999,
            }),
        ).rejects.toThrow('maxRepositoryDurationMs');
    });

    test('persists bounded per-run presentation outside immutable artifacts', async () => {
        const { fileSystem, manager } = setup();
        const started = await manager.start(engagementId, [repoA]);
        await readEvents(manager, started.id);

        await expect(
            manager.presentation(engagementId, started.id),
        ).resolves.toMatchObject({
            runId: started.id,
            nodePositions: [],
            showInferredEdges: false,
        });

        const saved = await manager.setPresentation(
            engagementId,
            new WorkspaceIntelligencePresentation({
                schemaVersion: 99,
                runId: started.id,
                selectedNodeId: 'component:api',
                expandedNodeIds: ['component:api', 'component:api'],
                nodePositions: [
                    { nodeId: 'component:api', x: 10, y: 20 },
                    { nodeId: 'component:api', x: 30, y: 40 },
                ],
                showInferredEdges: true,
                minimumConfidenceTier: 'high',
            }),
        );

        expect(saved).toMatchObject({
            schemaVersion: 1,
            selectedNodeId: 'component:api',
            expandedNodeIds: ['component:api'],
            nodePositions: [{ nodeId: 'component:api', x: 30, y: 40 }],
            showInferredEdges: true,
            minimumConfidenceTier: 'high',
        });
        expect(
            fileSystem.files.get(
                `/artifacts/workspaces/workspace-a/presentation/${started.id}.json`,
            ),
        ).toContain('component:api');

        await manager.clearCurrent(engagementId);
        await manager.deleteRun(engagementId, started.id);
        expect(
            fileSystem.files.has(
                `/artifacts/workspaces/workspace-a/presentation/${started.id}.json`,
            ),
        ).toBe(false);
    });

    test('queues different workspaces behind the host concurrency limit', async () => {
        const fileSystem = new MemoryFileSystem();
        const runtime = makeRuntime();
        const store = new WorkspaceIntelligenceArtifactStore({
            rootDirectory: '/artifacts',
            fileSystem,
            digest: runtime.digest,
        });
        const workspaceB = EngagementId.make('workspace-b');
        let releaseFirst: () => void = () => undefined;
        const firstFinished = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let notifyFirstStarted: () => void = () => undefined;
        const firstStarted = new Promise<void>(resolve => {
            notifyFirstStarted = resolve;
        });
        const analyzed: RepoId[] = [];
        const manager = new WorkspaceIntelligenceManager({
            store,
            runtime: {
                ...runtime,
                analyzeRepository: async repository => {
                    analyzed.push(repository.repoId);
                    if (repository.repoId === repoA) {
                        notifyFirstStarted();
                        await firstFinished;
                    }
                    return emptyAnalysis();
                },
            },
            workspace: {
                resolveWorkspace: async id => {
                    if (id === engagementId)
                        return {
                            engagementId,
                            repositories: [
                                { repoId: repoA, root: '/private/a' },
                            ],
                        };
                    if (id === workspaceB)
                        return {
                            engagementId: workspaceB,
                            repositories: [
                                { repoId: repoB, root: '/private/b' },
                            ],
                        };
                    return undefined;
                },
            },
            maxConcurrentRuns: 1,
        });

        const first = await manager.start(engagementId);
        await firstStarted;
        const second = await manager.start(workspaceB);

        await expect(manager.get(workspaceB, second.id)).resolves.toMatchObject(
            {
                state: 'queued',
            },
        );
        expect(analyzed).toEqual([repoA]);

        releaseFirst();
        await readEvents(manager, first.id);
        await readEvents(manager, second.id, workspaceB);

        expect(analyzed).toEqual([repoA, repoB]);
    });

    test('cancels a queued run without starting repository analysis', async () => {
        const fileSystem = new MemoryFileSystem();
        const runtime = makeRuntime();
        const store = new WorkspaceIntelligenceArtifactStore({
            rootDirectory: '/artifacts',
            fileSystem,
            digest: runtime.digest,
        });
        const workspaceB = EngagementId.make('workspace-b');
        let releaseFirst: () => void = () => undefined;
        const firstFinished = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let notifyFirstStarted: () => void = () => undefined;
        const firstStarted = new Promise<void>(resolve => {
            notifyFirstStarted = resolve;
        });
        const analyzed: RepoId[] = [];
        const manager = new WorkspaceIntelligenceManager({
            store,
            runtime: {
                ...runtime,
                analyzeRepository: async repository => {
                    analyzed.push(repository.repoId);
                    if (repository.repoId === repoA) {
                        notifyFirstStarted();
                        await firstFinished;
                    }
                    return emptyAnalysis();
                },
            },
            workspace: {
                resolveWorkspace: async id => {
                    if (id === engagementId)
                        return {
                            engagementId,
                            repositories: [
                                { repoId: repoA, root: '/private/a' },
                            ],
                        };
                    if (id === workspaceB)
                        return {
                            engagementId: workspaceB,
                            repositories: [
                                { repoId: repoB, root: '/private/b' },
                            ],
                        };
                    return undefined;
                },
            },
            maxConcurrentRuns: 1,
        });

        const first = await manager.start(engagementId);
        await firstStarted;
        const second = await manager.start(workspaceB);

        await expect(
            manager.cancel(workspaceB, second.id),
        ).resolves.toMatchObject({
            state: 'cancelled',
        });
        expect(analyzed).toEqual([repoA]);

        releaseFirst();
        await readEvents(manager, first.id);

        await expect(manager.get(workspaceB, second.id)).resolves.toMatchObject(
            {
                state: 'cancelled',
            },
        );
        expect(analyzed).toEqual([repoA]);
    });

    test('merges shared canonical records and reuses a bounded active graph read', async () => {
        const { fileSystem, manager, store } = setup({
            analyzeRepository: async repository => ({
                nodes: [
                    {
                        id: 'npm:shared-library',
                        kind: 'external.dependency',
                        label: 'shared-library',
                        repoId: repository.repoId,
                        evidence: [
                            { path: `${repository.repoId}/package.json` },
                        ],
                    },
                    {
                        id: `${repository.repoId}:component:api`,
                        kind: 'component',
                        label: 'API',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                ],
                edges: [
                    {
                        from: `${repository.repoId}:component:api`,
                        to: 'npm:shared-library',
                        kind: 'depends-on',
                        evidence: [],
                    },
                ],
                unknowns: [],
                report: [],
                analyzerCount: 1,
            }),
        });
        const started = await manager.start(engagementId);
        await readEvents(manager, started.id);
        const graphPath =
            '/artifacts/workspaces/workspace-a/runs/run-1/graph/nodes.jsonl';
        const graph = fileSystem.files.get(graphPath) ?? '';
        const shared = graph
            .split('\n')
            .map(
                line => JSON.parse(line) as { id: string; evidence: unknown[] },
            )
            .filter(node => node.id === 'npm:shared-library');

        expect(shared).toHaveLength(1);
        expect(shared[0]?.evidence).toHaveLength(2);
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/findings.jsonl',
            ),
        ).not.toContain('architecture.cross-repository-dependency');

        fileSystem.readCounts.clear();
        await store.searchGraph(engagementId, started.id, 'shared-library', 10);
        const readsAfterSearch = new Map(fileSystem.readCounts);
        await store.neighborhoodGraph(
            engagementId,
            started.id,
            'npm:shared-library',
            10,
        );
        expect(fileSystem.readCounts).toEqual(readsAfterSearch);
    });

    test('caps target-scale graph search and neighborhoods without transferring a full artifact', async () => {
        const { manager } = setup({
            analyzeRepository: async repository => {
                const nodes = Array.from({ length: 2_100 }, (_, index) => ({
                    id: `${repository.repoId}:component:node-${index}`,
                    kind: 'component',
                    label: `Node ${index}`,
                    repoId: repository.repoId,
                    evidence: [],
                }));
                return {
                    nodes,
                    edges: nodes.slice(1).map(node => ({
                        from: `${repository.repoId}:component:node-0`,
                        to: node.id,
                        kind: 'depends-on',
                        evidence: [],
                    })),
                    unknowns: [],
                    report: [],
                    analyzerCount: 1,
                };
            },
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);

        const search = await manager.search(
            engagementId,
            run.id,
            'Node',
            10_000,
        );
        const neighborhood = await manager.neighborhood(
            engagementId,
            run.id,
            `${repoA}:component:node-0`,
            10_000,
        );

        expect(search.nodes).toHaveLength(2_000);
        expect(neighborhood.nodes).toHaveLength(2_000);
        expect(neighborhood.edges).toHaveLength(1_999);
    });

    test('keeps workspace component curation separate from immutable runs', async () => {
        const { manager } = setup();
        await manager.setComponentOverrides(engagementId, [
            {
                componentId: 'repo-a:component:package.json',
                displayName: 'API',
                note: 'User-curated boundary.',
            },
        ]);

        await expect(manager.componentOverrides(engagementId)).resolves.toEqual(
            [
                {
                    componentId: 'repo-a:component:package.json',
                    displayName: 'API',
                    note: 'User-curated boundary.',
                },
            ],
        );
    });

    test('reads a version 0 run manifest through the in-memory migration path', async () => {
        const { fileSystem, manager } = setup();
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);
        const directory = '/artifacts/workspaces/workspace-a/runs/run-1';
        const manifestPath = `${directory}/manifest.json`;
        const manifest = JSON.parse(
            fileSystem.files.get(manifestPath) ?? '',
        ) as {
            readonly run: Record<string, unknown>;
        };
        const legacyRun = { ...manifest.run };
        delete legacyRun.workspaceRepoIds;
        const legacyManifest = `${JSON.stringify(
            { schemaVersion: 0, run: legacyRun },
            null,
            2,
        )}\n`;
        fileSystem.files.set(manifestPath, legacyManifest);
        const integrityPath = `${directory}/integrity.json`;
        const integrity = JSON.parse(
            fileSystem.files.get(integrityPath) ?? '',
        ) as {
            schemaVersion: number;
            files: Record<string, string>;
        };
        integrity.schemaVersion = 0;
        integrity.files['manifest.json'] =
            `digest:${legacyManifest.length}:${legacyManifest}`;
        fileSystem.files.set(
            integrityPath,
            `${JSON.stringify(integrity, null, 2)}\n`,
        );

        await expect(manager.get(engagementId, run.id)).resolves.toMatchObject({
            isValid: true,
            workspaceRepoIds: [repoA],
            repoIds: [repoA],
        });
    });

    test('marks curation missing from the validated current graph as orphaned', async () => {
        const { manager, store } = setup({
            analyzeRepository: async repository => ({
                nodes: [
                    {
                        id: `${repository.repoId}:component:api`,
                        kind: 'component',
                        label: 'API',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                ],
                edges: [],
                unknowns: [],
                report: [],
                analyzerCount: 1,
            }),
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);
        await manager.setComponentOverrides(engagementId, [
            {
                componentId: `${repoA}:component:api`,
                displayName: 'Public API',
            },
            {
                componentId: `${repoA}:component:removed`,
                displayName: 'Removed service',
            },
        ]);

        await expect(manager.componentOverrides(engagementId)).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    componentId: `${repoA}:component:api`,
                    isOrphaned: false,
                }),
                expect.objectContaining({
                    componentId: `${repoA}:component:removed`,
                    isOrphaned: true,
                }),
            ]),
        );
        await expect(
            store.readComponentOverrides(engagementId),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.not.objectContaining({ isOrphaned: expect.anything() }),
            ]),
        );
    });

    test('projects reversible component merge groups without changing the run graph', async () => {
        const { fileSystem, manager } = setup({
            analyzeRepository: async repository => ({
                nodes: [
                    {
                        id: `${repository.repoId}:component:orders`,
                        kind: 'component',
                        label: 'Orders',
                        repoId: repository.repoId,
                        evidence: [{ path: 'packages/orders/package.json' }],
                    },
                    {
                        id: `${repository.repoId}:component:payments`,
                        kind: 'component',
                        label: 'Payments',
                        repoId: repository.repoId,
                        evidence: [{ path: 'packages/payments/package.json' }],
                    },
                    {
                        id: 'npm:shared-client',
                        kind: 'external.dependency',
                        label: 'shared-client',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                ],
                edges: [
                    {
                        from: `${repository.repoId}:component:orders`,
                        to: 'npm:shared-client',
                        kind: 'depends-on',
                        evidence: [{ path: 'packages/orders/package.json' }],
                    },
                    {
                        from: `${repository.repoId}:component:payments`,
                        to: 'npm:shared-client',
                        kind: 'depends-on',
                        evidence: [{ path: 'packages/payments/package.json' }],
                    },
                ],
                unknowns: [],
                report: [],
                analyzerCount: 1,
            }),
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);
        await manager.setComponentOverrides(engagementId, [
            {
                componentId: `${repoA}:component:orders`,
                mergeGroup: 'commerce-services',
                mergeGroupLabel: 'Commerce services',
            },
            {
                componentId: `${repoA}:component:payments`,
                mergeGroup: 'commerce-services',
                mergeGroupLabel: 'Commerce services',
            },
        ]);

        const neighborhood = await manager.neighborhood(
            engagementId,
            run.id,
            `${repoA}:component:orders`,
        );
        expect(neighborhood.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'curation:component-group:commerce-services',
                    kind: 'component.group',
                    label: 'Commerce services',
                }),
            ]),
        );
        expect(neighborhood.nodes).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: `${repoA}:component:orders`,
                }),
                expect.objectContaining({
                    id: `${repoA}:component:payments`,
                }),
            ]),
        );
        expect(neighborhood.edges).toEqual([
            expect.objectContaining({
                from: 'curation:component-group:commerce-services',
                to: 'npm:shared-client',
                evidence: expect.arrayContaining([
                    { path: 'packages/orders/package.json' },
                    { path: 'packages/payments/package.json' },
                ]),
            }),
        ]);
        await expect(
            manager.neighborhood(
                engagementId,
                run.id,
                'curation:component-group:commerce-services',
            ),
        ).resolves.toMatchObject({
            nodes: expect.arrayContaining([
                expect.objectContaining({
                    id: 'curation:component-group:commerce-services',
                }),
            ]),
        });
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/graph/nodes.jsonl',
            ),
        ).toContain(`${repoA}:component:orders`);
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/graph/nodes.jsonl',
            ),
        ).toContain(`${repoA}:component:payments`);
    });

    test('persists auditable curation actions with a compact mutable projection', async () => {
        const { manager, store } = setup();
        await expect(
            manager.appendCurationAction(engagementId, {
                kind: 'component.rename',
                targetId: 'repo-a:component:api',
            }),
        ).rejects.toMatchObject({
            code: 'repoNotFound',
        } satisfies Partial<WorkspaceIntelligenceError>);
        await manager.setComponentOverrides(engagementId, [
            {
                componentId: 'repo-a:component:api',
                displayName: 'Public API',
            },
        ]);
        const edge = await manager.appendCurationAction(engagementId, {
            actor: 'reviewer',
            kind: 'edge.reject',
            targetId:
                'repo-a:component:api\u0000depends-on\u0000npm:legacy-client',
            evidence: [{ path: 'packages/api/package.json' }],
        });
        await manager.appendCurationAction(engagementId, {
            kind: 'edge.clear',
            targetId: edge.targetId,
        });

        await expect(manager.curationActions(engagementId)).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'component.rename',
                    targetId: 'repo-a:component:api',
                    actor: 'local-user',
                }),
                expect.objectContaining({
                    id: edge.id,
                    kind: 'edge.reject',
                    actor: 'reviewer',
                }),
            ]),
        );
        await expect(
            store.readCurationState(engagementId),
        ).resolves.toMatchObject({
            componentOverrides: [
                {
                    componentId: 'repo-a:component:api',
                    displayName: 'Public API',
                },
            ],
            edgeActions: [],
        });
        await manager.clearCurationActions(engagementId);
        await expect(manager.componentOverrides(engagementId)).resolves.toEqual(
            [],
        );
        await expect(manager.curationActions(engagementId)).resolves.toEqual(
            [],
        );
        await expect(
            store.readCurationState(engagementId),
        ).resolves.toMatchObject({
            componentOverrides: [],
            edgeActions: [],
        });
    });

    test('suppresses rejected stable edges until curation explicitly clears them', async () => {
        const { manager } = setup({
            analyzeRepository: async repository => ({
                nodes: [
                    {
                        id: `${repository.repoId}:component:api`,
                        kind: 'component',
                        label: 'API',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                    {
                        id: 'npm:deprecated-client',
                        kind: 'external.dependency',
                        label: 'deprecated-client',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                ],
                edges: [
                    {
                        from: `${repository.repoId}:component:api`,
                        to: 'npm:deprecated-client',
                        kind: 'depends-on',
                        evidence: [],
                    },
                ],
                unknowns: [],
                report: [],
                analyzerCount: 1,
            }),
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);
        const target = `${repoA}:component:api\u0000depends-on\u0000npm:deprecated-client`;
        await manager.appendCurationAction(engagementId, {
            kind: 'edge.reject',
            targetId: target,
        });
        await expect(
            manager.neighborhood(
                engagementId,
                run.id,
                `${repoA}:component:api`,
            ),
        ).resolves.toMatchObject({ edges: [] });
        await manager.appendCurationAction(engagementId, {
            kind: 'edge.clear',
            targetId: target,
        });
        await expect(
            manager.neighborhood(
                engagementId,
                run.id,
                `${repoA}:component:api`,
            ),
        ).resolves.toMatchObject({
            edges: [
                expect.objectContaining({
                    from: `${repoA}:component:api`,
                    to: 'npm:deprecated-client',
                }),
            ],
        });
    });

    test('validates an explicit subset against authoritative workspace membership', async () => {
        const { manager } = setup();

        await expect(manager.start(engagementId, [])).rejects.toMatchObject({
            code: 'repoNotFound',
        } satisfies Partial<WorkspaceIntelligenceError>);
        await expect(
            manager.start(engagementId, [repoA, repoA]),
        ).rejects.toMatchObject({
            code: 'repoNotFound',
        } satisfies Partial<WorkspaceIntelligenceError>);
        await expect(
            manager.start(engagementId, [RepoId.make('not-a-member')]),
        ).rejects.toMatchObject({
            code: 'repoNotFound',
        } satisfies Partial<WorkspaceIntelligenceError>);
    });

    test('deletes only non-current finalized history', async () => {
        const { manager } = setup();
        const first = await manager.start(engagementId, [repoA]);
        await readEvents(manager, first.id);
        const second = await manager.start(engagementId, [repoA]);
        await readEvents(manager, second.id);

        await expect(manager.deleteRun(engagementId, first.id)).resolves.toBe(
            undefined,
        );
        await expect(manager.list(engagementId)).resolves.toEqual([
            expect.objectContaining({ id: second.id, isCurrent: true }),
        ]);
        await expect(
            manager.deleteRun(engagementId, second.id),
        ).rejects.toMatchObject({
            code: 'repoLocked',
        } satisfies Partial<WorkspaceIntelligenceError>);
    });

    test('can explicitly choose or clear a validated current run', async () => {
        const { manager } = setup();
        const first = await manager.start(engagementId, [repoA]);
        await readEvents(manager, first.id);
        const second = await manager.start(engagementId, [repoA]);
        await readEvents(manager, second.id);

        await manager.setCurrent(engagementId, first.id);
        await expect(manager.list(engagementId)).resolves.toEqual([
            expect.objectContaining({ id: second.id, isCurrent: false }),
            expect.objectContaining({ id: first.id, isCurrent: true }),
        ]);

        await manager.clearCurrent(engagementId);
        await expect(manager.list(engagementId)).resolves.toEqual([
            expect.objectContaining({ id: second.id, isCurrent: false }),
            expect.objectContaining({ id: first.id, isCurrent: false }),
        ]);
    });

    test('does not allow an unvalidated finalized run to become current', async () => {
        const { manager } = setup({
            analyzeRepository: async () => {
                throw new Error('analysis failed');
            },
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);

        await expect(
            manager.setCurrent(engagementId, run.id),
        ).rejects.toMatchObject({
            code: 'repoLocked',
        } satisfies Partial<WorkspaceIntelligenceError>);
    });

    test('clears all inactive run history without clearing curation', async () => {
        const { manager, store } = setup();
        const first = await manager.start(engagementId, [repoA]);
        await readEvents(manager, first.id);
        await manager.appendCurationAction(engagementId, {
            kind: 'edge.annotate',
            targetId: 'repo-a:component:api\0uses\0repo-a:component:web',
        });

        await manager.clearRunHistory(engagementId);
        await expect(manager.list(engagementId)).resolves.toEqual([]);
        await expect(store.currentRunId(engagementId)).resolves.toBeUndefined();
        await expect(manager.curationActions(engagementId)).resolves.toEqual([
            expect.objectContaining({ kind: 'edge.annotate' }),
        ]);
    });

    test('rejects clearing history while a run is active', async () => {
        const { manager } = setup({
            analyzeRepository: async () => {
                await new Promise<void>(() => undefined);
                return emptyAnalysis();
            },
        });
        await manager.start(engagementId, [repoA]);

        await expect(
            manager.clearRunHistory(engagementId),
        ).rejects.toMatchObject({
            code: 'repoLocked',
        } satisfies Partial<WorkspaceIntelligenceError>);
    });

    test('marks the current run stale when a fresh repository fingerprint changes', async () => {
        let fingerprint = 'sha256:before';
        const { manager } = setup({
            fingerprintRepository: async () => fingerprint,
            analyzeRepository: async repository => ({
                nodes: [],
                edges: [],
                unknowns: [],
                report: [],
                analyzerCount: 1,
                repository: {
                    repoId: repository.repoId,
                    sourceFileCount: 1,
                    sourceFingerprint: fingerprint,
                },
            }),
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);
        fingerprint = 'sha256:after';

        await expect(manager.list(engagementId)).resolves.toEqual([
            expect.objectContaining({
                id: run.id,
                isCurrent: true,
                isStale: true,
            }),
        ]);
    });

    test('persists sequenced, immutable foundation artifacts without host paths', async () => {
        const { fileSystem, manager, store } = setup();
        const started = await manager.start(engagementId, [repoA]);
        const events = await readEvents(manager, started.id);
        const completed = await manager.get(engagementId, started.id);

        expect(events.map(event => event.sequence)).toEqual(
            events.map((_, index) => index + 1),
        );
        expect(completed.state).toBe('completed');
        expect(completed.isCurrent).toBe(true);
        expect(completed.isValid).toBe(true);
        expect(completed.coverage).toMatchObject({
            repositoryCount: 1,
            completedRepositoryCount: 1,
            analyzerCount: 0,
        });
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/manifest.json',
            ),
        ).not.toContain('/private/a');
        expect(await store.verifyRun(engagementId, started.id)).toBe(true);
        expect(
            [...fileSystem.files.keys()].some(path => path.endsWith('.tmp')),
        ).toBe(false);

        fileSystem.files.set(
            '/artifacts/workspaces/workspace-a/runs/run-1/report.md',
            'tampered',
        );
        const tampered = await manager.get(engagementId, started.id);
        expect(tampered.isValid).toBe(false);
        await expect(
            manager.report(engagementId, started.id),
        ).rejects.toMatchObject({
            code: 'repoLocked',
        } satisfies Partial<WorkspaceIntelligenceError>);
    });

    test('retains a cancelled run and never advances it to current', async () => {
        let release: (() => void) | undefined;
        let entered: (() => void) | undefined;
        const { manager } = setup({
            analyzeRepository: async () =>
                new Promise<void>(resolve => {
                    release = resolve;
                    entered?.();
                }),
        });
        const waiting = new Promise<void>(resolve => {
            entered = resolve;
        });
        const started = await manager.start(engagementId, [repoA]);
        await waiting;
        await manager.cancel(engagementId, started.id);
        release?.();
        const events = await readEvents(manager, started.id);
        const cancelled = await manager.get(engagementId, started.id);

        expect(events.at(-1)?.state).toBe('cancelled');
        expect(cancelled.state).toBe('cancelled');
        expect(cancelled.isCurrent).toBe(false);
        expect(cancelled.isValid).toBe(false);
    });

    test('materializes deterministic analyzer output and reports its coverage', async () => {
        const { fileSystem, manager } = setup({
            analyzeRepository: async repository => ({
                nodes: [
                    {
                        id: `${repository.repoId}:package:package.json`,
                        kind: 'component',
                        label: 'package',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                ],
                edges: [{ from: 'a', to: 'b', kind: 'imports' }],
                unknowns: [{ kind: 'compiler-unavailable' }],
                report: ['- TypeScript package manifests: 1'],
                analyzerCount: 2,
                analyzerIds: ['workspace-intelligence.typescript@3'],
                repository: {
                    repoId: repository.repoId,
                    sourceFileCount: 1,
                    sourceFingerprint: 'sha256:fixture',
                },
            }),
        });
        const started = await manager.start(engagementId, [repoA]);
        await readEvents(manager, started.id);
        const completed = await manager.get(engagementId, started.id);
        const report = await manager.report(engagementId, started.id);
        const search = await manager.search(
            engagementId,
            started.id,
            'package',
        );
        const neighborhood = await manager.neighborhood(
            engagementId,
            started.id,
            `${repoA}:package:package.json`,
        );

        expect(completed.coverage.analyzerCount).toBe(2);
        expect(report).toMatchObject({
            nodeCount: 1,
            edgeCount: 1,
            findingCount: 1,
            unknownCount: 1,
        });
        expect(report.markdown).toContain('TypeScript package manifests: 1');
        expect(report.markdown).toContain('```mermaid');
        expect(report.markdown).toContain('architecture.capability-gap');
        expect(search.nodes).toEqual([
            expect.objectContaining({ kind: 'component' }),
        ]);
        expect(neighborhood.nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: `${repoA}:package:package.json`,
                }),
            ]),
        );
        await manager.setComponentOverrides(engagementId, [
            {
                componentId: `${repoA}:package:package.json`,
                displayName: 'API service',
                kind: 'service',
            },
        ]);
        await expect(
            manager.search(engagementId, started.id, 'package'),
        ).resolves.toMatchObject({
            nodes: [{ label: 'API service', kind: 'service' }],
        });
        await manager.setComponentOverrides(engagementId, [
            {
                componentId: `${repoA}:package:package.json`,
                suppressed: true,
            },
        ]);
        await expect(
            manager.search(engagementId, started.id, 'package'),
        ).resolves.toMatchObject({ nodes: [] });
        await expect(
            manager.neighborhood(
                engagementId,
                started.id,
                `${repoA}:package:package.json`,
            ),
        ).resolves.toMatchObject({ nodes: [], edges: [] });
        fileSystem.files.set(
            '/artifacts/workspaces/workspace-a/curation/component-overrides.json',
            '{ malformed',
        );
        await expect(
            manager.search(engagementId, started.id, 'package'),
        ).resolves.toMatchObject({
            nodes: [{ label: 'package', kind: 'component' }],
        });
        expect(report.markdown).not.toContain(
            'No language analyzers have run yet.',
        );
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/graph/nodes.jsonl',
            ),
        ).toContain('package.json');
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/unknowns.jsonl',
            ),
        ).toContain('compiler-unavailable');
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/findings.jsonl',
            ),
        ).toContain('architecture.capability-gap');
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/repositories/repo-a/manifest.json',
            ),
        ).toContain('sha256:fixture');
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/graph/architecture.mmd',
            ),
        ).toContain('flowchart LR');
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/graph/index.json',
            ),
        ).toContain('nodeCount');
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-1/analyzers.json',
            ),
        ).toContain('workspace-intelligence.typescript');
        await expect(
            manager.archiveEntries(engagementId, started.id),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: 'run/report.md' }),
                expect.objectContaining({ path: 'run/integrity.json' }),
                expect.objectContaining({
                    path: 'curation/component-overrides.json',
                }),
            ]),
        );
    });

    test('reuses matching repository analysis into a self-contained new run', async () => {
        let analyzerCalls = 0;
        const { fileSystem, manager } = setup({
            analyzerVersion: 'deterministic-source@1',
            fingerprintRepository: async () => 'sha256:stable-source',
            analyzeRepository: async repository => {
                analyzerCalls += 1;
                return {
                    nodes: [
                        {
                            id: `${repository.repoId}:component:api`,
                            kind: 'component',
                            label: 'API',
                            repoId: repository.repoId,
                            evidence: [],
                        },
                    ],
                    edges: [],
                    unknowns: [],
                    report: ['- API component'],
                    analyzerCount: 1,
                    repository: {
                        repoId: repository.repoId,
                        sourceFileCount: 1,
                        sourceFingerprint: 'sha256:stable-source',
                        analyzerVersion: 'deterministic-source@1',
                    },
                };
            },
        });
        const first = await manager.start(engagementId, [repoA]);
        await readEvents(manager, first.id);
        const second = await manager.start(engagementId, [repoA]);
        const secondEvents = await readEvents(manager, second.id);

        expect(analyzerCalls).toBe(1);
        expect(secondEvents).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    message:
                        'Repository analysis reused from the validated current run.',
                }),
            ]),
        );
        expect(
            fileSystem.files.get(
                '/artifacts/workspaces/workspace-a/runs/run-2/repositories/repo-a/analysis.json',
            ),
        ).toContain('sha256:stable-source');
        await expect(
            manager.get(engagementId, second.id),
        ).resolves.toMatchObject({
            coverage: { analyzerCount: 1 },
            isCurrent: true,
            isValid: true,
        });
    });

    test('materializes deterministic architecture-integrity findings', async () => {
        const { fileSystem, manager } = setup({
            analyzeRepository: async repository => ({
                nodes: [
                    {
                        id: `${repository.repoId}:component:api`,
                        kind: 'component',
                        label: 'API',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                    {
                        id: `${repository.repoId}:component:worker`,
                        kind: 'component',
                        label: 'Worker',
                        repoId: repository.repoId,
                        evidence: [],
                    },
                ],
                edges: [
                    {
                        from: `${repository.repoId}:component:api`,
                        to: `${repository.repoId}:component:worker`,
                        kind: 'imports',
                        evidence: [],
                    },
                    {
                        from: `${repository.repoId}:component:worker`,
                        to: `${repository.repoId}:component:api`,
                        kind: 'imports',
                        evidence: [],
                    },
                    {
                        from: `${repository.repoId}:component:api`,
                        to: 'missing:contract',
                        kind: 'consumes-contract',
                        evidence: [],
                    },
                ],
                unknowns: [],
                report: [],
                analyzerCount: 1,
                repository: {
                    repoId: repository.repoId,
                    sourceFileCount: 2,
                    sourceFingerprint: 'sha256:findings',
                },
            }),
        });
        const run = await manager.start(engagementId, [repoA]);
        await readEvents(manager, run.id);

        const findings = fileSystem.files.get(
            '/artifacts/workspaces/workspace-a/runs/run-1/findings.jsonl',
        );
        expect(findings).toContain('architecture.cycle');
        expect(findings).toContain('architecture.unresolved-reference');
        await expect(
            manager.report(engagementId, run.id),
        ).resolves.toMatchObject({ findingCount: 2 });
    });

    test('keeps a changed-input analysis as a valid, explicitly partial run', async () => {
        const { manager } = setup({
            analyzeRepository: async repository => ({
                nodes: [],
                edges: [],
                unknowns: [{ kind: 'source.changed-during-analysis' }],
                report: [],
                analyzerCount: 1,
                isPartial: true,
                repository: {
                    repoId: repository.repoId,
                    sourceFileCount: 1,
                    sourceFingerprint: 'sha256:changed',
                },
            }),
        });
        const started = await manager.start(engagementId, [repoA]);
        await readEvents(manager, started.id);
        const completed = await manager.get(engagementId, started.id);

        expect(completed).toMatchObject({
            state: 'partial',
            isCurrent: true,
            isValid: true,
            coverage: { isPartial: true },
        });
    });

    test('diffs two validated run artifacts by stable graph identity and kind', async () => {
        let generation = 0;
        const { manager } = setup({
            analyzeRepository: async repository => {
                const version = generation++;
                return {
                    nodes: [
                        {
                            id: `${repository.repoId}:component:api`,
                            kind: 'component',
                            label: `service v${version + 1}`,
                            repoId: repository.repoId,
                            evidence: [],
                        },
                        {
                            id: `${repository.repoId}:http.route:${version === 0 ? 'old' : 'new'}`,
                            kind: 'contract.http.route',
                            label: `GET /${version === 0 ? 'old' : 'new'}`,
                            repoId: repository.repoId,
                            evidence: [],
                        },
                        {
                            id: `${repository.repoId}:messaging:nats:updates`,
                            kind: 'channel.messaging',
                            label: 'updates',
                            repoId: repository.repoId,
                            evidence: [{ version }],
                        },
                    ],
                    edges: [
                        {
                            from: `${repository.repoId}:component:api`,
                            to: `${repository.repoId}:messaging:nats:updates`,
                            kind: 'publishes',
                            evidence: [{ version }],
                        },
                        {
                            from: `${repository.repoId}:component:api`,
                            to: `${repository.repoId}:missing:${version === 0 ? 'old' : 'new'}`,
                            kind: 'references',
                            evidence: [],
                        },
                    ],
                    unknowns: [],
                    report: [],
                    analyzerCount: 1,
                };
            },
        });
        const first = await manager.start(engagementId, [repoA]);
        await readEvents(manager, first.id);
        const second = await manager.start(engagementId, [repoA]);
        await readEvents(manager, second.id);

        await expect(
            manager.diff(engagementId, first.id, second.id),
        ).resolves.toMatchObject({
            addedNodeIds: [`${repoA}:http.route:new`],
            removedNodeIds: [`${repoA}:http.route:old`],
            changedNodeIds: [
                `${repoA}:component:api`,
                `${repoA}:messaging:nats:updates`,
            ],
            changedEdgeIds: [
                `${repoA}:component:api\u0000publishes\u0000${repoA}:messaging:nats:updates`,
            ],
            addedEdgeIds: [
                `${repoA}:component:api\u0000references\u0000${repoA}:missing:new`,
            ],
            removedEdgeIds: [
                `${repoA}:component:api\u0000references\u0000${repoA}:missing:old`,
            ],
            addedComponentIds: [],
            removedComponentIds: [],
            changedComponentIds: [`${repoA}:component:api`],
            addedContractIds: [`${repoA}:http.route:new`],
            removedContractIds: [`${repoA}:http.route:old`],
            changedChannelIds: [`${repoA}:messaging:nats:updates`],
            addedFindingIds: [
                `unresolved:${repoA}:component:api\u0000references\u0000${repoA}:missing:new`,
            ],
            removedFindingIds: [
                `unresolved:${repoA}:component:api\u0000references\u0000${repoA}:missing:old`,
            ],
            addedRepoIds: [],
            removedRepoIds: [],
            isCoverageChanged: false,
        });
    });

    test('reports repository and coverage changes in arbitrary run diffs', async () => {
        const { manager } = setup({
            analyzeRepository: async repository => ({
                nodes: [],
                edges: [],
                unknowns: [],
                report: [],
                analyzerCount: 1,
                repository: {
                    repoId: repository.repoId,
                    sourceFileCount: 1,
                    sourceFingerprint: `sha256:${repository.repoId}`,
                },
            }),
        });
        const first = await manager.start(engagementId, [repoA]);
        await readEvents(manager, first.id);
        const second = await manager.start(engagementId, [repoA, repoB]);
        await readEvents(manager, second.id);

        await expect(
            manager.diff(engagementId, first.id, second.id),
        ).resolves.toMatchObject({
            addedRepoIds: [repoB],
            removedRepoIds: [],
            isCoverageChanged: true,
        });
    });

    test('reconciles persisted in-progress work as interrupted after restart', async () => {
        const { manager, runtime, store } = setup();
        const coverage = new WorkspaceIntelligenceCoverage({
            repositoryCount: 1,
            completedRepositoryCount: 0,
            analyzerCount: 0,
            isPartial: false,
            summary: 'Queued.',
        });
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('reconcile-me'),
            engagementId,
            workspaceRepoIds: [repoA, repoB],
            repoIds: [repoA],
            state: 'running',
            createdAt: runtime.now(),
            startedAt: runtime.now(),
            eventSequence: 1,
            isCurrent: false,
            isValid: false,
            coverage,
        });
        const event = new WorkspaceIntelligenceRunEvent({
            runId: run.id,
            engagementId,
            sequence: 1,
            kind: 'stateChanged',
            state: 'running',
            at: runtime.now(),
            message: 'Running.',
            coverage,
        });
        await store.writeRun(run, [event]);

        await manager.reconcile();
        const interrupted = await manager.get(engagementId, run.id);

        expect(interrupted.state).toBe('interrupted');
        expect(interrupted.isValid).toBe(false);
        expect(
            (await store.readEvents(engagementId, run.id)).at(-1),
        ).toMatchObject({
            kind: 'reconciled',
            state: 'interrupted',
        });
    });
});
