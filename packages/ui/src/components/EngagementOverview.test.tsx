// @vitest-environment jsdom
import {
    Engagement,
    EngagementId,
    EngagementSlug,
    EngagementWorkspace,
    InferenceProfile,
    RecentRepo,
    RepoId,
    RepoState,
    StatusBranch,
    StatusEntry,
    WorkingTreeStatus,
    WorkspaceIntelligenceCoverage,
    WorkspaceIntelligenceArchiveDescriptor,
    WorkspaceIntelligenceCurationAction,
    WorkspaceIntelligenceEnrichmentAttempt,
    WorkspaceIntelligenceEnrichmentFailure,
    WorkspaceIntelligenceGraphNeighborhood,
    WorkspaceIntelligencePresentation,
    WorkspaceIntelligenceGraphSearchResult,
    WorkspaceIntelligenceSemanticSearchResult,
    WorkspaceIntelligenceInferredEdge,
    WorkspaceIntelligenceReport,
    WorkspaceIntelligenceRun,
    WorkspaceIntelligenceRunId,
    type WorkspaceIntelligenceAnalysisSettings,
} from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { EngagementOverview } from './EngagementOverview';

const engagementId = EngagementId.make('client-a');
const apiRepoId = RepoId.make('api-repo');
const webRepoId = RepoId.make('web-repo');
const apiRepo = new RecentRepo({
    repoId: apiRepoId,
    name: 'api',
    path: '/clients/a/api',
    lastOpenedAt: 2,
});
const webRepo = new RecentRepo({
    repoId: webRepoId,
    name: 'web',
    path: '/clients/a/web',
    lastOpenedAt: 1,
});
const workspace = new EngagementWorkspace({
    engagements: [
        new Engagement({
            id: engagementId,
            name: 'Client A',
            slug: EngagementSlug.make('client-a'),
            color: 'teal',
            repositories: [apiRepo, webRepo],
            openRepoIds: [apiRepoId],
            activeRepoId: apiRepoId,
            changeSets: [],
            createdAt: 1,
            updatedAt: 2,
        }),
    ],
    activeEngagementId: engagementId,
    unassignedRepositories: [],
});

const cleanStatus = (branch: string) =>
    new WorkingTreeStatus({
        entries: [],
        branch: new StatusBranch({
            head: branch,
            upstream: `origin/${branch}`,
        }),
        hasConflicts: false,
    });

const changedStatus = new WorkingTreeStatus({
    entries: [
        new StatusEntry({
            path: 'src/app.ts',
            staged: 'modified',
            unstaged: 'modified',
            isConflicted: false,
            isUntracked: false,
            isIgnored: false,
            isSubmodule: false,
        }),
    ],
    branch: new StatusBranch({
        head: 'feature/client-a',
        upstream: 'origin/feature/client-a',
        ahead: 2,
        behind: 1,
    }),
    hasConflicts: false,
});

const makeApi = () =>
    ({
        engagementList: vi.fn(async () => workspace),
        repoState: vi.fn(
            async (repoId: RepoId) =>
                new RepoState({
                    currentBranch:
                        repoId === apiRepoId ? 'main' : 'feature/client-a',
                    isDetached: false,
                    inProgress: 'none',
                    isBare: false,
                    isEmpty: false,
                    repoRoot:
                        repoId === apiRepoId ? apiRepo.path : webRepo.path,
                    gitDir: `${repoId === apiRepoId ? apiRepo.path : webRepo.path}/.git`,
                }),
        ),
        statusGet: vi.fn(async (repoId: RepoId) =>
            repoId === apiRepoId ? cleanStatus('main') : changedStatus,
        ),
        subscribe: vi.fn(() => () => undefined),
        engagementSessionSet: vi.fn(async () => workspace),
        fetchStream: vi.fn(
            (
                _repoId: RepoId,
                _opts: unknown,
                handlers: { onComplete?: () => void },
            ) => {
                queueMicrotask(() => handlers.onComplete?.());
                return () => undefined;
            },
        ),
        branchCreate: vi.fn(async () => ({})),
    }) as unknown as CbranchApi;

const renderOverview = (api: CbranchApi, pathname = '/w/client-a') => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter initialEntries={[pathname]}>
            <QueryClientProvider client={queryClient}>
                <ApiProvider api={api}>
                    <EngagementOverview />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

beforeEach(() => {
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    useUiStore.setState({
        activeEngagementId: engagementId,
        activeRepoId: null,
        settingsDialogOpen: false,
        settingsDialogTab: 'git',
    });
});
afterEach(() => cleanup());

describe('EngagementOverview', () => {
    test('renders live branch, working-tree, and upstream state for every repo', async () => {
        renderOverview(makeApi());
        expect(await screen.findByText('api')).toBeTruthy();
        expect(screen.getByText('web')).toBeTruthy();
        expect(await screen.findByText('Clean')).toBeTruthy();
        expect(await screen.findByText('1 staged')).toBeTruthy();
        expect(screen.getByText('2 ahead')).toBeTruthy();
        expect(screen.getByText('1 behind')).toBeTruthy();
    });

    test('fetches all selected repositories as one engagement action', async () => {
        const api = makeApi();
        renderOverview(api);
        const fetchButton = await screen.findByRole('button', {
            name: 'Fetch selected repositories',
        });
        await waitFor(() =>
            expect((fetchButton as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(fetchButton);
        await waitFor(() => expect(api.fetchStream).toHaveBeenCalledTimes(2));
    });

    test('cancels every pending fetch and reports each repository', async () => {
        const unsubscribe = vi.fn();
        const api = makeApi();
        api.fetchStream = vi.fn(() => unsubscribe);
        renderOverview(api);
        const fetchButton = await screen.findByRole('button', {
            name: 'Fetch selected repositories',
        });
        await waitFor(() =>
            expect((fetchButton as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(fetchButton);
        await waitFor(() => expect(api.fetchStream).toHaveBeenCalledTimes(2));
        fireEvent.click(
            screen.getByRole('button', { name: 'Cancel remaining' }),
        );
        await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2));
        expect(await screen.findAllByText('Cancelled by user')).toHaveLength(2);
    });

    test('creates and switches to one branch across selected repositories', async () => {
        const api = makeApi();
        renderOverview(api);
        const openButton = await screen.findByRole('button', {
            name: 'Create branch across selected repositories',
        });
        await waitFor(() =>
            expect((openButton as HTMLButtonElement).disabled).toBe(false),
        );
        fireEvent.click(openButton);
        fireEvent.change(screen.getByLabelText('Branch name'), {
            target: { value: 'feature/client-ticket' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create in 2' }));
        await waitFor(() => expect(api.branchCreate).toHaveBeenCalledTimes(2));
        expect(api.branchCreate).toHaveBeenCalledWith(
            apiRepoId,
            'feature/client-ticket',
            undefined,
            false,
            true,
        );
    });

    test('keeps successful branch creates and retries only the failed subset', async () => {
        const api = makeApi();
        let webAttempts = 0;
        api.branchCreate = vi.fn(async (repoId: RepoId) => {
            if (repoId === webRepoId && webAttempts++ === 0)
                throw new Error('web branch is locked');
            return {} as never;
        });
        renderOverview(api);
        const openButton = await screen.findByRole('button', {
            name: 'Create branch across selected repositories',
        });
        fireEvent.click(openButton);
        fireEvent.change(screen.getByLabelText('Branch name'), {
            target: { value: 'feature/retry' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create in 2' }));
        expect(await screen.findByText(/web branch is locked/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Retry 1 failed' }));
        await waitFor(() => expect(api.branchCreate).toHaveBeenCalledTimes(3));
        expect(api.branchCreate).toHaveBeenLastCalledWith(
            webRepoId,
            'feature/retry',
            undefined,
            false,
            true,
        );
    });

    test('starts a selected-repository Workspace Intelligence run', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-1'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'queued',
            createdAt: 1_700_000_000_000,
            eventSequence: 1,
            isCurrent: false,
            isValid: false,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 2,
                completedRepositoryCount: 0,
                analyzerCount: 0,
                isPartial: false,
                summary: 'Queued.',
            }),
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => []);
        api.workspaceIntelligenceStart = vi.fn(async () => run);
        api.workspaceIntelligenceRunSubscribe = vi.fn(() => () => undefined);
        renderOverview(api);

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        expect(
            await screen.findByRole('button', { name: 'Analyze workspace' }),
        ).toBeTruthy();
        const intelligenceNavigation = screen.getByRole('navigation', {
            name: 'Intelligence sections',
        });
        expect(
            screen.getByRole('link', { name: 'Overview' }).getAttribute('href'),
        ).toBe('#workspace-intelligence-analysis');
        expect(intelligenceNavigation.textContent).toContain('Runs');
        expect(
            screen.getByText(
                /does not call an AI provider or send source data/i,
            ),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Analyze web' }));
        fireEvent.click(
            screen.getByRole('button', { name: 'Analyze workspace' }),
        );
        await waitFor(() =>
            expect(api.workspaceIntelligenceStart).toHaveBeenCalledWith(
                engagementId,
                [apiRepoId],
            ),
        );
    });

    test('shows a guided inference setup action instead of a disabled enrichment button', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-inference-setup'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 1,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 2,
                completedRepositoryCount: 2,
                analyzerCount: 2,
                isPartial: false,
                summary: 'Complete.',
            }),
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.inferenceProfilesGet = vi.fn(async () => []);
        api.workspaceIntelligenceEnrichmentStart = vi.fn();
        api.workspaceIntelligenceEnrichmentList = vi.fn(async () => []);
        api.workspaceIntelligenceEnrichmentPreferredSet = vi.fn(
            async () => undefined,
        );
        renderOverview(
            api,
            '/w/client-a/intelligence/runs/run-inference-setup',
        );

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Set up AI enrichment',
            }),
        );

        expect(useUiStore.getState().settingsDialogOpen).toBe(true);
        expect(useUiStore.getState().settingsDialogTab).toBe('inference');
    });

    test('presents deterministic findings and a bounded graph preview without leading with raw Mermaid', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-report-preview'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 1,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 2,
                completedRepositoryCount: 2,
                analyzerCount: 2,
                isPartial: false,
                summary: 'Complete.',
            }),
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.workspaceIntelligenceRunReport = vi.fn(
            async () =>
                new WorkspaceIntelligenceReport({
                    runId: run.id,
                    markdown: `## Architecture integrity

- **warning** \`architecture.cycle\`: Verified dependency cycle involving 3 graph nodes.

## Architecture sketch

\`\`\`mermaid
flowchart LR
N1["API"]
N2["Web"]
N1 -->|depends-on| N2
TRUNCATED["Architecture sketch is bounded; inspect graph artifacts for all records."]
\`\`\``,
                    nodeCount: 2,
                    edgeCount: 1,
                    findingCount: 1,
                    unknownCount: 0,
                }),
        );
        renderOverview(api, '/w/client-a/intelligence/runs/run-report-preview');

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        expect(await screen.findByText('Graph preview')).toBeTruthy();
        expect(screen.getByText('Needs review')).toBeTruthy();
        expect(screen.getByText('API')).toBeTruthy();
        expect(
            screen.getByText(
                /This preview is bounded to keep the report readable/i,
            ),
        ).toBeTruthy();
        expect(screen.getByText('View raw report source')).toBeTruthy();
    });

    test('requests an archive descriptor and triggers a download for a valid run', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-archive-download'),
            engagementId,
            workspaceRepoIds: [apiRepoId],
            repoIds: [apiRepoId],
            state: 'completed',
            createdAt: 1,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 1,
                completedRepositoryCount: 1,
                analyzerCount: 1,
                isPartial: false,
                summary: 'Complete.',
            }),
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.workspaceIntelligenceArchiveRequest = vi.fn(
            async () =>
                new WorkspaceIntelligenceArchiveDescriptor({
                    url: '/sidechannel/workspace-intelligence-archive?token=test',
                    filename: 'workspace-intelligence-run-archive-download.tar',
                    contentType: 'application/x-tar',
                }),
        );
        const click = vi
            .spyOn(HTMLAnchorElement.prototype, 'click')
            .mockImplementation(() => undefined);
        renderOverview(
            api,
            '/w/client-a/intelligence/runs/run-archive-download',
        );

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        fireEvent.click(
            await screen.findByRole('button', { name: 'Download archive' }),
        );

        await waitFor(() =>
            expect(
                api.workspaceIntelligenceArchiveRequest,
            ).toHaveBeenCalledWith(engagementId, run.id),
        );
        expect(click).toHaveBeenCalledTimes(1);
        const link = click.mock.instances[0]!;
        expect(link.download).toBe(
            'workspace-intelligence-run-archive-download.tar',
        );
        expect(link.href).toContain(
            '/sidechannel/workspace-intelligence-archive?token=test',
        );
        click.mockRestore();
    });

    test('saves workspace analysis scope and budget defaults', async () => {
        const settings: WorkspaceIntelligenceAnalysisSettings = {
            includePatterns: ['src/**'],
            excludePatterns: [],
            maxSourceFiles: 25_000,
            maxSourceFileBytes: 512_000,
            maxRepositorySourceBytes: 100_000_000,
            maxRepositoryDurationMs: 120_000,
            maxGraphNodes: 100_000,
            maxGraphEdges: 200_000,
        };
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => []);
        api.workspaceIntelligenceAnalysisSettings = vi.fn(async () => settings);
        api.workspaceIntelligenceAnalysisSettingsSet = vi.fn(
            async (_engagementId, updated) => updated,
        );
        renderOverview(api);

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        expect(
            await screen.findByText('Analysis scope and safety budgets'),
        ).toBeTruthy();
        fireEvent.change(
            screen.getByLabelText('Include patterns (one per line)'),
            { target: { value: 'apps/**\nsrc/**' } },
        );
        fireEvent.change(screen.getByLabelText('Maximum source files'), {
            target: { value: '50' },
        });
        fireEvent.click(
            screen.getByRole('button', { name: 'Save workspace defaults' }),
        );

        await waitFor(() =>
            expect(
                api.workspaceIntelligenceAnalysisSettingsSet,
            ).toHaveBeenCalledWith(engagementId, {
                ...settings,
                includePatterns: ['apps/**', 'src/**'],
                maxSourceFiles: 50,
            }),
        );
    });

    test('searches a current architecture artifact without loading the full graph', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-search'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 1_700_000_000_000,
            finishedAt: 1_700_000_000_001,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 2,
                completedRepositoryCount: 2,
                analyzerCount: 2,
                isPartial: false,
                summary: 'Complete.',
            }),
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.workspaceIntelligenceRunReport = vi.fn(
            async () =>
                new WorkspaceIntelligenceReport({
                    runId: run.id,
                    markdown: '# Report',
                    nodeCount: 4,
                    edgeCount: 3,
                    unknownCount: 1,
                }),
        );
        api.workspaceIntelligenceGraphSearch = vi.fn(
            async () =>
                new WorkspaceIntelligenceGraphSearchResult({
                    nodes: [
                        {
                            id: 'api:component:package.json',
                            kind: 'component',
                            label: 'API service',
                            repoId: apiRepoId,
                            evidence: [{ path: 'package.json' }],
                        },
                    ],
                }),
        );
        api.workspaceIntelligenceSemanticSearch = vi.fn(
            async () =>
                new WorkspaceIntelligenceSemanticSearchResult({
                    mode: 'semantic',
                    nodes: [
                        {
                            id: 'api:component:package.json',
                            kind: 'component',
                            label: 'API service',
                            repoId: apiRepoId,
                            evidence: [{ path: 'package.json' }],
                        },
                    ],
                }),
        );
        api.workspaceIntelligenceComponentOverrides = vi.fn(async () => []);
        api.workspaceIntelligenceComponentOverridesSet = vi.fn(
            async (_engagementId, overrides) => overrides,
        );
        api.workspaceIntelligenceCurationActions = vi.fn(async () => []);
        api.workspaceIntelligenceCurationActionAppend = vi.fn(
            async (_engagementId, action) =>
                new WorkspaceIntelligenceCurationAction({
                    id: 'curation-edge-1',
                    at: 1,
                    actor: action.actor ?? 'local-user',
                    kind: action.kind,
                    targetId: action.targetId,
                    evidence: action.evidence ?? [],
                    metadata: action.metadata,
                }),
        );
        api.workspaceIntelligenceGraphNeighborhood = vi.fn(
            async () =>
                new WorkspaceIntelligenceGraphNeighborhood({
                    nodes: [
                        {
                            id: 'api:component:package.json',
                            kind: 'component',
                            label: 'API service',
                            repoId: apiRepoId,
                            evidence: [],
                        },
                        {
                            id: 'api:contract:http:users',
                            kind: 'contract.http.route',
                            label: 'GET /users',
                            repoId: apiRepoId,
                            evidence: [],
                        },
                    ],
                    edges: [
                        {
                            from: 'api:component:package.json',
                            to: 'api:contract:http:users',
                            kind: 'exposes-contract',
                            evidence: [],
                        },
                    ],
                }),
        );
        api.workspaceIntelligencePresentationGet = vi.fn(
            async () =>
                new WorkspaceIntelligencePresentation({
                    schemaVersion: 1,
                    runId: run.id,
                    expandedNodeIds: [],
                    nodePositions: [],
                    showInferredEdges: false,
                    minimumConfidenceTier: 'low',
                }),
        );
        api.workspaceIntelligencePresentationSet = vi.fn(
            async (_engagementId, presentation) => presentation,
        );
        api.inferenceProfilesGet = vi.fn(async () => [
            new InferenceProfile({
                id: 'ollama-local',
                label: 'Ollama local embeddings',
                provider: 'local-embeddings',
                enabled: true,
                capabilities: ['embeddings'],
                modelId: 'mxbai-embed-large:latest',
                executable: '/usr/bin/ollama',
            }),
        ]);
        renderOverview(
            api,
            '/w/client-a/intelligence/runs/run-search?node=api%3Acomponent%3Apackage.json',
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceGraphNeighborhood,
            ).toHaveBeenCalledWith(
                engagementId,
                run.id,
                'api:component:package.json',
            ),
        );
        expect(
            await screen.findByRole('heading', {
                name: 'Selected node connections',
            }),
        ).toBeTruthy();
        expect(api.workspaceIntelligencePresentationSet).not.toHaveBeenCalled();
        fireEvent.change(
            await screen.findByRole('textbox', {
                name: 'Search architecture',
            }),
            { target: { value: 'api' } },
        );

        expect(await screen.findByText('API service')).toBeTruthy();
        expect(api.workspaceIntelligenceGraphSearch).toHaveBeenCalledWith(
            engagementId,
            run.id,
            'api',
        );
        fireEvent.click(screen.getByText('Use semantic search'));
        fireEvent.change(
            await screen.findByLabelText('Semantic search profile override'),
            { target: { value: 'ollama-local' } },
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Search semantically' }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceSemanticSearch,
            ).toHaveBeenCalledWith(
                engagementId,
                run.id,
                'api',
                undefined,
                'ollama-local',
            ),
        );
        fireEvent.click(
            await screen.findByRole('button', { name: 'Show connections' }),
        );
        await waitFor(() =>
            expect(document.querySelector('.react-flow')).not.toBeNull(),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligencePresentationSet,
            ).toHaveBeenCalledWith(
                engagementId,
                expect.objectContaining({
                    selectedNodeId: 'api:component:package.json',
                    expandedNodeIds: ['api:component:package.json'],
                }),
            ),
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Curate relationship' }),
        );
        fireEvent.change(
            screen.getByRole('textbox', {
                name: 'Relationship curation note',
            }),
            { target: { value: 'Observed client contract.' } },
        );
        fireEvent.click(
            screen.getByRole('button', {
                name: 'Save relationship note',
            }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceCurationActionAppend,
            ).toHaveBeenCalledWith(engagementId, {
                kind: 'edge.annotate',
                targetId:
                    'api:component:package.json\u0000exposes-contract\u0000api:contract:http:users',
                evidence: [],
                metadata: { note: 'Observed client contract.' },
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Edit component' }));
        fireEvent.change(
            screen.getByRole('textbox', { name: 'Component display name' }),
            { target: { value: 'Public API' } },
        );
        fireEvent.change(
            screen.getByRole('textbox', {
                name: 'Component classification',
            }),
            { target: { value: 'service' } },
        );
        fireEvent.change(
            screen.getByRole('textbox', { name: 'Component note' }),
            {
                target: { value: 'Owned by platform.' },
            },
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Save component curation' }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceComponentOverridesSet,
            ).toHaveBeenCalledWith(engagementId, [
                {
                    componentId: 'api:component:package.json',
                    displayName: 'Public API',
                    kind: 'service',
                    note: 'Owned by platform.',
                },
            ]),
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Suppress component' }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceComponentOverridesSet,
            ).toHaveBeenCalledWith(engagementId, [
                {
                    componentId: 'api:component:package.json',
                    displayName: 'Public API',
                    kind: 'service',
                    note: 'Owned by platform.',
                    suppressed: true,
                },
            ]),
        );
        expect(
            await screen.findByRole('button', { name: 'Restore Public API' }),
        ).toBeTruthy();
    });

    test('keeps inferred enrichment relationships hidden until explicitly opened', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-enrichment'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 1_700_000_000_000,
            finishedAt: 1_700_000_000_001,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 2,
                completedRepositoryCount: 2,
                analyzerCount: 2,
                isPartial: false,
                summary: 'Complete.',
            }),
        });
        const attempt = new WorkspaceIntelligenceEnrichmentAttempt({
            id: 'attempt-1',
            runId: run.id,
            profileId: 'hosted-default',
            modelId: 'example-model',
            promptSchemaVersion: 'workspace-intelligence.enrichment@1',
            createdAt: 1,
            completedAt: 2,
            evidenceIds: ['component:api'],
            state: 'completed',
            repairAttempted: false,
            inferredEdges: [
                new WorkspaceIntelligenceInferredEdge({
                    from: 'component:api',
                    to: 'contract:users',
                    kind: 'exposes',
                    confidence: 0.83,
                    confidenceTier: 'high',
                    evidenceIds: ['component:api'],
                    rationale: 'The selected API component exposes users.',
                }),
            ],
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.workspaceIntelligenceEnrichmentList = vi.fn(async () => [attempt]);
        api.workspaceIntelligenceEnrichmentPreferredGet = vi.fn(
            async () => undefined,
        );
        api.workspaceIntelligenceEnrichmentStart = vi.fn(async () => attempt);
        api.workspaceIntelligenceEnrichmentPreferredSet = vi.fn(
            async () => attempt,
        );
        api.workspaceIntelligenceCurationActionAppend = vi.fn(
            async (_engagementId, action) =>
                new WorkspaceIntelligenceCurationAction({
                    id: 'curation-inferred-1',
                    at: 3,
                    actor: action.actor ?? 'local-user',
                    kind: action.kind,
                    targetId: action.targetId,
                    evidence: action.evidence ?? [],
                    metadata: action.metadata,
                }),
        );
        api.inferenceProfilesGet = vi.fn(async () => [
            new InferenceProfile({
                id: 'hosted-default',
                label: 'Hosted default',
                provider: 'openai-compatible',
                enabled: true,
                capabilities: ['generation'],
                modelId: 'example-model',
                endpoint: 'https://inference.example.test/v1',
                secretReference: {
                    kind: 'environment',
                    name: 'INFERENCE_TEST_KEY',
                },
            }),
            new InferenceProfile({
                id: 'codex-local',
                label: 'Local Codex',
                provider: 'codex',
                enabled: true,
                capabilities: ['generation'],
                modelId: 'gpt-5.6-codex',
                executable: '/usr/bin/codex',
                secretReference: {
                    kind: 'environment',
                    name: 'CODEX_API_KEY',
                },
            }),
        ]);
        renderOverview(api, '/w/client-a/intelligence/runs/run-enrichment');

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        expect(
            await screen.findByText('Optional inference enrichment'),
        ).toBeTruthy();
        expect(screen.queryByText(/component:api · exposes/)).toBeNull();
        fireEvent.click(
            await screen.findByRole('button', {
                name: 'Show 1 inferred relationship',
            }),
        );
        expect(await screen.findByText(/component:api · exposes/)).toBeTruthy();
        expect(screen.getByText('Evidence: component:api')).toBeTruthy();
        fireEvent.click(
            screen.getByRole('button', {
                name: 'Confirm inferred relationship',
            }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceCurationActionAppend,
            ).toHaveBeenCalledWith(
                engagementId,
                expect.objectContaining({
                    kind: 'edge.confirm',
                    targetId: 'component:api\0exposes\0contract:users',
                    evidence: [
                        expect.objectContaining({
                            kind: 'inference.selected-evidence',
                            attemptId: 'attempt-1',
                            evidenceId: 'component:api',
                        }),
                    ],
                }),
            ),
        );
        fireEvent.change(
            await screen.findByLabelText('Enrichment profile override'),
            { target: { value: 'codex-local' } },
        );
        fireEvent.click(screen.getByRole('button', { name: 'Run enrichment' }));
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceEnrichmentStart,
            ).toHaveBeenCalledWith(engagementId, run.id, 'codex-local'),
        );
    });

    test('allows an in-flight enrichment to be cancelled', async () => {
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-cancel-enrichment'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 1,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage: new WorkspaceIntelligenceCoverage({
                repositoryCount: 2,
                completedRepositoryCount: 2,
                analyzerCount: 2,
                isPartial: false,
                summary: 'Complete.',
            }),
        });
        let finish: (
            attempt: WorkspaceIntelligenceEnrichmentAttempt,
        ) => void = () => undefined;
        const pending = new Promise<WorkspaceIntelligenceEnrichmentAttempt>(
            resolve => {
                finish = resolve;
            },
        );
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.workspaceIntelligenceEnrichmentList = vi.fn(async () => []);
        api.workspaceIntelligenceEnrichmentPreferredGet = vi.fn(
            async () => undefined,
        );
        api.workspaceIntelligenceEnrichmentPreferredSet = vi.fn(
            async () => undefined,
        );
        api.workspaceIntelligenceEnrichmentStart = vi.fn(() => pending);
        api.workspaceIntelligenceEnrichmentCancel = vi.fn(
            async () => undefined,
        );
        renderOverview(
            api,
            '/w/client-a/intelligence/runs/run-cancel-enrichment',
        );

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        fireEvent.click(
            await screen.findByRole('button', { name: 'Run enrichment' }),
        );
        fireEvent.click(
            await screen.findByRole('button', { name: 'Cancel enrichment' }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceEnrichmentCancel,
            ).toHaveBeenCalledWith(engagementId, run.id),
        );
        finish(
            new WorkspaceIntelligenceEnrichmentAttempt({
                id: 'attempt-cancelled',
                runId: run.id,
                profileId: 'hosted-default',
                modelId: 'example-model',
                promptSchemaVersion: 'workspace-intelligence.enrichment@1',
                createdAt: 1,
                completedAt: 2,
                evidenceIds: ['component:api'],
                state: 'cancelled',
                repairAttempted: false,
                inferredEdges: [],
                failure: new WorkspaceIntelligenceEnrichmentFailure({
                    code: 'cancelled',
                    message: 'Enrichment cancelled.',
                    repairAttempted: false,
                }),
            }),
        );
    });

    test('requires confirmation before deleting a historical Intelligence run', async () => {
        const coverage = new WorkspaceIntelligenceCoverage({
            repositoryCount: 2,
            completedRepositoryCount: 2,
            analyzerCount: 2,
            isPartial: false,
            summary: 'Complete.',
        });
        const current = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-current'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 2,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage,
        });
        const historical = new WorkspaceIntelligenceRun({
            ...current,
            id: WorkspaceIntelligenceRunId.make('run-history'),
            createdAt: 1,
            isCurrent: false,
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [
            current,
            historical,
        ]);
        api.workspaceIntelligenceRunDelete = vi.fn(async () => undefined);
        renderOverview(api);

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        fireEvent.click(
            await screen.findByRole('button', { name: 'Delete run' }),
        );
        expect(
            screen.getByRole('button', { name: 'Confirm delete run' }),
        ).toBeTruthy();
        expect(api.workspaceIntelligenceRunDelete).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getByRole('button', { name: 'Confirm delete run' }),
        );
        await waitFor(() =>
            expect(api.workspaceIntelligenceRunDelete).toHaveBeenCalledWith(
                engagementId,
                historical.id,
            ),
        );
    });

    test('requires confirmation before clearing Intelligence run history', async () => {
        const coverage = new WorkspaceIntelligenceCoverage({
            repositoryCount: 2,
            completedRepositoryCount: 2,
            analyzerCount: 2,
            isPartial: false,
            summary: 'Complete.',
        });
        const run = new WorkspaceIntelligenceRun({
            id: WorkspaceIntelligenceRunId.make('run-current'),
            engagementId,
            workspaceRepoIds: [apiRepoId, webRepoId],
            repoIds: [apiRepoId, webRepoId],
            state: 'completed',
            createdAt: 2,
            eventSequence: 1,
            isCurrent: true,
            isValid: true,
            coverage,
        });
        const api = makeApi();
        api.workspaceIntelligenceRunList = vi.fn(async () => [run]);
        api.workspaceIntelligenceRunHistoryClear = vi.fn(async () => undefined);
        renderOverview(api);

        fireEvent.click(
            await screen.findByRole('button', { name: 'Intelligence' }),
        );
        fireEvent.click(
            await screen.findByRole('button', { name: 'Clear all history' }),
        );
        expect(
            screen.getByRole('button', { name: 'Confirm clear all history' }),
        ).toBeTruthy();
        expect(api.workspaceIntelligenceRunHistoryClear).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getByRole('button', { name: 'Confirm clear all history' }),
        );
        await waitFor(() =>
            expect(
                api.workspaceIntelligenceRunHistoryClear,
            ).toHaveBeenCalledWith(engagementId),
        );
    });
});
