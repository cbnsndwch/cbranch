// @vitest-environment jsdom
import {
    ChangeSetId,
    Engagement,
    EngagementId,
    EngagementWorkspace,
    ForgeRateLimit,
    GitHubPullRequest,
    GitHubPullRequestList,
    PullRequestCheckSummary,
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
import { EngagementPullRequests } from './EngagementPullRequests';

const apiRepoId = RepoId.make('api');
const webRepoId = RepoId.make('web');
const repo = (repoId: RepoId, name: string) =>
    new RecentRepo({
        repoId,
        name,
        path: `/repos/${name}`,
        lastOpenedAt: 1,
    });
const engagement = new Engagement({
    id: EngagementId.make('client-a'),
    name: 'Client A',
    color: 'teal',
    repositories: [repo(apiRepoId, 'api'), repo(webRepoId, 'web')],
    openRepoIds: [],
    changeSets: [],
    createdAt: 1,
    updatedAt: 1,
});

const response = (repoId: RepoId, repository: string, number: number) =>
    new GitHubPullRequestList({
        repoId,
        repository,
        repositoryUrl: `https://github.com/${repository}`,
        pullRequests: [
            new GitHubPullRequest({
                repoId,
                repository,
                number,
                title:
                    repoId === apiRepoId
                        ? 'Add consulting API'
                        : 'Update client dashboard',
                url: `https://github.com/${repository}/pull/${number}`,
                state: 'open',
                isDraft: repoId === webRepoId,
                headRefName: 'feature/client-a',
                baseRefName: 'main',
                authorLogin: repoId === apiRepoId ? 'ada' : 'grace',
                reviewerLogins: ['reviewer'],
                reviewDecision:
                    repoId === apiRepoId ? 'approved' : 'reviewRequired',
                checks: new PullRequestCheckSummary({
                    total: 2,
                    passed: repoId === apiRepoId ? 2 : 1,
                    failed: 0,
                    pending: repoId === apiRepoId ? 0 : 1,
                }),
                updatedAt: '2026-07-10T12:00:00Z',
            }),
        ],
        rateLimit: new ForgeRateLimit({ remaining: 90, resetAt: 100 }),
    });

const renderView = (api: CbranchApi) => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={queryClient}>
            <ApiProvider api={api}>
                <EngagementPullRequests engagement={engagement} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

afterEach(() => cleanup());

describe('EngagementPullRequests', () => {
    test('aggregates PRs only from repositories in the active engagement', async () => {
        const pullsList = vi.fn(async (repoId: RepoId) =>
            repoId === apiRepoId
                ? response(repoId, 'acme/api', 12)
                : response(repoId, 'acme/web', 34),
        );
        const api = { githubPullsList: pullsList } as unknown as CbranchApi;
        renderView(api);

        expect(await screen.findByText('Add consulting API')).toBeTruthy();
        expect(screen.getByText('Update client dashboard')).toBeTruthy();
        expect(screen.getByText('Approved')).toBeTruthy();
        expect(screen.getByText('1 pending')).toBeTruthy();
        expect(pullsList).toHaveBeenCalledTimes(2);
        expect(pullsList.mock.calls.map(call => call[0])).toEqual([
            apiRepoId,
            webRepoId,
        ]);
        expect(
            screen.getByRole('combobox', { name: 'Filter by reviewer' }),
        ).toBeTruthy();
    });

    test('filters the aggregate by title, repository, branch, or author', async () => {
        const api = {
            githubPullsList: vi.fn(async (repoId: RepoId) =>
                repoId === apiRepoId
                    ? response(repoId, 'acme/api', 12)
                    : response(repoId, 'acme/web', 34),
            ),
        } as unknown as CbranchApi;
        renderView(api);
        await screen.findByText('Add consulting API');

        fireEvent.change(screen.getByLabelText('Filter pull requests'), {
            target: { value: 'grace' },
        });
        await waitFor(() =>
            expect(screen.queryByText('Add consulting API')).toBeNull(),
        );
        expect(screen.getByText('Update client dashboard')).toBeTruthy();
    });

    test('adds selected PRs to a new engagement change set', async () => {
        const changeSet = new PullRequestChangeSet({
            id: ChangeSetId.make('release'),
            name: 'Release',
            description: '',
            pullRequests: [],
            createdAt: 1,
            updatedAt: 1,
        });
        const workspace = (sets: ReadonlyArray<PullRequestChangeSet>) =>
            new EngagementWorkspace({
                engagements: [
                    new Engagement({ ...engagement, changeSets: sets }),
                ],
                activeEngagementId: engagement.id,
                unassignedRepositories: [],
            });
        const itemsSet = vi.fn(async () => workspace([changeSet]));
        const api = {
            githubPullsList: vi.fn(async (repoId: RepoId) =>
                repoId === apiRepoId
                    ? response(repoId, 'acme/api', 12)
                    : response(repoId, 'acme/web', 34),
            ),
            engagementList: vi.fn(async () => workspace([])),
            changeSetCreate: vi.fn(async () => workspace([changeSet])),
            changeSetItemsSet: itemsSet,
        } as unknown as CbranchApi;
        renderView(api);
        await screen.findByText('Add consulting API');

        fireEvent.click(
            screen.getByRole('checkbox', {
                name: 'Select acme/api pull request 12',
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Change set (1)' }));
        fireEvent.change(await screen.findByLabelText('New change set name'), {
            target: { value: 'Release' },
        });
        fireEvent.click(
            screen.getByRole('button', { name: 'Add pull requests' }),
        );

        await waitFor(() => expect(itemsSet).toHaveBeenCalledTimes(1));
        expect(itemsSet.mock.calls[0]?.[2]).toMatchObject([
            { repoId: apiRepoId, number: 12, repository: 'acme/api' },
        ]);
    });
});
