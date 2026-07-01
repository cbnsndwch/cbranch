// @vitest-environment jsdom
import { NoteContent, Oid, RepoId } from '@cbranch/rpc-contract';
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
import { DetailsPanel } from './DetailsPanel';

const repoId = RepoId.make('r1');
const oid = Oid.make('a'.repeat(40));

const detail = {
    oid,
    parents: [],
    tree: Oid.make('b'.repeat(40)),
    author: {
        name: 'Ada',
        email: 'ada@x.io',
        when: { epochSeconds: 1700000000, tzOffsetMinutes: 0 },
    },
    committer: {
        name: 'Ada',
        email: 'ada@x.io',
        when: { epochSeconds: 1700000000, tzOffsetMinutes: 0 },
    },
    subject: 'feat: thing',
    body: '',
    messageRaw: 'feat: thing',
    stats: { filesChanged: 1, additions: 1, deletions: 0 },
};

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        commitDetail: vi.fn(async () => detail as never),
        notesGet: vi.fn(
            async () => new NoteContent({ present: true, text: 'a note\n' }),
        ),
        notesRemove: vi.fn(async () => undefined),
        ...over,
    }) as unknown as CbranchApi;

const renderPanel = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <DetailsPanel repoId={repoId} oid={oid} onSelectOid={vi.fn()} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    useUiStore.setState({ noteEditor: null });
});
afterEach(() => cleanup());

describe('DetailsPanel note section', () => {
    test('shows an existing note and offers Edit/Remove', async () => {
        renderPanel(makeApi());
        expect(await screen.findByText('a note')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    });

    test('Edit opens the note editor for the commit', async () => {
        renderPanel(makeApi());
        fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
        expect(useUiStore.getState().noteEditor).toEqual({ oid });
    });

    test('Remove deletes the note', async () => {
        const removeFn = vi.fn(async () => undefined);
        renderPanel(makeApi({ notesRemove: removeFn }));
        fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(removeFn).toHaveBeenCalledWith(repoId, oid));
    });

    test('a commit with no note shows the hash-unchanged hint and only Add', async () => {
        renderPanel(
            makeApi({
                notesGet: vi.fn(
                    async () => new NoteContent({ present: false, text: '' }),
                ),
            }),
        );
        expect(
            await screen.findByText(/does not change the commit's hash/i),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    });
});
