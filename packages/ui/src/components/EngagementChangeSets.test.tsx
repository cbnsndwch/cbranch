// @vitest-environment jsdom
import {
    ChangeSetId,
    ChangeSetPullRequest,
    Engagement,
    EngagementId,
    EngagementWorkspace,
    PullRequestChangeSet,
    RecentRepo,
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
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { EngagementChangeSets } from './EngagementChangeSets';

const apiId = RepoId.make('api');
const webId = RepoId.make('web');
const item = (repoId: RepoId, repository: string, number: number) =>
    new ChangeSetPullRequest({
        repoId,
        repository,
        number,
        title: `${repository} change`,
        url: `https://github.com/${repository}/pull/${number}`,
        headRefName: `feature/${number}`,
        baseRefName: 'main',
        dependencyNote: '',
    });
const changeSet = new PullRequestChangeSet({
    id: ChangeSetId.make('release'),
    name: 'Release train',
    description: 'API first',
    pullRequests: [item(apiId, 'acme/api', 1), item(webId, 'acme/web', 2)],
    createdAt: 1,
    updatedAt: 1,
});
const engagement = new Engagement({
    id: EngagementId.make('client'),
    name: 'Client',
    color: 'blue',
    repositories: [
        new RecentRepo({
            repoId: apiId,
            name: 'api',
            path: '/repos/api',
            lastOpenedAt: 1,
        }),
        new RecentRepo({
            repoId: webId,
            name: 'web',
            path: '/repos/web',
            lastOpenedAt: 1,
        }),
    ],
    openRepoIds: [apiId, webId],
    activeRepoId: apiId,
    changeSets: [changeSet],
    createdAt: 1,
    updatedAt: 1,
});
const workspace = new EngagementWorkspace({
    engagements: [engagement],
    activeEngagementId: engagement.id,
    unassignedRepositories: [],
});

const renderView = (api: CbranchApi) => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={client}>
            <ApiProvider api={api}>
                <EngagementChangeSets
                    engagement={engagement}
                    onBrowsePullRequests={vi.fn()}
                />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

afterEach(() => cleanup());

describe('EngagementChangeSets', () => {
    test('saves dependency notes and explicit PR ordering', async () => {
        const update = vi.fn(async () => workspace);
        const itemsSet = vi.fn(async () => workspace);
        const api = {
            changeSetUpdate: update,
            changeSetItemsSet: itemsSet,
        } as unknown as CbranchApi;
        renderView(api);

        const notes = screen.getAllByLabelText('Dependency note');
        fireEvent.change(notes[0]!, {
            target: { value: 'Deploy after migrations' },
        });
        fireEvent.click(
            screen.getByRole('button', { name: 'Move acme/api change down' }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(itemsSet).toHaveBeenCalledTimes(1));
        const saved = itemsSet.mock.calls[0]?.[2];
        expect(saved?.map(entry => entry.number)).toEqual([2, 1]);
        expect(saved?.[1]?.dependencyNote).toBe('Deploy after migrations');
        expect(update).toHaveBeenCalledWith(
            engagement.id,
            changeSet.id,
            expect.objectContaining({ name: 'Release train' }),
        );
    });
});
