// @vitest-environment jsdom
import { ArchiveDescriptor, GitError, RepoId } from '@cbranch/rpc-contract';
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
import { useUiStore } from '../state/store';
import { ArchiveDialog } from './ArchiveDialog';

const repoId = RepoId.make('archive-repo');

const descriptorFor = (treeish: string) =>
    new ArchiveDescriptor({
        url: `/sidechannel/archive?repoId=x&treeish=${treeish}&format=zip`,
        filename: `cbranch-${treeish}.zip`,
        contentType: 'application/zip',
        format: 'zip',
    });

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        archivePrepare: vi.fn(async (_id, opts: { treeish: string }) =>
            descriptorFor(opts.treeish),
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
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <ArchiveDialog />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

const openWith = (treeish: string) =>
    act(() => {
        useUiStore.setState({
            activeRepoId: repoId,
            archiveDialog: { treeish },
        });
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
    // jsdom lacks object-URL + a real fetch; stub both.
    URL.createObjectURL = vi.fn(() => 'blob:archive');
    URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(
        async () =>
            ({
                ok: true,
                blob: async () =>
                    new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])]),
            }) as unknown as Response,
    );
    useUiStore.setState({ activeRepoId: null, archiveDialog: null });
    vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('ArchiveDialog', () => {
    test('renders nothing when no archive dialog is open', () => {
        renderDialog(makeApi());
        expect(screen.queryByText('Export archive')).toBeNull();
    });

    test('opens pre-seeded with the launch tree-ish', async () => {
        renderDialog(makeApi());
        openWith('HEAD');
        expect(await screen.findByText('Export archive')).toBeTruthy();
        expect(
            (screen.getByLabelText('Tree-ish') as HTMLInputElement).value,
        ).toBe('HEAD');
        expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    });

    test('Export prepares, fetches, downloads, and reports the file name + size', async () => {
        const archivePrepare = vi.fn(async (_id, opts: { treeish: string }) =>
            descriptorFor(opts.treeish),
        );
        renderDialog(makeApi({ archivePrepare }));
        openWith('v1.0');
        await screen.findByText('Export archive');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Export' }));
        });

        await waitFor(() =>
            expect(archivePrepare).toHaveBeenCalledWith(
                repoId,
                expect.objectContaining({ treeish: 'v1.0', format: 'zip' }),
            ),
        );
        await waitFor(() =>
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/sidechannel/archive?repoId=x&treeish=v1.0&format=zip',
            ),
        );
        // 5-byte blob from the stubbed fetch.
        expect(
            await screen.findByText(/Exported cbranch-v1\.0\.zip \(5 bytes\)/),
        ).toBeTruthy();
    });

    test("an invalid tree-ish surfaces git's error inline and downloads nothing", async () => {
        const archivePrepare = vi.fn(async () => {
            throw new GitError({
                code: 'gitFailed',
                message: 'not a valid tree-ish: nope',
            });
        });
        renderDialog(makeApi({ archivePrepare }));
        openWith('nope');
        await screen.findByText('Export archive');

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Export' }));
        });

        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/not a valid tree-ish/i);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
