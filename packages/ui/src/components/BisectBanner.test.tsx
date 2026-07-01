// @vitest-environment jsdom
import {
    BisectStatus,
    CommitSummary,
    Oid,
    RepoId,
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { BisectBanner } from './BisectBanner';

vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const repoId = RepoId.make('bisect-repo');
const mid = Oid.make('c'.repeat(40));
const firstBad = Oid.make('d'.repeat(40));

const summary = (oid: Oid, subject: string) =>
    new CommitSummary({
        oid,
        parents: [],
        authorName: 'A',
        authorEmail: 'a@x',
        authorDate: '2023-11-14T22:13:20-05:00',
        committerDate: '2023-11-14T22:13:20-05:00',
        subject,
        refs: [],
    });

const bisecting = new BisectStatus({
    state: 'bisecting',
    current: summary(mid, 'midpoint'),
    badTerm: 'bad',
    goodTerm: 'good',
    revisionsRemaining: 3,
    stepsRemaining: 2,
});
const concluded = new BisectStatus({
    state: 'concluded',
    firstBad: summary(firstBad, 'the regression'),
    badTerm: 'bad',
    goodTerm: 'good',
});

const onSelectOid = vi.fn();

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        bisectStatus: vi.fn(async () => bisecting),
        bisectMark: vi.fn(async () => bisecting),
        bisectReset: vi.fn(async () => undefined),
        recentList: vi.fn(async () => []),
        subscribe: vi.fn(() => () => undefined),
        logStream: vi.fn(() => () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const renderBanner = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <BisectBanner repoId={repoId} onSelectOid={onSelectOid} />
            </ApiProvider>
        </QueryClientProvider>,
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
    vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('BisectBanner', () => {
    test('renders nothing when no session is active', async () => {
        renderBanner(
            makeApi({
                bisectStatus: vi.fn(
                    async () =>
                        new BisectStatus({
                            state: 'inactive',
                            badTerm: 'bad',
                            goodTerm: 'good',
                        }),
                ),
            }),
        );
        await waitFor(() => expect(screen.queryByText('Bisecting')).toBeNull());
    });

    test('while bisecting shows the detached-HEAD warning, current commit, and counts', async () => {
        renderBanner(makeApi());
        expect(await screen.findByText('Bisecting')).toBeTruthy();
        expect(screen.getByText(/detached HEAD/i)).toBeTruthy();
        expect(screen.getByText(/midpoint/)).toBeTruthy();
        expect(screen.getByText(/3 revisions/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Good' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Bad' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
    });

    test('while seeding (no revision estimate) HEAD is not detached and a seeding hint shows', async () => {
        const seeding = new BisectStatus({
            state: 'bisecting',
            current: summary(mid, 'midpoint'),
            badTerm: 'bad',
            goodTerm: 'good',
        });
        renderBanner(makeApi({ bisectStatus: vi.fn(async () => seeding) }));
        expect(await screen.findByText('Bisecting')).toBeTruthy();
        // A bare start hasn't detached HEAD yet — no detached-HEAD warning.
        expect(screen.queryByText(/detached HEAD/i)).toBeNull();
        // The seeding hint replaces the (misleading) revision-under-test line.
        expect(screen.getByText(/seeding/i)).toBeTruthy();
        expect(screen.queryByText(/midpoint/)).toBeNull();
        // The good/bad/skip controls remain so the user can seed the session.
        expect(screen.getByRole('button', { name: 'Good' })).toBeTruthy();
    });

    test('marking advances and navigates the graph to the next revision', async () => {
        const next = new BisectStatus({
            state: 'bisecting',
            current: summary(Oid.make('e'.repeat(40)), 'next-rev'),
            badTerm: 'bad',
            goodTerm: 'good',
        });
        const bisectMark = vi.fn(async () => next);
        renderBanner(makeApi({ bisectMark }));
        await screen.findByText('Bisecting');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Bad' }));
        });

        await waitFor(() =>
            expect(bisectMark).toHaveBeenCalledWith(repoId, 'bad'),
        );
        await waitFor(() =>
            expect(onSelectOid).toHaveBeenCalledWith(Oid.make('e'.repeat(40))),
        );
    });

    test('on conclusion shows the first bad commit + View commit navigates to it', async () => {
        renderBanner(makeApi({ bisectStatus: vi.fn(async () => concluded) }));
        expect(await screen.findByText('First bad commit:')).toBeTruthy();
        expect(screen.getByText(/the regression/)).toBeTruthy();
        act(() =>
            fireEvent.click(
                screen.getByRole('button', { name: 'View commit' }),
            ),
        );
        expect(onSelectOid).toHaveBeenCalledWith(firstBad);
    });

    test('Reset is confirmation-gated', async () => {
        const bisectReset = vi.fn(async () => undefined);
        renderBanner(makeApi({ bisectReset }));
        await screen.findByText('Bisecting');
        act(() =>
            fireEvent.click(screen.getByRole('button', { name: 'Reset' })),
        );
        expect(bisectReset).not.toHaveBeenCalled();
        const confirm = await screen.findByText('Reset bisect');
        await act(async () => fireEvent.click(confirm));
        await waitFor(() => expect(bisectReset).toHaveBeenCalled());
    });
});
