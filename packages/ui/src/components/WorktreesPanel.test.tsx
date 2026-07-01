// @vitest-environment jsdom
import { RepoId } from '@cbranch/rpc-contract';
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
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { WorktreesPanel } from './WorktreesPanel';

const repoId = RepoId.make('repo-1');

const mainWt = {
    path: '/repos/project',
    headOid: 'a'.repeat(40),
    branch: 'refs/heads/main',
    isDetached: false,
    isMain: true,
    isBare: false,
    isLocked: false,
    lockReason: undefined,
    isPrunable: false,
    prunableReason: undefined,
};

const linkedWt = {
    path: '/repos/project-feature',
    headOid: 'b'.repeat(40),
    branch: 'refs/heads/feature',
    isDetached: false,
    isMain: false,
    isBare: false,
    isLocked: false,
    lockReason: undefined,
    isPrunable: false,
    prunableReason: undefined,
};

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        worktreeList: vi.fn(async () => [mainWt, linkedWt]),
        worktreeAdd: vi.fn(async () => linkedWt),
        worktreeRemove: vi.fn(async () => undefined),
        worktreePrune: vi.fn(async () => undefined),
        worktreeSwitch: vi.fn(async () => undefined),
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
                    <WorktreesPanel repoId={repoId} />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('WorktreesPanel', () => {
    test('lists worktrees with their path, branch, and kind badge (WT-001)', async () => {
        renderPanel(makeFakeApi());

        expect(await screen.findByText('/repos/project')).toBeTruthy();
        expect(screen.getByText('/repos/project-feature')).toBeTruthy();
        // Branch labels are stripped of the refs/heads/ prefix.
        expect(screen.getByText('feature')).toBeTruthy();
        // Kind badges distinguish the primary worktree from linked ones. "main"
        // appears twice (the kind badge and the branch label), so just the linked
        // badge is asserted uniquely.
        expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('linked')).toBeTruthy();
    });

    test('shows an empty state when there are no worktrees', async () => {
        renderPanel(makeFakeApi({ worktreeList: vi.fn(async () => []) }));
        expect(await screen.findByText('No worktrees found.')).toBeTruthy();
    });

    test('switching to a worktree calls worktreeSwitch with its path (WT-004)', async () => {
        const worktreeSwitch = vi.fn(async () => undefined);
        renderPanel(makeFakeApi({ worktreeSwitch }));

        await screen.findByText('/repos/project-feature');
        // The linked worktree's actions menu (index 1; index 0 is the main row).
        const triggers = screen.getAllByLabelText('Worktree actions');
        act(() => fireEvent.click(triggers[1]!));
        act(() => fireEvent.click(screen.getByText('Switch to this worktree')));

        await waitFor(() =>
            expect(worktreeSwitch).toHaveBeenCalledWith(repoId, linkedWt.path),
        );
    });

    test('Prune calls worktreePrune (WT-005)', async () => {
        const worktreePrune = vi.fn(async () => undefined);
        renderPanel(makeFakeApi({ worktreePrune }));

        await screen.findByText('/repos/project');
        act(() => fireEvent.click(screen.getByText('Prune')));

        await waitFor(() => expect(worktreePrune).toHaveBeenCalledWith(repoId));
    });

    test('adding a worktree submits the path and new branch (WT-002)', async () => {
        const worktreeAdd = vi.fn(async () => linkedWt);
        renderPanel(makeFakeApi({ worktreeAdd }));

        await screen.findByText('/repos/project');
        act(() => fireEvent.click(screen.getByText('+ Add')));

        const pathInput = await screen.findByPlaceholderText(
            '/path/to/new-worktree',
        );
        act(() =>
            fireEvent.change(pathInput, { target: { value: '/repos/new-wt' } }),
        );
        act(() =>
            fireEvent.change(screen.getByPlaceholderText('feat/my-feature'), {
                target: { value: 'feat/x' },
            }),
        );
        act(() => fireEvent.click(screen.getByRole('button', { name: 'Add' })));

        await waitFor(() =>
            expect(worktreeAdd).toHaveBeenCalledWith(
                repoId,
                '/repos/new-wt',
                expect.objectContaining({ newBranch: 'feat/x' }),
            ),
        );
    });

    test('removing a linked worktree confirms first, then calls worktreeRemove (WT-003)', async () => {
        const worktreeRemove = vi.fn(async () => undefined);
        renderPanel(makeFakeApi({ worktreeRemove }));

        await screen.findByText('/repos/project-feature');
        const triggers = screen.getAllByLabelText('Worktree actions');
        act(() => fireEvent.click(triggers[1]!));
        act(() => fireEvent.click(screen.getByText('Remove')));

        // A confirmation dialog gates the destructive removal.
        expect(await screen.findByText('Remove worktree')).toBeTruthy();
        expect(worktreeRemove).not.toHaveBeenCalled();

        act(() =>
            fireEvent.click(screen.getByRole('button', { name: 'Remove' })),
        );
        await waitFor(() =>
            expect(worktreeRemove).toHaveBeenCalledWith(
                repoId,
                linkedWt.path,
                undefined,
            ),
        );
    });

    test('the primary worktree offers no Remove action (WT-003)', async () => {
        renderPanel(makeFakeApi());

        await screen.findByText('/repos/project');
        const triggers = screen.getAllByLabelText('Worktree actions');
        // Open the MAIN row's menu (index 0) — it must not expose Remove.
        act(() => fireEvent.click(triggers[0]!));
        expect(screen.getByText('Switch to this worktree')).toBeTruthy();
        expect(screen.queryByText('Remove')).toBeNull();
    });
});
