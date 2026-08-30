// @vitest-environment jsdom
import { CommitSummary, Oid, RepoId } from '@cbranch/rpc-contract';
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildLogQuery, emptyFilters } from '../lib/filters';
import { type CbranchApi, type StreamHandlers } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { GraphCell } from './GraphCell';
import { HistoryList } from './HistoryList';
import { RefChips } from './RefChips';

const repoId = RepoId.make('repo-1');
const defaultQuery = buildLogQuery(repoId, emptyFilters);
const oid = (hex: string) => Oid.make(hex.padEnd(40, '0'));

const summary = (id: string, parents: string[], refs: string[] = []) =>
    new CommitSummary({
        oid: oid(id),
        parents: parents.map(p => oid(p)),
        authorName: 'Ada',
        authorEmail: 'ada@example.test',
        authorDate: '2024-01-01T00:00:00Z',
        committerDate: '2024-01-01T00:00:00Z',
        subject: `commit ${id}`,
        refs,
    });

const fakeApi = (rows: ReadonlyArray<CommitSummary>): CbranchApi =>
    ({
        logStream: vi.fn(
            (_query: unknown, handlers: StreamHandlers<CommitSummary>) => {
                for (const row of rows) handlers.onItem(row);
                handlers.onComplete?.();
                return () => undefined;
            },
        ),
    }) as unknown as CbranchApi;

const renderWithApi = (ui: ReactNode, api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>{ui}</ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    // jsdom has no layout; @tanstack/react-virtual measures the scroll element via a
    // ResizeObserver + getBoundingClientRect, so give it a non-zero viewport to size against.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
            constructor(private readonly cb: ResizeObserverCallback) {}
            observe(element: Element) {
                this.cb(
                    [{ target: element } as ResizeObserverEntry],
                    this as unknown as ResizeObserver,
                );
            }
            unobserve() {}
            disconnect() {}
        };
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
    // @tanstack/react-virtual sizes the scroll element from offsetWidth/offsetHeight, which
    // are 0 in jsdom; give it a viewport so a window of rows materializes.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        configurable: true,
        value: 600,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
        configurable: true,
        value: 400,
    });
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (HTMLElement.prototype as Partial<HTMLElement>).offsetHeight;
    delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
});

describe('RefChips (P1-UI-HIST-4)', () => {
    test('renders a chip per ref and a HEAD marker on the current branch', () => {
        render(<RefChips refs={['HEAD -> main', 'tag: v1']} />);
        expect(screen.getByText('main')).toBeTruthy();
        expect(screen.getByText('v1')).toBeTruthy();
        expect(screen.getByText('HEAD')).toBeTruthy();
    });

    test('collapses overflow past the cap into an expandable +N (REQ-GRAPH-015)', () => {
        render(<RefChips refs={['a', 'b', 'c', 'd', 'e']} />);
        const more = screen.getByText('+2');
        expect(screen.queryByText('d')).toBeNull();
        fireEvent.click(more);
        expect(screen.getByText('d')).toBeTruthy();
        expect(screen.getByText('e')).toBeTruthy();
    });

    test('keeps tag borders and text visible on a selected commit row', () => {
        render(<RefChips refs={['tag: v1']} selected />);
        const tag = screen.getByTitle('tag: v1');
        expect(tag.classList.contains('border-selection-fg')).toBe(true);
        expect(tag.classList.contains('text-selection-fg')).toBe(true);
        expect(tag.classList.contains('group-hover:border-status-ahead')).toBe(
            true,
        );
        expect(tag.classList.contains('group-hover:text-status-ahead')).toBe(
            true,
        );
    });
});

describe('GraphCell (spec 10)', () => {
    test('draws the commit node and its edges as SVG', () => {
        const { container } = render(
            <GraphCell
                row={{
                    lane: 0,
                    color: 1,
                    laneCount: 1,
                    segments: [
                        {
                            fromLane: 0,
                            toLane: 0,
                            fromY: 0,
                            toY: 0.5,
                            color: 1,
                        },
                    ],
                }}
                columns={1}
                height={40}
                selected={false}
            />,
        );
        expect(container.querySelector('circle')).toBeTruthy();
        expect(container.querySelector('path')).toBeTruthy();
    });
});

describe('HistoryList (P1-HIST-1/2/3; spec 10)', () => {
    test('streams rows, renders the graph cell, and selects on click', async () => {
        const onSelect = vi.fn();
        const api = fakeApi([
            summary('a', ['b'], ['HEAD -> main']),
            summary('b', ['c']),
            summary('c', []),
        ]);
        const { container } = renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={null}
                onSelectOid={onSelect}
            />,
            api,
        );
        expect(await screen.findByText('commit a')).toBeTruthy();
        // One graph SVG per visible row, with the HEAD branch chip on the first.
        await waitFor(() =>
            expect(container.querySelectorAll('svg').length).toBeGreaterThan(0),
        );
        expect(screen.getByText('main')).toBeTruthy();
        act(() => fireEvent.click(screen.getByText('commit a')));
        expect(onSelect).toHaveBeenCalled();
    });

    test('keyboard navigation jumps to the last row on End (P1-HIST-6)', async () => {
        const onSelect = vi.fn();
        const api = fakeApi([
            summary('a', ['b']),
            summary('b', ['c']),
            summary('c', []),
        ]);
        renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={null}
                onSelectOid={onSelect}
            />,
            api,
        );
        expect(await screen.findByText('commit a')).toBeTruthy();
        act(() =>
            fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' }),
        );
        expect(onSelect).toHaveBeenCalledWith(oid('c'));
    });

    test('right-click opens a commit context menu instead of the browser default', async () => {
        const onSelect = vi.fn();
        const api = fakeApi([summary('a', ['b']), summary('b', [])]);
        renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={null}
                onSelectOid={onSelect}
            />,
            api,
        );
        const row = (await screen.findByText('commit a')).closest(
            '[role=option]',
        ) as HTMLElement;
        // fireEvent returns false when the handler called preventDefault — i.e. the browser's
        // own context menu is suppressed in favor of ours.
        let notCancelled = true;
        act(() => {
            notCancelled = fireEvent.contextMenu(row);
        });
        expect(notCancelled).toBe(false);
        expect(await screen.findByText('Copy to clipboard')).toBeTruthy();
        expect(screen.getByText('Cherry-pick this commit…')).toBeTruthy();
        expect(screen.getByText('Revert this commit…')).toBeTruthy();
        const mergeItem = screen
            .getByText('Merge into current branch…')
            .closest('[role="menuitem"]');
        expect(
            mergeItem?.querySelector('[data-slot="action-menu-icon"] svg'),
        ).toBeTruthy();
        const iconlessItem = screen
            .getByText('Reset another branch to here…')
            .closest('[role="menuitem"]');
        expect(
            iconlessItem?.querySelector('[data-slot="action-menu-icon"]'),
        ).toBeTruthy();
        expect(
            iconlessItem?.querySelector('[data-slot="action-menu-icon"] svg'),
        ).toBeNull();
        expect(onSelect).toHaveBeenCalledWith(oid('a'));
        const rebase = screen.getByText('Rebase current branch on');
        act(() => fireEvent.mouseMove(rebase));
        const interactive = await screen.findByText(
            'Selected commit interactively…',
        );
        fireEvent.click(interactive);
        expect(useUiStore.getState().rebaseDialog).toEqual({
            upstream: oid('a'),
            branch: null,
        });
    });

    test('selected commit context menu opens from keyboard and dismisses with Escape', async () => {
        const api = fakeApi([summary('a', ['b']), summary('b', [])]);
        renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={oid('a')}
                onSelectOid={vi.fn()}
            />,
            api,
        );
        await screen.findByText('commit a');
        const list = screen.getByRole('listbox');
        list.focus();
        act(() =>
            fireEvent.keyDown(list, {
                key: 'F10',
                code: 'F10',
                shiftKey: true,
            }),
        );
        const menu = await screen.findByRole('menu');
        expect(screen.getByText('Copy to clipboard')).toBeTruthy();
        act(() => fireEvent.keyDown(menu, { key: 'Escape' }));
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(document.activeElement).toBe(list);
    });

    // The Ctrl+F shortcut now rides the central keybinding dispatcher (covered in
    // hooks/use-keybindings.test.tsx); the find bar opens off the store findOpen flag.
    test('quick-find (opened via the store flag) selects the first match (P1-FILT-7)', async () => {
        const onSelect = vi.fn();
        const api = fakeApi([
            summary('a', ['b']),
            summary('b', ['c']),
            summary('c', []),
        ]);
        renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={null}
                onSelectOid={onSelect}
            />,
            api,
        );
        expect(await screen.findByText('commit a')).toBeTruthy();
        act(() => useUiStore.setState({ findOpen: true }));
        const input = screen.getByLabelText('Find in loaded history');
        act(() => fireEvent.change(input, { target: { value: 'commit c' } }));
        expect(onSelect).toHaveBeenCalledWith(oid('c'));
        expect(screen.getByText('1 / 1')).toBeTruthy();
    });

    test('go-to-commit selects the requested loaded row (REQ-P6-NAV-001)', async () => {
        const onSelect = vi.fn();
        const api = fakeApi([
            summary('a', ['b']),
            summary('b', ['c']),
            summary('c', []),
        ]);
        useUiStore.setState({ gotoRequest: null, logLimit: 500 });
        renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={null}
                onSelectOid={onSelect}
            />,
            api,
        );
        expect(await screen.findByText('commit a')).toBeTruthy();
        act(() => useUiStore.setState({ gotoRequest: { oid: oid('c') } }));
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(oid('c')));
        // The request is consumed once fulfilled.
        expect(useUiStore.getState().gotoRequest).toBeNull();
    });

    test('go-to-commit for an absent commit clears the request without selecting', async () => {
        const onSelect = vi.fn();
        const api = fakeApi([summary('a', ['b']), summary('b', [])]);
        useUiStore.setState({ gotoRequest: null, logLimit: 500 });
        renderWithApi(
            <HistoryList
                query={defaultQuery}
                dateMode="relative"
                filtersActive={false}
                selectedOid={null}
                onSelectOid={onSelect}
            />,
            api,
        );
        expect(await screen.findByText('commit a')).toBeTruthy();
        act(() => useUiStore.setState({ gotoRequest: { oid: oid('z') } }));
        // The stream is fully loaded (< limit) and the oid isn't present, so the request
        // is dropped and the selection is left unchanged.
        await waitFor(() =>
            expect(useUiStore.getState().gotoRequest).toBeNull(),
        );
        expect(onSelect).not.toHaveBeenCalled();
    });
});
