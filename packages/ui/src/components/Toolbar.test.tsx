// @vitest-environment jsdom
import {
    BranchInfo,
    BranchListing,
    BranchUpstream,
    Oid,
    RepoId,
    RepoState,
} from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    act,
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
import { Toolbar } from './Toolbar';

const repoId = RepoId.make('repo-1');
const oid = (hex: string) => Oid.make(hex.padEnd(40, '0'));

const repoState = new RepoState({
    currentBranch: 'main',
    isDetached: false,
    inProgress: 'none',
    isBare: false,
    isEmpty: false,
    repoRoot: '/work/repo',
    gitDir: '/work/repo/.git',
});

const listing = new BranchListing({
    localBranches: [
        new BranchInfo({
            name: 'main',
            fullRef: 'refs/heads/main',
            tipOid: oid('a'),
            tipSubject: 'tip',
            isCurrent: true,
            isRemote: false,
            upstream: new BranchUpstream({
                ref: 'refs/remotes/origin/main',
                name: 'origin/main',
                ahead: 2,
                behind: 1,
            }),
        }),
    ],
    remoteBranches: [],
    currentBranch: 'main',
});

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        repoState: vi.fn(async () => repoState),
        remoteList: vi.fn(async () => [
            { name: 'origin', fetchUrl: 'git@example:repo.git' },
        ]),
        branchList: vi.fn(async () => listing),
        statusGet: vi.fn(async () => ({ entries: [], hasConflicts: false })),
        fetchStream: vi.fn(() => () => undefined),
        pullStream: vi.fn(() => () => undefined),
        pushStream: vi.fn(() => () => undefined),
        subscribe: vi.fn(() => () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const renderToolbar = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <ApiProvider api={api}>
                    <Toolbar />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

beforeEach(() => {
    // The toolbar reads the active repo from the Zustand store, not props.
    useUiStore.getState().setActiveRepoId(repoId);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useUiStore.getState().setActiveRepoId(null);
});

describe('Toolbar (D7 / UI-005 / UI-006)', () => {
    test('renders the current branch ahead/behind divergence', async () => {
        renderToolbar(makeFakeApi());
        expect(await screen.findByText('↑2')).toBeTruthy();
        expect(await screen.findByText('↓1')).toBeTruthy();
    });

    test('Fetch option dropdown calls fetchStream with the chosen opts', async () => {
        const fetchStream = vi.fn(() => () => undefined);
        renderToolbar(makeFakeApi({ fetchStream }));
        act(() => fireEvent.click(screen.getByLabelText('Fetch options')));
        const item = await screen.findByText('Fetch and prune');
        act(() => fireEvent.click(item));
        await waitFor(() =>
            expect(fetchStream).toHaveBeenCalledWith(
                repoId,
                { prune: true },
                expect.anything(),
            ),
        );
    });

    test('Push option dropdown calls pushStream with set-upstream', async () => {
        const pushStream = vi.fn(() => () => undefined);
        renderToolbar(makeFakeApi({ pushStream }));
        act(() => fireEvent.click(screen.getByLabelText('Push options')));
        const item = await screen.findByText('Push and set upstream');
        act(() => fireEvent.click(item));
        await waitFor(() =>
            expect(pushStream).toHaveBeenCalledWith(
                repoId,
                'origin',
                { setUpstream: true },
                expect.anything(),
            ),
        );
    });

    test('Pull option dropdown calls pullStream with the chosen mode', async () => {
        const pullStream = vi.fn(() => () => undefined);
        renderToolbar(makeFakeApi({ pullStream }));
        act(() =>
            fireEvent.click(screen.getByLabelText('Pull (ff-only) options')),
        );
        const item = await screen.findByText('Pull (rebase)');
        act(() => fireEvent.click(item));
        await waitFor(() =>
            expect(pullStream).toHaveBeenCalledWith(
                repoId,
                'rebase',
                {},
                expect.anything(),
            ),
        );
    });

    test('Cancel surfaces during an in-flight sync and unsubscribes', async () => {
        const unsub = vi.fn();
        // A fetch that never completes keeps the sync in flight, so Cancel stays visible.
        const fetchStream = vi.fn(() => unsub);
        renderToolbar(makeFakeApi({ fetchStream }));
        // No Cancel button before a sync starts.
        expect(screen.queryByLabelText('Cancel sync')).toBeNull();
        act(() => fireEvent.click(screen.getByLabelText('Fetch')));
        const cancel = await screen.findByLabelText('Cancel sync');
        act(() => fireEvent.click(cancel));
        expect(unsub).toHaveBeenCalledTimes(1);
        await waitFor(() =>
            expect(screen.queryByLabelText('Cancel sync')).toBeNull(),
        );
    });
});

describe('Toolbar non-fast-forward push retry (UI-007)', () => {
    const NON_FF = { code: 'nonFastForward' };

    test('a non-fast-forward rejection opens the retry dialog', async () => {
        const pushStream = vi.fn((_r, _rem, _opts, h) => {
            h.onError(NON_FF);
            return () => undefined;
        });
        renderToolbar(makeFakeApi({ pushStream }));
        act(() => fireEvent.click(screen.getByLabelText('Push')));
        expect(
            await screen.findByText('Push rejected — non-fast-forward'),
        ).toBeTruthy();
    });

    test('a generic push failure keeps the toast and shows no dialog', async () => {
        const pushStream = vi.fn((_r, _rem, _opts, h) => {
            h.onError(new Error('connection reset'));
            return () => undefined;
        });
        renderToolbar(makeFakeApi({ pushStream }));
        act(() => fireEvent.click(screen.getByLabelText('Push')));
        await waitFor(() => expect(pushStream).toHaveBeenCalledTimes(1));
        expect(
            screen.queryByText('Push rejected — non-fast-forward'),
        ).toBeNull();
    });

    test('choosing a retry pulls with that mode, then replays the original push', async () => {
        let pushCalls = 0;
        // First push is rejected non-ff; after a clean pull the identical push retries
        // and succeeds. The push is set-upstream so we can assert the opts are replayed.
        const pushStream = vi.fn((_r, _rem, _opts, h) => {
            pushCalls += 1;
            if (pushCalls === 1) h.onError(NON_FF);
            else h.onComplete();
            return () => undefined;
        });
        const pullStream = vi.fn((_r, _mode, _opts, h) => {
            h.onComplete();
            return () => undefined;
        });
        renderToolbar(makeFakeApi({ pushStream, pullStream }));

        // Use the set-upstream variant so the replayed opts are observable.
        act(() => fireEvent.click(screen.getByLabelText('Push options')));
        const setUpstreamItem = await screen.findByText(
            'Push and set upstream',
        );
        act(() => fireEvent.click(setUpstreamItem));

        const retryItem = await screen.findByText('Pull (rebase) & retry');
        act(() => fireEvent.click(retryItem));

        await waitFor(() =>
            expect(pullStream).toHaveBeenCalledWith(
                repoId,
                'rebase',
                {},
                expect.anything(),
            ),
        );
        // Two push attempts: the rejected original and the post-pull retry, both with
        // the same set-upstream opts.
        expect(pushStream).toHaveBeenCalledTimes(2);
        expect(pushStream).toHaveBeenLastCalledWith(
            repoId,
            'origin',
            { setUpstream: true },
            expect.anything(),
        );
    });
});
