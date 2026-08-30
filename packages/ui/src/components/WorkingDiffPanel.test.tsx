// @vitest-environment jsdom
import {
    DiffFile,
    DiffLine,
    Hunk,
    HunkSelection,
    PatchSelection,
    RepoId,
} from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { WorkingDiffPanel } from './WorkingDiffPanel';

const repoId = RepoId.make('repo-1');

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi => ({
    repoOpen: vi.fn(async () => {
        throw new Error('not used');
    }),
    recentList: vi.fn(async () => []),
    recentRemove: vi.fn(async () => undefined),
    repoState: vi.fn(async () => {
        throw new Error('not used');
    }),
    commitDetail: vi.fn(async () => {
        throw new Error('not used');
    }),
    commitDiff: vi.fn(async () => []),
    workingFileDiff: vi.fn(async () => {
        throw new Error('not implemented');
    }),
    fileContentAtRev: vi.fn(async () => {
        throw new Error('not used');
    }),
    statusGet: vi.fn(async () => {
        throw new Error('not used');
    }),
    stageFiles: vi.fn(async () => undefined),
    unstageFiles: vi.fn(async () => undefined),
    discardFiles: vi.fn(async () => undefined),
    deleteUntracked: vi.fn(async () => undefined),
    resetTo: vi.fn(async () => undefined),
    stageHunks: vi.fn(async () => undefined),
    unstageHunks: vi.fn(async () => undefined),
    discardHunks: vi.fn(async () => undefined),
    commitCreate: vi.fn(async () => {
        throw new Error('not used');
    }),
    commitLastMessage: vi.fn(async () => {
        throw new Error('not used');
    }),
    logStream: vi.fn(() => () => undefined),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
});

const renderWithApi = (ui: ReactNode, api: CbranchApi) => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter>
            <QueryClientProvider client={queryClient}>
                <ApiProvider api={api}>{ui}</ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

const makeHunk = (): Hunk =>
    new Hunk({
        header: '@@ -1,3 +1,3 @@',
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
            new DiffLine({
                kind: 'context',
                content: 'ctx',
                oldLineNo: 1,
                newLineNo: 1,
            }),
            new DiffLine({ kind: 'delete', content: 'old line', oldLineNo: 2 }),
            new DiffLine({ kind: 'add', content: 'new line', newLineNo: 2 }),
        ],
    });

const makeDiffFile = (): DiffFile =>
    new DiffFile({
        oldPath: 'a.txt',
        newPath: 'a.txt',
        status: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 1,
        hunks: [makeHunk()],
    });

const makeAddedDiffFile = (lineCount = 3): DiffFile => {
    const lines = Array.from(
        { length: lineCount },
        (_, index) =>
            new DiffLine({
                kind: 'add',
                content: `new line ${index + 1}`,
                newLineNo: index + 1,
            }),
    );
    return new DiffFile({
        oldPath: 'new.txt',
        newPath: 'new.txt',
        status: 'added',
        isBinary: false,
        newMode: '100644',
        additions: lineCount,
        deletions: 0,
        hunks: [
            new Hunk({
                header: `@@ -0,0 +1,${lineCount} @@`,
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: lineCount,
                lines,
            }),
        ],
    });
};

beforeEach(() => {
    useUiStore.setState({ selectedDiffFile: null });
});
afterEach(() => cleanup());

describe('WorkingDiffPanel', () => {
    test('shows placeholder when no file is selected', () => {
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, makeFakeApi());
        expect(screen.getByText(/select a file/i)).toBeTruthy();
    });

    test('shows hunk header when diff loads', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
        expect(await screen.findByText('@@ -1,3 +1,3 @@')).toBeTruthy();
    });

    test('renders every line of a new file as an addition hunk', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeAddedDiffFile()),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'new.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);

        expect(await screen.findByText('@@ -0,0 +1,3 @@')).toBeTruthy();
        expect(screen.getByRole('button', { name: /new line 1/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /new line 2/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /new line 3/ })).toBeTruthy();
    });

    test('identifies an empty new file instead of showing no changes', async () => {
        const emptyFile = new DiffFile({
            oldPath: 'empty.txt',
            newPath: 'empty.txt',
            status: 'added',
            isBinary: false,
            newMode: '100644',
            additions: 0,
            deletions: 0,
            hunks: [],
        });
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => emptyFile),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'empty.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);

        expect(await screen.findByText(/empty new file/i)).toBeTruthy();
        expect(screen.queryByText('No changes.')).toBeNull();
    });

    test('defers a large new-file diff until explicitly loaded', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeAddedDiffFile(2001)),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'new.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);

        expect(await screen.findByText('Large diff deferred')).toBeTruthy();
        expect(screen.queryByText('@@ -0,0 +1,2001 @@')).toBeNull();

        await userEvent.click(
            screen.getByRole('button', { name: 'Load anyway' }),
        );
        expect(await screen.findByText('@@ -0,0 +1,2001 @@')).toBeTruthy();
    });

    test('requires load confirmation again after selecting another large file', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeAddedDiffFile(2001)),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'first.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);

        await screen.findByText('Large diff deferred');
        await userEvent.click(
            screen.getByRole('button', { name: 'Load anyway' }),
        );
        expect(await screen.findByText('@@ -0,0 +1,2001 @@')).toBeTruthy();

        act(() => {
            useUiStore.getState().setSelectedDiffFile({
                path: 'second.txt',
                staged: false,
            });
        });
        expect(await screen.findByText('Large diff deferred')).toBeTruthy();
        expect(screen.queryByText('@@ -0,0 +1,2001 @@')).toBeNull();
    });

    test('shows Stage Hunk button for worktree side (staged=false)', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
        expect(
            await screen.findByRole('button', { name: /stage hunk/i }),
        ).toBeTruthy();
        expect(
            await screen.findByRole('button', { name: /discard hunk/i }),
        ).toBeTruthy();
    });

    test('shows Unstage Hunk button for staged side (staged=true)', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: true },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
        expect(
            await screen.findByRole('button', { name: /unstage hunk/i }),
        ).toBeTruthy();
    });

    test('Stage Hunk button calls stageHunks with correct PatchSelection', async () => {
        const stageHunksFn = vi.fn(async () => undefined);
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
            stageHunks: stageHunksFn,
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
        const btn = await screen.findByRole('button', { name: /stage hunk/i });
        await userEvent.click(btn);
        await waitFor(() => expect(stageHunksFn).toHaveBeenCalledTimes(1));
        const called = stageHunksFn.mock.calls[0][0] as PatchSelection;
        expect(called.path).toBe('a.txt');
        expect(called.hunks).toHaveLength(1);
        expect(called.hunks[0]).toBeInstanceOf(HunkSelection);
        expect(called.hunks[0].oldStart).toBe(1);
        expect(called.hunks[0].selectedLines).toHaveLength(0);
    });

    test('selecting individual lines and Stage lines sends those line indices', async () => {
        const stageHunksFn = vi.fn(async () => undefined);
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
            stageHunks: stageHunksFn,
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);

        // Lines 1 (delete) and 2 (add) are the selectable +/- rows of the hunk.
        await userEvent.click(
            await screen.findByRole('button', { name: /old line/ }),
        );
        await userEvent.click(screen.getByRole('button', { name: /new line/ }));
        expect(screen.getByText('2 lines selected')).toBeTruthy();

        await userEvent.click(
            screen.getByRole('button', { name: 'Stage lines' }),
        );
        await waitFor(() => expect(stageHunksFn).toHaveBeenCalledTimes(1));
        const called = stageHunksFn.mock.calls[0][0] as PatchSelection;
        expect(called.hunks).toHaveLength(1);
        expect([...called.hunks[0].selectedLines]).toEqual([1, 2]);
    });

    test('Discard lines is gated behind a confirmation', async () => {
        const discardHunksFn = vi.fn(async () => undefined);
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
            discardHunks: discardHunksFn,
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);

        await userEvent.click(
            await screen.findByRole('button', { name: /new line/ }),
        );
        await userEvent.click(
            screen.getByRole('button', { name: 'Discard lines' }),
        );
        // Nothing runs until the destructive guard is confirmed.
        expect(discardHunksFn).not.toHaveBeenCalled();
        expect(await screen.findByText('Discard selected lines?')).toBeTruthy();
        const confirmBtns = screen.getAllByRole('button', {
            name: 'Discard lines',
        });
        await userEvent.click(confirmBtns[confirmBtns.length - 1]);
        await waitFor(() => expect(discardHunksFn).toHaveBeenCalledTimes(1));
        const sel = discardHunksFn.mock.calls[0][0] as PatchSelection;
        expect([...sel.hunks[0].selectedLines]).toEqual([2]);
    });

    test('toggling to staged side calls setSelectedDiffFile with staged=true', async () => {
        const api = makeFakeApi({
            workingFileDiff: vi.fn(async () => makeDiffFile()),
        });
        act(() => {
            useUiStore.setState({
                selectedDiffFile: { path: 'a.txt', staged: false },
            });
        });
        renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
        await screen.findByText('@@ -1,3 +1,3 @@');
        const stagedBtn = screen.getByRole('button', { name: /^staged$/i });
        await userEvent.click(stagedBtn);
        await waitFor(() => {
            const state = useUiStore.getState();
            expect(state.selectedDiffFile).toEqual({
                path: 'a.txt',
                staged: true,
            });
        });
    });
});
