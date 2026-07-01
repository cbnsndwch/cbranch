// @vitest-environment jsdom
import { RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { StashPanel } from './StashPanel';

const repoId = RepoId.make('repo-1');

const stashEntry = {
    ref: 'stash@{0}',
    index: 0,
    subject: 'WIP on main: feature',
    message: 'WIP on main: feature',
    branch: 'main',
};

const diffFile = {
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    status: 'modified',
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [
        {
            header: '@@ -1,1 +1,2 @@',
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: [
                { kind: 'context', content: 'const x = 1;' },
                { kind: 'add', content: 'const y = 2;' },
            ],
        },
    ],
};

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        stashList: vi.fn(async () => [stashEntry]),
        stashShow: vi.fn(async () => [diffFile]),
        stashApply: vi.fn(async () => undefined),
        stashPop: vi.fn(async () => undefined),
        stashDrop: vi.fn(async () => undefined),
        stashClear: vi.fn(async () => undefined),
        stashPush: vi.fn(async () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const renderPanel = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <ApiProvider api={api}>
                    <StashPanel repoId={repoId} />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('StashPanel diff preview (UI-010)', () => {
    test('no diff is shown until a stash is selected', async () => {
        const stashShow = vi.fn(async () => [diffFile]);
        renderPanel(makeFakeApi({ stashShow }));
        // The row renders…
        expect(await screen.findByText('WIP on main: feature')).toBeTruthy();
        // …but the preview query has not run and no diff line is shown.
        expect(stashShow).not.toHaveBeenCalled();
        expect(screen.queryByText('const y = 2;')).toBeNull();
    });

    test('selecting a stash renders its diff', async () => {
        const stashShow = vi.fn(async () => [diffFile]);
        renderPanel(makeFakeApi({ stashShow }));
        const row = await screen.findByText('WIP on main: feature');
        act(() => fireEvent.click(row));
        // The preview pane resolves the stash diff and renders the added line.
        expect(await screen.findByText('src/a.ts')).toBeTruthy();
        const added = await screen.findByText(/const y = 2;/);
        expect(added).toBeTruthy();
        expect(stashShow).toHaveBeenCalledWith(repoId, 'stash@{0}');
    });
});
