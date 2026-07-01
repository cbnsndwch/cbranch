// @vitest-environment jsdom
import { Oid, RepoId } from '@cbranch/rpc-contract';
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
import { UndoLastCommitDialog } from './UndoLastCommitDialog';

const repoId = RepoId.make('repo-1');
const oid = (h: string) => Oid.make(h.padEnd(40, '0'));

interface Scenario {
    parents?: string[];
    inProgress?: string;
    upstream?: string;
    ahead?: number;
    headOid?: string | null;
}

const makeApi = (s: Scenario = {}): CbranchApi => {
    const headOid = s.headOid === undefined ? 'a' : s.headOid;
    return {
        repoState: vi.fn(async () => ({
            headOid: headOid === null ? undefined : oid(headOid),
            inProgress: s.inProgress ?? 'none',
            isDetached: false,
        })),
        commitDetail: vi.fn(async () => ({
            oid: oid(headOid ?? 'a'),
            parents: (s.parents ?? ['b']).map(p => oid(p)),
        })),
        statusGet: vi.fn(async () => ({
            entries: [],
            hasConflicts: false,
            branch:
                s.upstream === undefined
                    ? undefined
                    : {
                          head: 'main',
                          upstream: s.upstream,
                          ahead: s.ahead ?? 0,
                      },
        })),
        commitLastMessage: vi.fn(async () => ({
            subject: 'feat: original',
            body: 'the body',
            raw: 'feat: original\n\nthe body',
        })),
        resetTo: vi.fn(async () => undefined),
    } as unknown as CbranchApi;
};

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <UndoLastCommitDialog repoId={repoId} />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

beforeEach(() => {
    useUiStore.setState({
        undoDialogOpen: true,
        commitDialogOpen: false,
        commitDraft: {
            subject: '',
            body: '',
            amend: false,
            signoff: false,
            allowEmpty: false,
            resetAuthor: false,
            sign: false,
            signFormat: 'gpg',
            authorOverride: false,
            authorName: '',
            authorEmail: '',
        },
    });
});
afterEach(() => cleanup());

describe('UndoLastCommitDialog', () => {
    test('a normal commit undoes with a soft HEAD~1 reset and prefills the message', async () => {
        const resetFn = vi.fn(async () => undefined);
        const api = makeApi({ parents: ['b'] });
        (api as { resetTo: unknown }).resetTo = resetFn;
        renderDialog(api);

        const btn = await screen.findByRole('button', {
            name: 'Undo last commit',
        });
        fireEvent.click(btn);
        await waitFor(() =>
            expect(resetFn).toHaveBeenCalledWith(repoId, 'soft', 'HEAD~1'),
        );
        await waitFor(() => {
            const draft = useUiStore.getState().commitDraft;
            expect(draft.subject).toBe('feat: original');
            expect(draft.body).toBe('the body');
        });
        expect(useUiStore.getState().commitDialogOpen).toBe(true);
    });

    test('a merge commit is blocked with no undo action', async () => {
        renderDialog(makeApi({ parents: ['b', 'c'] }));
        expect(await screen.findByText(/merge commit/i)).toBeTruthy();
        expect(
            screen.queryByRole('button', { name: 'Undo last commit' }),
        ).toBeNull();
    });

    test('a root commit is blocked', async () => {
        renderDialog(makeApi({ parents: [] }));
        expect(await screen.findByText(/root commit/i)).toBeTruthy();
        expect(
            screen.queryByRole('button', { name: 'Undo last commit' }),
        ).toBeNull();
    });

    test('an in-progress operation blocks the undo', async () => {
        renderDialog(makeApi({ inProgress: 'rebase' }));
        expect(await screen.findByText(/in progress/i)).toBeTruthy();
        expect(
            screen.queryByRole('button', { name: 'Undo last commit' }),
        ).toBeNull();
    });

    test('a pushed last commit warns about divergence but still allows undo', async () => {
        renderDialog(
            makeApi({ parents: ['b'], upstream: 'origin/main', ahead: 0 }),
        );
        expect(
            await screen.findByText(/diverge from the remote/i),
        ).toBeTruthy();
        expect(
            screen.getByRole('button', { name: 'Undo last commit' }),
        ).toBeTruthy();
    });
});
