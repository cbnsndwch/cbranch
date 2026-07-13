// @vitest-environment jsdom
import {
    Engagement,
    EngagementId,
    EngagementWorkspace,
    RecentRepo,
    RepoId,
    RepoState,
    StatusBranch,
    StatusEntry,
    WorkingTreeStatus,
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

const renderOverview = (api: CbranchApi) => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter initialEntries={[`/workspaces/${engagementId}`]}>
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
});
