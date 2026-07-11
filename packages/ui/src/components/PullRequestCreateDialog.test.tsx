// @vitest-environment jsdom
import {
    GitHubPullRequestCreated,
    GitHubPullRequestPreview,
    Oid,
    PullRequestPreviewCommit,
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
import { PullRequestCreateDialog } from './PullRequestCreateDialog';

const repoId = RepoId.make('repo');
const headOid = Oid.make('a'.repeat(40));
const baseOid = Oid.make('b'.repeat(40));
const repo = new RecentRepo({
    repoId,
    name: 'api',
    path: '/repos/api',
    lastOpenedAt: 1,
});
const preview = new GitHubPullRequestPreview({
    repoId,
    repository: 'acme/api',
    repositoryUrl: 'https://github.com/acme/api',
    headRefName: 'feature/release',
    headOid,
    baseRefName: 'main',
    baseOid,
    mergeBaseOid: baseOid,
    publishedHeadOid: headOid,
    headPublished: true,
    commits: [
        new PullRequestPreviewCommit({
            oid: headOid,
            subject: 'Coordinate release',
            authorName: 'Ada',
            authoredAt: '2026-07-10T12:00:00Z',
        }),
    ],
});

afterEach(() => cleanup());

describe('PullRequestCreateDialog', () => {
    test('shows the exact range and submits edited fields', async () => {
        const create = vi.fn(
            async () =>
                new GitHubPullRequestCreated({
                    repoId,
                    repository: 'acme/api',
                    number: 42,
                    url: 'https://github.com/acme/api/pull/42',
                }),
        );
        const api = {
            githubPullPreview: vi.fn(async () => preview),
            githubPullCreate: create,
        } as unknown as CbranchApi;
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        render(
            <QueryClientProvider client={client}>
                <ApiProvider api={api}>
                    <PullRequestCreateDialog
                        open
                        onOpenChange={vi.fn()}
                        repo={repo}
                    />
                </ApiProvider>
            </QueryClientProvider>,
        );

        expect(await screen.findByText('feature/release')).toBeTruthy();
        expect(screen.getByText('Coordinate release')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Body'), {
            target: { value: 'Release details' },
        });
        fireEvent.click(
            screen.getByRole('checkbox', { name: 'Create as draft' }),
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Create pull request' }),
        );

        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create).toHaveBeenCalledWith(repoId, {
            title: 'Coordinate release',
            body: 'Release details',
            baseRefName: 'main',
            draft: true,
        });
        expect(
            await screen.findByText('Pull request #42 created'),
        ).toBeTruthy();
    });
});
