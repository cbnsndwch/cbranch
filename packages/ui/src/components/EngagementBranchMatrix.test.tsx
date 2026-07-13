// @vitest-environment jsdom
import {
    BranchInfo,
    BranchListing,
    BranchUpstream,
    Engagement,
    EngagementId,
    EngagementSlug,
    Oid,
    RecentRepo,
    RepoId,
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import {
    buildBranchMatrix,
    EngagementBranchMatrix,
} from './EngagementBranchMatrix';

const apiId = RepoId.make('api');
const webId = RepoId.make('web');
const oid = Oid.make('a'.repeat(40));
const repo = (repoId: RepoId, name: string) =>
    new RecentRepo({
        repoId,
        name,
        path: `/repos/${name}`,
        lastOpenedAt: 1,
    });
const apiRepo = repo(apiId, 'api');
const webRepo = repo(webId, 'web');
const engagement = new Engagement({
    id: EngagementId.make('client'),
    name: 'Client',
    slug: EngagementSlug.make('client'),
    color: 'teal',
    repositories: [apiRepo, webRepo],
    openRepoIds: [apiId, webId],
    activeRepoId: apiId,
    changeSets: [],
    createdAt: 1,
    updatedAt: 1,
});

const branch = (name: string, current: boolean, upstream = true) =>
    new BranchInfo({
        name,
        fullRef: `refs/heads/${name}`,
        tipOid: oid,
        tipSubject: name,
        isCurrent: current,
        upstream: upstream
            ? new BranchUpstream({
                  ref: `refs/remotes/origin/${name}`,
                  name: `origin/${name}`,
                  ahead: 1,
                  behind: 0,
              })
            : undefined,
        isRemote: false,
    });
const remoteBranch = (name: string) =>
    new BranchInfo({
        name: `origin/${name}`,
        fullRef: `refs/remotes/origin/${name}`,
        tipOid: oid,
        tipSubject: name,
        isCurrent: false,
        isRemote: true,
        remoteName: 'origin',
    });
const listing = () =>
    new BranchListing({
        localBranches: [branch('main', true), branch('feature/shared', false)],
        remoteBranches: [remoteBranch('main'), remoteBranch('feature/shared')],
        currentBranch: 'main',
    });
const status = (dirty: boolean) =>
    new WorkingTreeStatus({
        entries: dirty
            ? [
                  new StatusEntry({
                      path: 'app.ts',
                      staged: 'unmodified',
                      unstaged: 'modified',
                      isConflicted: false,
                      isUntracked: false,
                      isIgnored: false,
                      isSubmodule: false,
                  }),
              ]
            : [],
        branch: new StatusBranch({ head: 'main', upstream: 'origin/main' }),
        hasConflicts: false,
    });

beforeEach(() => {
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
});
afterEach(() => cleanup());

describe('EngagementBranchMatrix', () => {
    test('marks local and remote branch gaps per repository', () => {
        const apiListing = listing();
        const webListing = new BranchListing({
            localBranches: [branch('main', true)],
            remoteBranches: [remoteBranch('main')],
            currentBranch: 'main',
        });
        const rows = buildBranchMatrix(
            [apiRepo, webRepo],
            new Map([
                [apiId, apiListing],
                [webId, webListing],
            ]),
            'feature/shared',
        );

        expect(rows[0]).toMatchObject({
            local: { name: 'feature/shared' },
            remote: { name: 'origin/feature/shared' },
        });
        expect(rows[1]?.local).toBeUndefined();
        expect(rows[1]?.remote).toBeUndefined();
    });

    test('uses an explicit dirty-tree strategy and retries only failed repos', async () => {
        let webAttempts = 0;
        const branchSwitch = vi.fn(async (repoId: RepoId) => {
            if (repoId === webId && webAttempts++ === 0)
                throw new Error('web is locked');
        });
        const api = {
            branchList: vi.fn(async () => listing()),
            statusGet: vi.fn(async (repoId: RepoId) =>
                status(repoId === webId),
            ),
            branchSwitch,
        } as unknown as CbranchApi;
        const client = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        render(
            <QueryClientProvider client={client}>
                <ApiProvider api={api}>
                    <EngagementBranchMatrix
                        engagement={engagement}
                        selectedRepoIds={new Set([apiId, webId])}
                    />
                </ApiProvider>
            </QueryClientProvider>,
        );

        expect(
            await screen.findByText(/2 common across 2 selected/),
        ).toBeTruthy();
        fireEvent.click(
            screen.getByRole('button', { name: 'Switch selected' }),
        );
        fireEvent.click(
            await screen.findByRole('button', {
                name: /Stash and reapply/,
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Switch 2' }));
        await waitFor(() => expect(branchSwitch).toHaveBeenCalledTimes(2));
        expect(branchSwitch).toHaveBeenCalledWith(
            webId,
            'feature/shared',
            'stash',
            true,
        );
        expect(await screen.findByText('web is locked')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Retry 1 failed' }));
        await waitFor(() => expect(branchSwitch).toHaveBeenCalledTimes(3));
        expect(branchSwitch.mock.calls[2]?.[0]).toBe(webId);
    });
});
