// @vitest-environment jsdom
import { MetaFileContent, RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
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
import { MetaFileEditorDialog } from './MetaFileEditorDialog';

const repoId = RepoId.make('r1');

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        metaFileRead: vi.fn(
            async () =>
                new MetaFileContent({
                    file: 'gitignore',
                    exists: true,
                    text: 'node_modules\n',
                }),
        ),
        metaFileWrite: vi.fn(async () => undefined),
        ...over,
    }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <MetaFileEditorDialog repoId={repoId} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    useUiStore.setState({ metaFileDialog: 'gitignore' });
});
afterEach(() => cleanup());

describe('MetaFileEditorDialog', () => {
    test('loads the current content and Save writes it back', async () => {
        const writeFn = vi.fn(async () => undefined);
        renderDialog(makeApi({ metaFileWrite: writeFn }));

        // Wait for the content to load (the editor host mounts once seeded).
        await screen.findByLabelText('.gitignore content');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() =>
            expect(writeFn).toHaveBeenCalledWith(
                repoId,
                'gitignore',
                'node_modules\n',
            ),
        );
    });

    test('a not-yet-existing file shows a "new file" indicator', async () => {
        renderDialog(
            makeApi({
                metaFileRead: vi.fn(
                    async () =>
                        new MetaFileContent({
                            file: 'mailmap',
                            exists: false,
                            text: '',
                        }),
                ),
            }),
        );
        useUiStore.setState({ metaFileDialog: 'mailmap' });
        expect(await screen.findByText(/new file/i)).toBeTruthy();
    });

    test('switching the file tab updates the store selection', async () => {
        renderDialog(makeApi());
        await screen.findByText('Edit repository metadata');
        fireEvent.click(screen.getByRole('button', { name: '.gitattributes' }));
        expect(useUiStore.getState().metaFileDialog).toBe('gitattributes');
    });
});
