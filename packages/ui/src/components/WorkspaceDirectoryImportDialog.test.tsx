// @vitest-environment jsdom
import {
    Engagement,
    EngagementDirectoryCandidate,
    EngagementDirectoryPreview,
    EngagementId,
    EngagementSlug,
    EngagementWorkspace,
    RepoId,
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
import { afterEach, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { WorkspaceDirectoryImportDialog } from './WorkspaceDirectoryImportDialog';

const engagementId = EngagementId.make('workspace-1');
const apiRepoId = RepoId.make('repo-api');
const otherRepoId = RepoId.make('repo-other');

const workspace = new EngagementWorkspace({
    activeEngagementId: engagementId,
    engagements: [
        new Engagement({
            id: engagementId,
            name: 'Client',
            slug: EngagementSlug.make('client'),
            color: 'teal',
            repositories: [],
            openRepoIds: [],
            changeSets: [],
            createdAt: 0,
            updatedAt: 0,
        }),
        new Engagement({
            id: EngagementId.make('workspace-2'),
            name: 'Another client',
            slug: EngagementSlug.make('another-client'),
            color: 'blue',
            repositories: [
                {
                    repoId: otherRepoId,
                    name: 'other',
                    path: '/srv/other',
                    lastOpenedAt: 0,
                },
            ],
            openRepoIds: [],
            changeSets: [],
            createdAt: 0,
            updatedAt: 0,
        }),
    ],
    unassignedRepositories: [],
});

const preview = new EngagementDirectoryPreview({
    path: '/srv/client',
    candidates: [
        new EngagementDirectoryCandidate({
            name: 'api',
            root: '/srv/client/api',
            repoId: apiRepoId,
        }),
        new EngagementDirectoryCandidate({
            name: 'other',
            root: '/srv/client/other',
            repoId: otherRepoId,
        }),
    ],
    truncated: false,
});

afterEach(cleanup);

test('imports only unassigned immediate repository candidates', async () => {
    const importDirectory = vi.fn(async () => workspace);
    const api = {
        engagementList: vi.fn(async () => workspace),
        engagementDirectoryPreview: vi.fn(async () => preview),
        engagementDirectoryImport: importDirectory,
    } as unknown as CbranchApi;
    const onOpenChange = vi.fn();
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });

    render(
        <MemoryRouter>
            <QueryClientProvider client={queryClient}>
                <ApiProvider api={api}>
                    <WorkspaceDirectoryImportDialog
                        open
                        onOpenChange={onOpenChange}
                        target={{ kind: 'existing', engagementId }}
                    />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );

    fireEvent.change(screen.getByPlaceholderText('/home/user/workspace'), {
        target: { value: '/srv/client' },
    });

    await screen.findByText('api');
    expect(screen.getByText('Already in Another client')).toBeTruthy();
    fireEvent.click(
        screen.getByRole('button', { name: 'Import 1 repositories' }),
    );

    await waitFor(() =>
        expect(importDirectory).toHaveBeenCalledWith({
            path: '/srv/client',
            candidateRoots: ['/srv/client/api'],
            target: { kind: 'existing', engagementId },
        }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
});
