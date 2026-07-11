// @vitest-environment jsdom
import {
    FilesystemDirectoryListing,
    FilesystemRoot,
    RepoId,
    RepoInitResult,
} from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { NewRepoDialog } from './NewRepoDialog';

const repoId = RepoId.make('r1');
const listing = new FilesystemDirectoryListing({
    path: '/tmp',
    parent: null,
    breadcrumbs: [],
    roots: [new FilesystemRoot({ label: 'Temporary', path: '/tmp' })],
    entries: [],
    truncated: false,
});

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        repoInit: vi.fn(async () => new RepoInitResult({ repoId })),
        repoOpen: vi.fn(async () => {
            throw new Error('not used');
        }),
        recentList: vi.fn(async () => []),
        filesystemListDir: vi.fn(async () => listing),
        ...over,
    }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <MemoryRouter>
            <QueryClientProvider client={qc}>
                <ApiProvider api={api}>
                    <NewRepoDialog />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

beforeEach(() => {
    useUiStore.setState({ newRepoDialogOpen: true });
});
afterEach(() => cleanup());

describe('NewRepoDialog', () => {
    test('creating passes the path, initial branch, and bare flag to repo.init', async () => {
        const initFn = vi.fn(async () => new RepoInitResult({ repoId }));
        renderDialog(makeApi({ repoInit: initFn }));

        fireEvent.change(await screen.findByLabelText('Destination path'), {
            target: { value: '/tmp/new' },
        });
        fireEvent.change(screen.getByLabelText('Initial branch'), {
            target: { value: 'trunk' },
        });
        fireEvent.click(screen.getByLabelText('Bare repository'));
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        await waitFor(() =>
            expect(initFn).toHaveBeenCalledWith({
                path: '/tmp/new',
                defaultBranch: 'trunk',
                bare: true,
            }),
        );
        await waitFor(() =>
            expect(useUiStore.getState().newRepoDialogOpen).toBe(false),
        );
    });

    test('an existing repository offers to open it instead of reinitializing', async () => {
        const initFn = vi.fn(async () => {
            throw { code: 'repoExists', message: 'exists' };
        });
        const openFn = vi.fn(async () => {
            throw new Error('stop before navigate');
        });
        renderDialog(makeApi({ repoInit: initFn, repoOpen: openFn }));

        fireEvent.change(await screen.findByLabelText('Destination path'), {
            target: { value: '/tmp/existing' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Create' }));

        expect(await screen.findByText(/Open it instead/i)).toBeTruthy();
        const openBtn = screen.getByRole('button', { name: 'Open existing' });
        fireEvent.click(openBtn);
        await waitFor(() =>
            expect(openFn).toHaveBeenCalledWith('/tmp/existing'),
        );
    });

    test('the destination path can be selected from the host filesystem picker', async () => {
        const listDir = vi.fn(async () => listing);
        renderDialog(makeApi({ filesystemListDir: listDir }));

        fireEvent.click(
            screen.getByLabelText(
                'Browse host folders for repository destination',
            ),
        );
        await screen.findByRole('heading', { name: 'Choose host folder' });
        await waitFor(() => expect(listDir).toHaveBeenCalled());
        fireEvent.click(screen.getByRole('button', { name: 'Use folder' }));

        expect(
            (screen.getByLabelText('Destination path') as HTMLInputElement)
                .value,
        ).toBe('/tmp');
    });
});
