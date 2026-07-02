// Browser-mode spec: the "Remote" picker is a Base UI popup Select whose value can
// only be committed in a real browser (jsdom can't lay the popup out).
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
import { TagsPanel } from './TagsPanel';

const repoId = RepoId.make('repo-1');

const tag = {
    name: 'v1.0.0',
    targetOid: 'a'.repeat(40),
    isAnnotated: false,
    taggerName: '',
    taggerDate: 0,
};

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        tagList: vi.fn(async () => [tag]),
        remoteList: vi.fn(async () => [
            { name: 'origin', fetchUrl: 'git@example:repo.git' },
            { name: 'upstream', fetchUrl: 'git@example:up.git' },
        ]),
        tagCreate: vi.fn(async () => undefined),
        tagDelete: vi.fn(async () => undefined),
        tagPush: vi.fn(async () => undefined),
        tagDeleteRemote: vi.fn(async () => undefined),
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
                    <TagsPanel repoId={repoId} />
                </ApiProvider>
            </QueryClientProvider>
        </MemoryRouter>,
    );
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

/** Open the "Remote" popup Select and commit the option named `name`. In a real
 * browser Base UI commits on the pointer sequence (jsdom cannot drive this). */
const chooseRemote = async (name: string) => {
    fireEvent.click(screen.getByLabelText('Remote'));
    const option = await screen.findByRole('option', { name });
    fireEvent.pointerDown(option);
    fireEvent.pointerUp(option);
    fireEvent.click(option);
};

describe('TagsPanel remote selection (UI-011)', () => {
    test('push lets the user choose the remote', async () => {
        const tagPush = vi.fn(async () => undefined);
        renderPanel(makeFakeApi({ tagPush }));

        await screen.findByText('v1.0.0');
        act(() => fireEvent.click(screen.getByLabelText('Tag actions')));
        const pushItem = await screen.findByText('Push to remote…');
        act(() => fireEvent.click(pushItem));

        await screen.findByLabelText('Remote');
        await chooseRemote('upstream');
        act(() => fireEvent.click(screen.getByText('Push')));

        await waitFor(() =>
            expect(tagPush).toHaveBeenCalledWith(
                repoId,
                'upstream',
                expect.objectContaining({ name: 'v1.0.0' }),
            ),
        );
    });

    test('delete-from-remote uses the chosen remote', async () => {
        const tagDeleteRemote = vi.fn(async () => undefined);
        renderPanel(makeFakeApi({ tagDeleteRemote }));

        await screen.findByText('v1.0.0');
        act(() => fireEvent.click(screen.getByLabelText('Tag actions')));
        const deleteItem = await screen.findByText('Delete from remote…');
        act(() => fireEvent.click(deleteItem));

        await screen.findByLabelText('Remote');
        await chooseRemote('upstream');
        act(() => fireEvent.click(screen.getByText('Delete')));

        await waitFor(() =>
            expect(tagDeleteRemote).toHaveBeenCalledWith(
                repoId,
                'upstream',
                'v1.0.0',
            ),
        );
    });
});
