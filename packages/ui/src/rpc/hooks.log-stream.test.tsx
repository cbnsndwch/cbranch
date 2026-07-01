// @vitest-environment jsdom
import {
    CommitCreated,
    CommitSummary,
    LogQuery,
    Oid,
    RepoId,
} from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useUiStore } from '../state/store';
import { type CbranchApi } from './api';
import { ApiProvider } from './ApiProvider';
import { useCommitCreate, useLogStream } from './hooks';

const repoId = RepoId.make('repo-1');
const query = new LogQuery({ repoId, limit: 50, refScope: 'current' });
const oidA = Oid.make('a'.repeat(40));
const oidB = Oid.make('b'.repeat(40));

const summary = (oid: Oid, over: Partial<CommitSummary> = {}): CommitSummary =>
    new CommitSummary({
        oid,
        parents: [],
        authorName: '',
        authorEmail: '',
        authorDate: '2026-01-01T00:00:00Z',
        committerDate: '2026-01-01T00:00:00Z',
        subject: 'real',
        refs: [],
        ...over,
    });

const draft = {
    repoId,
    subject: 'x',
    amend: false,
    signoff: false,
    allowEmpty: false,
    noVerify: false,
} as const;

// The store is a global singleton; clear the optimistic channel between tests, and
// unmount hooks so a prior test's still-subscribed stream can't prune this test's state.
beforeEach(() => {
    useUiStore.setState({ optimisticCommits: [] });
});
afterEach(() => {
    cleanup();
});

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        // Each subscription immediately completes with no rows; we only count subscriptions.
        logStream: vi.fn((_q, h) => {
            h.onComplete();
            return () => undefined;
        }),
        commitCreate: vi.fn(
            async () =>
                new CommitCreated({
                    oid: Oid.make('a'.repeat(40)),
                    shortOid: 'aaaaaaa',
                    subject: 'x',
                }),
        ),
        subscribe: vi.fn(() => () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const makeWrapper = (api: CbranchApi) => {
    // One shared client so the commit mutation's invalidation reaches the log sentinel.
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>{children}</ApiProvider>
        </QueryClientProvider>
    );
};

describe('useLogStream refresh-on-commit (commits-domain bridge)', () => {
    test('subscribes once on mount', async () => {
        const api = makeFakeApi();
        renderHook(() => useLogStream(query), { wrapper: makeWrapper(api) });
        await waitFor(() =>
            expect(
                (api.logStream as ReturnType<typeof vi.fn>).mock.calls.length,
            ).toBe(1),
        );
    });

    test('re-subscribes when a commit invalidates the commits domain', async () => {
        const api = makeFakeApi();
        const { result } = renderHook(
            () => ({
                log: useLogStream(query),
                commit: useCommitCreate(repoId),
            }),
            { wrapper: makeWrapper(api) },
        );
        const logStream = api.logStream as ReturnType<typeof vi.fn>;
        await waitFor(() => expect(logStream.mock.calls.length).toBe(1));

        await act(async () => {
            result.current.commit.mutate({
                repoId,
                subject: 'new commit',
                amend: false,
                signoff: false,
                allowEmpty: false,
                noVerify: false,
            });
        });

        // The commit invalidates [repoId, "commits"]; the log sentinel refetches and the
        // stream restarts to re-snapshot the new history.
        await waitFor(() => expect(logStream.mock.calls.length).toBe(2));
    });
});

describe('useLogStream optimistic commit prepend', () => {
    test('shows a fresh commit at the top before the stream catches up', async () => {
        // The stream never emits the new commit, so the optimistic row persists.
        const api = makeFakeApi();
        const { result } = renderHook(
            () => ({
                log: useLogStream(query),
                commit: useCommitCreate(repoId),
            }),
            { wrapper: makeWrapper(api) },
        );
        await waitFor(() => expect(result.current.log.rows).toHaveLength(0));

        await act(async () => {
            result.current.commit.mutate(draft);
        });

        await waitFor(() => expect(result.current.log.rows).toHaveLength(1));
        expect(result.current.log.rows[0]!.oid).toBe(oidA);
        expect(result.current.log.rows[0]!.subject).toBe('x');
    });

    test('reconciles the optimistic row once the stream confirms the real one', async () => {
        let subs = 0;
        const api = makeFakeApi({
            // The first snapshot has no commits; the post-commit restart emits the real row.
            logStream: vi.fn((_q, h) => {
                subs += 1;
                if (subs >= 2) h.onItem(summary(oidA, { subject: 'real' }));
                h.onComplete();
                return () => undefined;
            }),
        });
        const { result } = renderHook(
            () => ({
                log: useLogStream(query),
                commit: useCommitCreate(repoId),
            }),
            { wrapper: makeWrapper(api) },
        );
        await waitFor(() => expect(subs).toBe(1));

        await act(async () => {
            result.current.commit.mutate(draft);
        });

        // Exactly one row remains — the streamed real commit — and the channel is drained.
        await waitFor(() => expect(subs).toBe(2));
        await waitFor(() => {
            expect(result.current.log.rows).toHaveLength(1);
            expect(result.current.log.rows[0]!.subject).toBe('real');
        });
        expect(useUiStore.getState().optimisticCommits).toEqual([]);
    });

    test('does not prepend for an amend (HEAD is rewritten, not added)', async () => {
        const api = makeFakeApi();
        const { result } = renderHook(
            () => ({
                log: useLogStream(query),
                commit: useCommitCreate(repoId),
            }),
            { wrapper: makeWrapper(api) },
        );
        await waitFor(() => expect(result.current.log.rows).toHaveLength(0));

        await act(async () => {
            result.current.commit.mutate({ ...draft, amend: true });
        });

        await waitFor(() =>
            expect(useUiStore.getState().optimisticCommits).toEqual([]),
        );
        expect(result.current.log.rows).toHaveLength(0);
    });

    test('borrows the author from the current top row for the synthesized row', async () => {
        const api = makeFakeApi({
            logStream: vi.fn((_q, h) => {
                h.onItem(
                    summary(oidB, { authorName: 'Ada', authorEmail: 'ada@x' }),
                );
                h.onComplete();
                return () => undefined;
            }),
        });
        const { result } = renderHook(() => useLogStream(query), {
            wrapper: makeWrapper(api),
        });
        await waitFor(() => expect(result.current.rows).toHaveLength(1));

        // Synthesized rows carry no author (the client doesn't know the git identity).
        act(() => {
            useUiStore
                .getState()
                .addOptimisticCommit(summary(oidA, { subject: 'x' }));
        });

        await waitFor(() => expect(result.current.rows).toHaveLength(2));
        expect(result.current.rows[0]!.oid).toBe(oidA);
        expect(result.current.rows[0]!.authorName).toBe('Ada');
    });
});
