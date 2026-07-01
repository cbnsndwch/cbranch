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
