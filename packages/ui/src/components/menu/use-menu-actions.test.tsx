// @vitest-environment jsdom
import { type RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../../rpc/api';
import { ApiProvider } from '../../rpc/ApiProvider';
import { useUiStore } from '../../state/store';
import { useMenuActions } from './use-menu-actions';

// The capability layer reads recent repos + in-progress state through these hooks; stub
// them so the wiring (not the network) is under test. `inProgress` is mutable per test.
const EMPTY: never[] = [];
let inProgress = 'none';
vi.mock('../../rpc/hooks', () => ({
    useRecentList: () => ({ data: EMPTY }),
    useRepoState: () => ({ data: { inProgress } }),
}));

const fakeApi = {} as unknown as CbranchApi;
const REPO = 'repo-1' as RepoId;

const wrapper = ({ children }: { children: ReactNode }) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return (
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <ApiProvider api={fakeApi}>{children}</ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>
    );
};

beforeEach(() => {
    inProgress = 'none';
    useUiStore.setState({
        activeRepoId: null,
        activeView: 'history',
        selectedOid: null,
        branchCreate: null,
        tagCreateOpen: false,
        remotesDialogOpen: false,
        syncRequest: null,
        findOpen: false,
    });
});
afterEach(() => vi.clearAllMocks());

describe('useMenuActions wiring (menu reconciliation)', () => {
    test('repo-scoped commands grey out with no repo, light up with one', () => {
        const { result, rerender } = renderHook(() => useMenuActions(), {
            wrapper,
        });

        // No repo: repo-scoped commands disabled, but app-wide history nav still works.
        expect(result.current.isEnabled('commands.createBranch')).toBe(false);
        expect(result.current.isEnabled('repository.worktrees')).toBe(false);
        expect(result.current.isEnabled('navigate.back')).toBe(true);
        expect(result.current.isEnabled('navigate.forward')).toBe(true);

        act(() => useUiStore.setState({ activeRepoId: REPO }));
        rerender();

        for (const id of [
            'commands.createBranch',
            'commands.deleteBranch',
            'commands.checkoutBranch',
            'commands.merge',
            'commands.checkoutRevision',
            'repository.remotes',
            'commands.createTag',
            'commands.deleteTag',
            'commands.pull',
            'commands.push',
            'commands.stashes',
            'repository.worktrees',
            'navigate.quickSearch',
            'repository.maintenance.recover',
        ]) {
            expect(result.current.isEnabled(id)).toBe(true);
        }
    });

    test('createBranch shows the branches view and opens the lifted create dialog', () => {
        act(() => useUiStore.setState({ activeRepoId: REPO }));
        const { result } = renderHook(() => useMenuActions(), { wrapper });

        act(() => result.current.run('commands.createBranch'));

        expect(useUiStore.getState().activeView).toBe('branches');
        expect(useUiStore.getState().branchCreate).toEqual({
            startPoint: 'HEAD',
        });
    });

    test('createTag shows the tags view and opens the lifted create dialog', () => {
        act(() => useUiStore.setState({ activeRepoId: REPO }));
        const { result } = renderHook(() => useMenuActions(), { wrapper });

        act(() => result.current.run('commands.createTag'));

        expect(useUiStore.getState().activeView).toBe('tags');
        expect(useUiStore.getState().tagCreateOpen).toBe(true);
    });

    test('remotes shows the branches view and opens the remotes manager', () => {
        act(() => useUiStore.setState({ activeRepoId: REPO }));
        const { result } = renderHook(() => useMenuActions(), { wrapper });

        act(() => result.current.run('repository.remotes'));

        expect(useUiStore.getState().activeView).toBe('branches');
        expect(useUiStore.getState().remotesDialogOpen).toBe(true);
    });

    test('pull/push set a one-shot sync request consumed by the toolbar', () => {
        act(() => useUiStore.setState({ activeRepoId: REPO }));
        const { result } = renderHook(() => useMenuActions(), { wrapper });

        act(() => result.current.run('commands.pull'));
        expect(useUiStore.getState().syncRequest).toBe('pull');

        act(() => result.current.run('commands.push'));
        expect(useUiStore.getState().syncRequest).toBe('push');
    });

    test('row-based branch actions route to the branches view', () => {
        act(() => useUiStore.setState({ activeRepoId: REPO }));
        const { result } = renderHook(() => useMenuActions(), { wrapper });

        act(() => result.current.run('commands.merge'));
        expect(useUiStore.getState().activeView).toBe('branches');
    });

    test('solve-conflicts is gated on an in-progress operation', () => {
        act(() => useUiStore.setState({ activeRepoId: REPO }));
        const { result, rerender } = renderHook(() => useMenuActions(), {
            wrapper,
        });

        expect(result.current.isEnabled('commands.solveConflicts')).toBe(false);

        inProgress = 'merge';
        rerender();

        expect(result.current.isEnabled('commands.solveConflicts')).toBe(true);
        act(() => result.current.run('commands.solveConflicts'));
        expect(useUiStore.getState().activeView).toBe('solveConflicts');
    });
});
