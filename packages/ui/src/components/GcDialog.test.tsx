// @vitest-environment jsdom
import {
    GcResult,
    GitError,
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { toast } from 'sonner';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { GcDialog } from './GcDialog';

vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const repoId = RepoId.make('gc-repo');
const oid = Oid.make('a'.repeat(40));

const stateWith = (inProgress: RepoState['inProgress'] = 'none'): RepoState =>
    new RepoState({
        headOid: oid,
        currentBranch: 'main',
        isDetached: false,
        inProgress,
        isBare: false,
        isEmpty: false,
        repoRoot: '/repo',
        gitDir: '/repo/.git',
        defaultBranch: 'main',
    });

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        repoState: vi.fn(async () => stateWith('none')),
        gc: vi.fn(
            async () =>
                new GcResult({
                    stdout: 'Counting objects: 5, done.\n',
                    stderr: '',
                }),
        ),
        recentList: vi.fn(async () => []),
        subscribe: vi.fn(() => () => undefined),
        logStream: vi.fn(() => () => undefined),
        ...overrides,
    }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const utils = render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <GcDialog />
            </ApiProvider>
        </QueryClientProvider>,
    );
    return { ...utils, qc, invalidate };
};

const openDialog = () =>
    act(() => {
        useUiStore.setState({ activeRepoId: repoId, gcDialogOpen: true });
    });

beforeEach(() => {
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    useUiStore.setState({ activeRepoId: null, gcDialogOpen: false });
    vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('GcDialog', () => {
    test('renders nothing when closed', () => {
        renderDialog(makeApi());
        expect(screen.queryByText('Run maintenance (gc)')).toBeNull();
    });

    test('open shows the aggressive checkbox, prune control and Run button', async () => {
        renderDialog(makeApi());
        openDialog();
        expect(await screen.findByText('Run maintenance (gc)')).toBeTruthy();
        expect(screen.getByLabelText('Aggressive')).toBeTruthy();
        expect(screen.getByText('Prune')).toBeTruthy();
        expect(
            screen.getByRole('button', { name: 'Run maintenance' }),
        ).toBeTruthy();
    });

    test('no mid-op warning when the repo is idle', async () => {
        renderDialog(makeApi());
        openDialog();
        await screen.findByText('Run maintenance (gc)');
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    test('mid-operation state surfaces a warn-only alert (not a block)', async () => {
        renderDialog(
            makeApi({ repoState: vi.fn(async () => stateWith('rebase')) }),
        );
        openDialog();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/in progress/i);
        // Warn-only: the Run button stays enabled.
        expect(
            (
                screen.getByRole('button', {
                    name: 'Run maintenance',
                }) as HTMLButtonElement
            ).disabled,
        ).toBe(false);
    });

    test('Run sends the selected options, shows captured output, toasts, invalidates', async () => {
        const gc = vi.fn(
            async () =>
                new GcResult({
                    stdout: 'Counting objects: 5, done.\n',
                    stderr: '',
                }),
        );
        const { invalidate } = renderDialog(makeApi({ gc }));
        openDialog();
        await screen.findByText('Run maintenance (gc)');

        await act(async () => {
            fireEvent.click(screen.getByLabelText('Aggressive'));
        });
        await act(async () => {
            fireEvent.click(
                screen.getByRole('button', { name: 'Run maintenance' }),
            );
        });

        await waitFor(() =>
            expect(gc).toHaveBeenCalledWith(repoId, {
                aggressive: true,
                prune: 'default',
            }),
        );
        // Captured output is shown for display (REQ-P5-GC-003).
        expect(
            await screen.findByText(/Counting objects: 5, done\./),
        ).toBeTruthy();
        expect(toast.success).toHaveBeenCalled();
        // REQ-P5-GC-004: explicit refs + commits invalidation.
        await waitFor(() => {
            expect(invalidate).toHaveBeenCalledWith({
                queryKey: [repoId, 'refs'],
            });
            expect(invalidate).toHaveBeenCalledWith({
                queryKey: [repoId, 'commits'],
            });
        });
    });

    test('a gitFailed surfaces inline with no output pane', async () => {
        const gc = vi.fn(async () => {
            throw new GitError({
                code: 'gitFailed',
                message: 'gc exited with code 1',
            });
        });
        renderDialog(makeApi({ gc }));
        openDialog();
        await screen.findByText('Run maintenance (gc)');

        await act(async () => {
            fireEvent.click(
                screen.getByRole('button', { name: 'Run maintenance' }),
            );
        });

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/gc exited/i);
    });

    test('while running, the dialog is non-dismissable (Cancel + Run disabled)', async () => {
        const gc = vi.fn(() => new Promise<GcResult>(() => undefined));
        renderDialog(makeApi({ gc }));
        openDialog();
        await screen.findByText('Run maintenance (gc)');

        await act(async () => {
            fireEvent.click(
                screen.getByRole('button', { name: 'Run maintenance' }),
            );
        });

        await waitFor(() => {
            expect(
                (
                    screen.getByRole('button', {
                        name: 'Running…',
                    }) as HTMLButtonElement
                ).disabled,
            ).toBe(true);
            expect(
                (
                    screen.getByRole('button', {
                        name: 'Cancel',
                    }) as HTMLButtonElement
                ).disabled,
            ).toBe(true);
        });
        expect(useUiStore.getState().gcDialogOpen).toBe(true);
    });
});
