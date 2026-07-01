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
import { type ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { toast } from 'sonner';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { FileHistoryPanel } from './FileHistoryPanel';

// Stub the heavy viewers: the panel only wires them; their own behavior is covered elsewhere
// (FileAtRevision/DiffView tests). Stubs make the sub-view assertions deterministic offline.
vi.mock('./FileAtRevision', () => ({
    FileAtRevision: ({ rev, path }: { rev: string; path: string }) => (
        <div>{`file-at-rev:${path}@${rev}`}</div>
    ),
}));
vi.mock('./DiffView', () => ({
    DiffView: ({ file }: { file: { newPath: string } }) => (
        <div>{`diff-view:${file.newPath}`}</div>
    ),
}));

vi.mock('sonner', () => ({
    toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

const repoId = RepoId.make('repo-1');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const entry = (over: Record<string, unknown>) => ({
    oid: A,
    authorName: 'Ada',
    authorEmail: 'ada@x',
    authorDate: '2024-01-01T00:00:00Z',
    subject: 'first commit',
    path: 'src/a.ts',
    status: 'modified',
    ...over,
});

const page = (entries: ReadonlyArray<unknown>, nextCursor?: string) => ({
    entries,
    nextCursor,
});

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
    ({
        fileHistory: vi.fn(async () => page([entry({})])),
        commitDiff: vi.fn(async () => [{ newPath: 'src/a.ts', hunks: [] }]),
        ...over,
    }) as unknown as CbranchApi;

const renderPanel = (
    api: CbranchApi,
    props: Partial<Parameters<typeof FileHistoryPanel>[0]> = {},
) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const onClose = props.onClose ?? vi.fn();
    const onOpenCommit = props.onOpenCommit ?? vi.fn();
    const onBlame = props.onBlame ?? vi.fn();
    const ui: ReactNode = (
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <FileHistoryPanel
                    repoId={repoId}
                    path={props.path ?? 'src/a.ts'}
                    startRev={props.startRev}
                    onClose={onClose}
                    onOpenCommit={onOpenCommit}
                    onBlame={onBlame}
                />
            </ApiProvider>
        </QueryClientProvider>
    );
    return { ...render(ui), onClose, onOpenCommit, onBlame };
};

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('FileHistoryPanel (REQ-FH-001..005 / REQ-UX-010)', () => {
    test('lists revisions with abbreviated SHA, author, and subject (REQ-FH-001)', async () => {
        renderPanel(makeApi());
        expect(await screen.findByText('first commit')).toBeTruthy();
        expect(screen.getByText('aaaaaaaa')).toBeTruthy(); // abbreviated SHA
        expect(screen.getByText('Ada')).toBeTruthy();
        // A non-rename row (no oldPath) shows no rename indicator.
        expect(screen.queryByText(/renamed from/)).toBeNull();
    });

    test('indicates the prior path on a renamed revision (REQ-FH-002 / AC-13)', async () => {
        const api = makeApi({
            fileHistory: vi.fn(async () =>
                page([entry({ status: 'renamed', oldPath: 'src/old.ts' })]),
            ),
        });
        renderPanel(api);
        expect(
            await screen.findByText(/renamed from src\/old\.ts/),
        ).toBeTruthy();
    });

    test('empty history shows a placeholder and no Load more (REQ-FH-004)', async () => {
        renderPanel(makeApi({ fileHistory: vi.fn(async () => page([])) }));
        expect(
            await screen.findByText('No history for this file.'),
        ).toBeTruthy();
        expect(screen.queryByText('Load more')).toBeNull();
    });

    test('threads a concrete startRev into the history request (REQ-FH-005)', async () => {
        const fileHistory = vi.fn(async () => page([entry({})]));
        renderPanel(makeApi({ fileHistory: fileHistory as never }), {
            startRev: A,
        });
        await screen.findByText('first commit');
        expect(fileHistory).toHaveBeenCalledWith(
            repoId,
            'src/a.ts',
            expect.objectContaining({ startRev: A }),
        );
    });

    test('Load more fetches the next page and appends it (REQ-FH-004)', async () => {
        const fileHistory = vi.fn(
            async (_r: unknown, _p: unknown, opts: { cursor?: string }) =>
                opts.cursor === 'c1'
                    ? page([entry({ oid: B, subject: 'second commit' })])
                    : page([entry({ subject: 'first commit' })], 'c1'),
        );
        renderPanel(makeApi({ fileHistory: fileHistory as never }));
        await screen.findByText('first commit');
        expect(screen.queryByText('second commit')).toBeNull();
        act(() => fireEvent.click(screen.getByText('Load more')));
        expect(await screen.findByText('second commit')).toBeTruthy();
        await waitFor(() =>
            expect(fileHistory).toHaveBeenCalledWith(
                repoId,
                'src/a.ts',
                expect.objectContaining({ cursor: 'c1' }),
            ),
        );
    });

    test('selecting a revision reveals actions; Blame hands off + closes (REQ-FH-003)', async () => {
        const { onBlame, onClose } = renderPanel(makeApi());
        await screen.findByLabelText('Revision aaaaaaaa');
        act(() => fireEvent.click(screen.getByLabelText('Revision aaaaaaaa')));
        act(() => fireEvent.click(screen.getByText('Blame')));
        expect(onBlame).toHaveBeenCalledWith({ rev: A, path: 'src/a.ts' });
        expect(onClose).toHaveBeenCalled();
    });

    test('Open commit selects the revision in the main view + closes (REQ-FH-003)', async () => {
        const { onOpenCommit, onClose } = renderPanel(makeApi());
        await screen.findByLabelText('Revision aaaaaaaa');
        act(() => fireEvent.click(screen.getByLabelText('Revision aaaaaaaa')));
        act(() => fireEvent.click(screen.getByText('Open commit')));
        expect(onOpenCommit).toHaveBeenCalledWith(A);
        expect(onClose).toHaveBeenCalled();
    });

    test('View file at revision opens the read-only editor, Back returns (REQ-UX-010)', async () => {
        renderPanel(makeApi());
        await screen.findByLabelText('Revision aaaaaaaa');
        act(() => fireEvent.click(screen.getByLabelText('Revision aaaaaaaa')));
        act(() => fireEvent.click(screen.getByText('View file at revision')));
        expect(
            await screen.findByText(`file-at-rev:src/a.ts@${A}`),
        ).toBeTruthy();
        act(() => fireEvent.click(screen.getByLabelText('Back to history')));
        expect(await screen.findByText('first commit')).toBeTruthy();
    });

    test('View diff renders the path-scoped patch in the diff viewer (REQ-FH-003)', async () => {
        const commitDiff = vi.fn(async () => [
            { newPath: 'src/a.ts', hunks: [] },
        ]);
        renderPanel(makeApi({ commitDiff: commitDiff as never }));
        await screen.findByLabelText('Revision aaaaaaaa');
        act(() => fireEvent.click(screen.getByLabelText('Revision aaaaaaaa')));
        act(() => fireEvent.click(screen.getByText('View diff')));
        expect(await screen.findByText('diff-view:src/a.ts')).toBeTruthy();
        expect(commitDiff).toHaveBeenCalledWith(
            expect.objectContaining({ target: A, paths: ['src/a.ts'] }),
        );
    });

    test('View diff of a rename includes the prior path so git detects the rename (AC-13)', async () => {
        const commitDiff = vi.fn(async () => [
            { newPath: 'src/a.ts', hunks: [] },
        ]);
        renderPanel(
            makeApi({
                commitDiff: commitDiff as never,
                fileHistory: vi.fn(async () =>
                    page([entry({ status: 'renamed', oldPath: 'src/old.ts' })]),
                ),
            }),
        );
        await screen.findByLabelText('Revision aaaaaaaa');
        act(() => fireEvent.click(screen.getByLabelText('Revision aaaaaaaa')));
        act(() => fireEvent.click(screen.getByText('View diff')));
        await screen.findByText('diff-view:src/a.ts');
        expect(commitDiff).toHaveBeenCalledWith(
            expect.objectContaining({ paths: ['src/a.ts', 'src/old.ts'] }),
        );
    });

    test('a diff failure surfaces a toast and an in-panel message (REQ-UX-011)', async () => {
        const commitDiff = vi.fn(async () => {
            throw new Error('fatal: bad object');
        });
        renderPanel(makeApi({ commitDiff: commitDiff as never }));
        await screen.findByLabelText('Revision aaaaaaaa');
        act(() => fireEvent.click(screen.getByLabelText('Revision aaaaaaaa')));
        act(() => fireEvent.click(screen.getByText('View diff')));
        expect(
            await screen.findByText('Could not load the diff.'),
        ).toBeTruthy();
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                'Could not load the diff for src/a.ts.',
            ),
        );
    });

    test('shows a loading skeleton while history is pending (REQ-UX-011)', async () => {
        const fileHistory = vi.fn(() => new Promise(() => {})); // never resolves
        renderPanel(makeApi({ fileHistory: fileHistory as never }));
        await waitFor(() =>
            expect(
                document.querySelector('[data-slot="skeleton"]'),
            ).toBeTruthy(),
        );
        expect(screen.queryByText('first commit')).toBeNull();
    });

    test('a history failure surfaces a toast, then Retry recovers (REQ-UX-011)', async () => {
        let attempt = 0;
        const fileHistory = vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('fatal: no such path');
            return page([entry({})]);
        });
        renderPanel(makeApi({ fileHistory: fileHistory as never }));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(
            screen.getByText("Could not load this file's history."),
        ).toBeTruthy();
        act(() => fireEvent.click(screen.getByText('Retry')));
        // Retry re-runs the query and the list now renders.
        expect(await screen.findByText('first commit')).toBeTruthy();
    });

    test('a Load-more failure toasts and offers Retry without losing loaded rows (REQ-UX-011)', async () => {
        const fileHistory = vi.fn(
            async (_r: unknown, _p: unknown, opts: { cursor?: string }) => {
                if (opts.cursor === 'c1')
                    throw new Error('fatal: server error');
                return page([entry({ subject: 'first commit' })], 'c1');
            },
        );
        renderPanel(makeApi({ fileHistory: fileHistory as never }));
        await screen.findByText('first commit');
        act(() => fireEvent.click(screen.getByText('Load more')));
        // The next-page error toasts (isError stays false for an infinite query post-page-1)…
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                'Could not load more history for src/a.ts.',
            ),
        );
        // …the loaded row survives, and the control becomes a Retry.
        expect(screen.getByText('first commit')).toBeTruthy();
        expect(await screen.findByText('Retry')).toBeTruthy();
    });
});
