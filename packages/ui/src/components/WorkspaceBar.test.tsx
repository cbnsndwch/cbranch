// @vitest-environment jsdom
import {
    Engagement,
    EngagementId,
    EngagementSlug,
    EngagementWorkspace,
    RecentRepo,
    RepoId,
    WorkingTreeStatus,
} from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { WorkspaceBar } from './WorkspaceBar';

const clientA = EngagementId.make('client-a');
const clientB = EngagementId.make('client-b');
const engagement = (id: typeof clientA, name: string) =>
    new Engagement({
        id,
        name,
        slug: EngagementSlug.make(id),
        color: id === clientA ? 'teal' : 'rose',
        repositories: [],
        openRepoIds: [],
        changeSets: [],
        createdAt: 1,
        updatedAt: 1,
    });

afterEach(() => cleanup());

describe('WorkspaceBar', () => {
    test('persists a directly routed engagement as the launch-restored context', async () => {
        const engagements = [
            engagement(clientA, 'Client A'),
            engagement(clientB, 'Client B'),
        ];
        const initial = new EngagementWorkspace({
            engagements,
            activeEngagementId: clientB,
            unassignedRepositories: [],
        });
        const activate = vi.fn(
            async (id: typeof clientA) =>
                new EngagementWorkspace({
                    engagements,
                    activeEngagementId: id,
                    unassignedRepositories: [],
                }),
        );
        const api = {
            engagementList: vi.fn(async () => initial),
            engagementActivate: activate,
        } as unknown as CbranchApi;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        useUiStore.setState({
            activeEngagementId: clientA,
            activeRepoId: null,
        });

        render(
            <MemoryRouter>
                <QueryClientProvider client={queryClient}>
                    <ApiProvider api={api}>
                        <WorkspaceBar />
                    </ApiProvider>
                </QueryClientProvider>
            </MemoryRouter>,
        );

        await waitFor(() => expect(activate).toHaveBeenCalledWith(clientA));
    });

    test('persists a deep-linked open repository as the active engagement tab', async () => {
        const repoA = new RecentRepo({
            repoId: RepoId.make('repo-a'),
            name: 'api',
            path: '/repos/api',
            lastOpenedAt: 1,
        });
        const repoB = new RecentRepo({
            repoId: RepoId.make('repo-b'),
            name: 'web',
            path: '/repos/web',
            lastOpenedAt: 1,
        });
        const active = new Engagement({
            id: clientA,
            name: 'Client A',
            slug: EngagementSlug.make('client-a'),
            color: 'teal',
            repositories: [repoA, repoB],
            openRepoIds: [repoA.repoId, repoB.repoId],
            activeRepoId: repoB.repoId,
            changeSets: [],
            createdAt: 1,
            updatedAt: 1,
        });
        const workspace = new EngagementWorkspace({
            engagements: [active],
            activeEngagementId: clientA,
            unassignedRepositories: [],
        });
        const sessionSet = vi.fn(async () => workspace);
        const api = {
            engagementList: vi.fn(async () => workspace),
            engagementSessionSet: sessionSet,
            statusGet: vi.fn(
                async () =>
                    new WorkingTreeStatus({
                        entries: [],
                        hasConflicts: false,
                    }),
            ),
            subscribe: vi.fn(() => () => undefined),
        } as unknown as CbranchApi;
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        useUiStore.setState({
            activeEngagementId: clientA,
            activeRepoId: repoA.repoId,
        });

        render(
            <MemoryRouter>
                <QueryClientProvider client={queryClient}>
                    <ApiProvider api={api}>
                        <WorkspaceBar />
                    </ApiProvider>
                </QueryClientProvider>
            </MemoryRouter>,
        );

        await waitFor(() =>
            expect(sessionSet).toHaveBeenCalledWith(
                clientA,
                [repoA.repoId, repoB.repoId],
                repoA.repoId,
            ),
        );
    });
});
