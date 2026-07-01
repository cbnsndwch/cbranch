// @vitest-environment jsdom
import { RepoId, StatusEntry, WorkingTreeStatus } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { StatusPanel } from './StatusPanel';

const repoId = RepoId.make('repo-1');

const makeEntry = (overrides: Partial<StatusEntry>): StatusEntry =>
    new StatusEntry({
        path: 'file.ts',
        staged: 'unmodified',
        unstaged: 'unmodified',
        isConflicted: false,
        isUntracked: false,
        isIgnored: false,
        isSubmodule: false,
        ...overrides,
    });

const emptyStatus = new WorkingTreeStatus({ entries: [], hasConflicts: false });

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        statusGet: vi.fn(async () => emptyStatus),
        stageFiles: vi.fn(async () => undefined),
        unstageFiles: vi.fn(async () => undefined),
        discardFiles: vi.fn(async () => undefined),
        deleteUntracked: vi.fn(async () => undefined),
        resetTo: vi.fn(async () => undefined),
        stageHunks: vi.fn(async () => undefined),
        unstageHunks: vi.fn(async () => undefined),
        discardHunks: vi.fn(async () => undefined),
        commitCreate: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        commitLastMessage: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        workingFileDiff: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        repoOpen: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        recentList: vi.fn(async () => []),
        recentRemove: vi.fn(async () => undefined),
        repoState: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        commitDetail: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        commitDiff: vi.fn(async () => []),
        fileContentAtRev: vi.fn(async () => {
            throw new Error('not implemented');
        }),
        logStream: vi.fn(() => () => undefined),
        subscribe: vi.fn(() => () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const renderPanel = (
    api: CbranchApi,
    ui: ReactNode = <StatusPanel repoId={repoId} />,
) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <ApiProvider api={api}>{ui}</ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

beforeEach(() => {
    useUiStore.setState({
        activeRepoId: null,
        stagedSelection: new Set(),
        unstagedSelection: new Set(),
        selectedDiffFile: null,
    });
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => cleanup());

describe('StatusPanel', () => {
    test('shows empty state when no changes', async () => {
        renderPanel(makeFakeApi({ statusGet: vi.fn(async () => emptyStatus) }));
        expect(
            await screen.findByText('No changes in working tree.'),
        ).toBeTruthy();
    });

    test('shows staged entry in Staged Changes section', async () => {
        const entry = makeEntry({
            path: 'src/foo.ts',
            staged: 'modified',
            unstaged: 'unmodified',
        });
        const status = new WorkingTreeStatus({
            entries: [entry],
            hasConflicts: false,
        });
        renderPanel(makeFakeApi({ statusGet: vi.fn(async () => status) }));
        expect(await screen.findByText('src/foo.ts')).toBeTruthy();
        expect(await screen.findByText('Staged Changes')).toBeTruthy();
    });

    test('shows untracked entry in Unstaged Changes section', async () => {
        const entry = makeEntry({
            path: 'new-file.ts',
            staged: 'unmodified',
            unstaged: 'unmodified',
            isUntracked: true,
        });
        const status = new WorkingTreeStatus({
            entries: [entry],
            hasConflicts: false,
        });
        renderPanel(makeFakeApi({ statusGet: vi.fn(async () => status) }));
        expect(await screen.findByText('new-file.ts')).toBeTruthy();
        expect(await screen.findByText('Unstaged Changes')).toBeTruthy();
    });

    test('Stage All button calls stageFiles with all:true', async () => {
        const unstaged = makeEntry({
            path: 'a.ts',
            staged: 'unmodified',
            unstaged: 'modified',
        });
        const status = new WorkingTreeStatus({
            entries: [unstaged],
            hasConflicts: false,
        });
        const stageFilesFn = vi.fn(async () => undefined);
        renderPanel(
            makeFakeApi({
                statusGet: vi.fn(async () => status),
                stageFiles: stageFilesFn,
            }),
        );

        await screen.findByText('Unstaged Changes');
        // "Stage All" button is in the unstaged toolbar
        const stageAllBtn = await screen.findByRole('button', {
            name: 'Stage All',
        });
        fireEvent.click(stageAllBtn);
        await waitFor(() =>
            expect(stageFilesFn).toHaveBeenCalledWith(repoId, [], true),
        );
    });

    test('per-file Discard opens confirmation and does not mutate until confirmed', async () => {
        const entry = makeEntry({
            path: 'tracked.ts',
            staged: 'unmodified',
            unstaged: 'modified',
        });
        const status = new WorkingTreeStatus({
            entries: [entry],
            hasConflicts: false,
        });
        const discardFn = vi.fn(async () => undefined);
        renderPanel(
            makeFakeApi({
                statusGet: vi.fn(async () => status),
                discardFiles: discardFn,
            }),
        );

        // The row's Discard button is revealed on hover but present in the DOM.
        const discardBtn = await screen.findByRole('button', {
            name: 'Discard',
        });
        fireEvent.click(discardBtn);

        // Confirmation names the exact path and states irreversibility; nothing ran yet.
        expect(
            await screen.findByText('Discard working-tree changes?'),
        ).toBeTruthy();
        // Path appears both in the row and enumerated in the dialog.
        expect(screen.getAllByText('tracked.ts').length).toBeGreaterThan(1);
        expect(screen.getByText(/irreversible/)).toBeTruthy();
        expect(discardFn).not.toHaveBeenCalled();

        // The confirm control (labeled "Discard") in the dialog fires the mutation.
        const confirmBtns = screen.getAllByRole('button', { name: 'Discard' });
        fireEvent.click(confirmBtns[confirmBtns.length - 1]);
        await waitFor(() =>
            expect(discardFn).toHaveBeenCalledWith(repoId, ['tracked.ts']),
        );
    });

    test('cancelling the discard confirmation leaves the working tree untouched', async () => {
        const entry = makeEntry({
            path: 'new.ts',
            staged: 'unmodified',
            unstaged: 'unmodified',
            isUntracked: true,
        });
        const status = new WorkingTreeStatus({
            entries: [entry],
            hasConflicts: false,
        });
        const deleteFn = vi.fn(async () => undefined);
        renderPanel(
            makeFakeApi({
                statusGet: vi.fn(async () => status),
                deleteUntracked: deleteFn,
            }),
        );

        const deleteBtn = await screen.findByRole('button', { name: 'Delete' });
        fireEvent.click(deleteBtn);
        expect(await screen.findByText('Delete untracked files?')).toBeTruthy();
        fireEvent.click(screen.getByText('Cancel'));
        await waitFor(() =>
            expect(screen.queryByText('Delete untracked files?')).toBeNull(),
        );
        expect(deleteFn).not.toHaveBeenCalled();
    });

    test('bulk Discard over a multi-selection uses one confirmation naming every path', async () => {
        const a = makeEntry({
            path: 'a.ts',
            staged: 'unmodified',
            unstaged: 'modified',
        });
        const b = makeEntry({
            path: 'b.ts',
            staged: 'unmodified',
            unstaged: 'modified',
        });
        const status = new WorkingTreeStatus({
            entries: [a, b],
            hasConflicts: false,
        });
        const discardFn = vi.fn(async () => undefined);
        renderPanel(
            makeFakeApi({
                statusGet: vi.fn(async () => status),
                discardFiles: discardFn,
            }),
        );

        await screen.findByText('Unstaged Changes');
        useUiStore.setState({ unstagedSelection: new Set(['a.ts', 'b.ts']) });

        const bulkBtn = await screen.findByRole('button', {
            name: 'Discard 2',
        });
        fireEvent.click(bulkBtn);

        // A single confirmation enumerates both paths.
        expect(
            await screen.findByText('Discard working-tree changes?'),
        ).toBeTruthy();
        const dialog = screen.getByText('Discard working-tree changes?')
            .parentElement!.parentElement!;
        expect(dialog.textContent).toContain('a.ts');
        expect(dialog.textContent).toContain('b.ts');

        const confirmBtns = screen.getAllByRole('button', { name: 'Discard' });
        fireEvent.click(confirmBtns[confirmBtns.length - 1]);
        await waitFor(() =>
            expect(discardFn).toHaveBeenCalledWith(repoId, ['a.ts', 'b.ts']),
        );
    });

    test('clicking a file row sets selectedDiffFile in the store', async () => {
        const entry = makeEntry({
            path: 'changed.ts',
            staged: 'unmodified',
            unstaged: 'modified',
        });
        const status = new WorkingTreeStatus({
            entries: [entry],
            hasConflicts: false,
        });
        renderPanel(makeFakeApi({ statusGet: vi.fn(async () => status) }));

        const fileBtn = await screen.findByRole('button', {
            name: /changed\.ts/,
        });
        fireEvent.click(fileBtn);

        const stored = useUiStore.getState().selectedDiffFile;
        expect(stored).toEqual({ path: 'changed.ts', staged: false });
    });
});
