// @vitest-environment jsdom
import {
    CommitCreated,
    CommitMessage,
    Oid,
    RepoId,
    RepoState,
    StatusEntry,
    WorkingTreeStatus,
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

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { type CommitDraft, useUiStore } from '../state/store';
import { CommitDialog } from './CommitDialog';

const repoId = RepoId.make('test-repo');
const oid = Oid.make('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

const emptyDraft: CommitDraft = {
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
};

const stagedEntry = new StatusEntry({
    path: 'file.ts',
    staged: 'modified',
    unstaged: 'unmodified',
    isConflicted: false,
    isUntracked: false,
    isIgnored: false,
    isSubmodule: false,
});

const conflictedEntry = new StatusEntry({
    path: 'merge.ts',
    staged: 'updatedButUnmerged',
    unstaged: 'updatedButUnmerged',
    isConflicted: true,
    isUntracked: false,
    isIgnored: false,
    isSubmodule: false,
});

const makeStatus = (
    entries: StatusEntry[] = [],
    hasConflicts = false,
    branch?: WorkingTreeStatus['branch'],
): WorkingTreeStatus =>
    new WorkingTreeStatus({ entries, hasConflicts, branch });

const normalState = new RepoState({
    headOid: oid,
    currentBranch: 'main',
    isDetached: false,
    inProgress: 'none',
    isBare: false,
    isEmpty: false,
    repoRoot: '/repo',
    gitDir: '/repo/.git',
    defaultBranch: 'main',
});

const unbornState = new RepoState({
    currentBranch: 'main',
    isDetached: false,
    inProgress: 'none',
    isBare: false,
    isEmpty: true,
    repoRoot: '/repo',
    gitDir: '/repo/.git',
});

const detachedState = new RepoState({
    headOid: oid,
    isDetached: true,
    inProgress: 'none',
    isBare: false,
    isEmpty: false,
    repoRoot: '/repo',
    gitDir: '/repo/.git',
});

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi => ({
    repoOpen: vi.fn(async () => {
        throw new Error('noop');
    }),
    recentList: vi.fn(async () => []),
    recentRemove: vi.fn(async () => undefined),
    repoState: vi.fn(async () => normalState),
    commitDetail: vi.fn(async () => {
        throw new Error('noop');
    }),
    commitDiff: vi.fn(async () => []),
    workingFileDiff: vi.fn(async () => {
        throw new Error('noop');
    }),
    fileContentAtRev: vi.fn(async () => {
        throw new Error('noop');
    }),
    statusGet: vi.fn(async () => makeStatus()),
    stageFiles: vi.fn(async () => undefined),
    unstageFiles: vi.fn(async () => undefined),
    discardFiles: vi.fn(async () => undefined),
    deleteUntracked: vi.fn(async () => undefined),
    resetTo: vi.fn(async () => undefined),
    stageHunks: vi.fn(async () => undefined),
    unstageHunks: vi.fn(async () => undefined),
    discardHunks: vi.fn(async () => undefined),
    commitCreate: vi.fn(
        async () =>
            new CommitCreated({ oid, shortOid: 'aaaaaaa', subject: 'test' }),
    ),
    commitLastMessage: vi.fn(async () => {
        throw new Error('noop');
    }),
    logStream: vi.fn(() => () => undefined),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
});

const renderDialog = (api: CbranchApi) => {
    const qc = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return render(
        <QueryClientProvider client={qc}>
            <ApiProvider api={api}>
                <CommitDialog />
            </ApiProvider>
        </QueryClientProvider>,
    );
};

const openWith = (draft: Partial<CommitDraft> = {}, keepOpen = true) => {
    useUiStore.setState({
        activeRepoId: repoId,
        commitDialogOpen: true,
        keepOpenAfterCommit: keepOpen,
        commitDraft: { ...emptyDraft, ...draft },
        selectedDiffFile: null,
    });
};

beforeEach(() => {
    if (!Element.prototype.scrollIntoView)
        Element.prototype.scrollIntoView = () => undefined;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        };
    useUiStore.setState({
        activeRepoId: null,
        commitDialogOpen: false,
        keepOpenAfterCommit: true,
        commitDraft: emptyDraft,
    });
});
afterEach(() => cleanup());

const commitButton = () =>
    Array.from(document.querySelectorAll('button')).find(
        b => b.textContent?.trim() === 'Commit',
    );

describe('CommitDialog', () => {
    test('renders nothing when closed', () => {
        renderDialog(makeApi());
        expect(screen.queryByText(/Commit —/)).toBeNull();
    });

    test('opens with the full flow: branch header, changes, composer', async () => {
        const api = makeApi({
            statusGet: vi.fn(async () => makeStatus([stagedEntry])),
        });
        renderDialog(api);
        act(() => openWith());
        expect(await screen.findByText(/Commit —/)).toBeTruthy();
        expect(await screen.findByText('main')).toBeTruthy();
        expect(await screen.findByText('Staged Changes')).toBeTruthy();
        expect(screen.getByLabelText('Commit subject')).toBeTruthy();
        expect(screen.getByText('Keep open after commit')).toBeTruthy();
    });

    test('keep-open toggle defaults ON and persists when turned off', async () => {
        renderDialog(makeApi());
        act(() => openWith());
        const keep = (await screen.findByLabelText(
            'Keep open after commit',
        )) as HTMLInputElement;
        expect(useUiStore.getState().keepOpenAfterCommit).toBe(true);
        await act(async () => {
            fireEvent.click(keep);
        });
        expect(useUiStore.getState().keepOpenAfterCommit).toBe(false);
    });

    test('Cancel dismisses without losing draft (lenient close)', async () => {
        renderDialog(makeApi());
        act(() => openWith({ subject: 'wip: keep me' }));
        const cancel = await screen.findByRole('button', { name: 'Cancel' });
        await act(async () => {
            fireEvent.click(cancel);
        });
        expect(useUiStore.getState().commitDialogOpen).toBe(false);
        // Draft survives the close — re-opening restores it.
        expect(useUiStore.getState().commitDraft.subject).toBe('wip: keep me');
    });

    test('nothing staged → Commit disabled with a reason tooltip', async () => {
        renderDialog(makeApi({ statusGet: vi.fn(async () => makeStatus([])) }));
        act(() => openWith({ subject: 'feat: x' }));
        await screen.findByText(/Commit —/);
        await waitFor(() => expect(commitButton()?.disabled).toBe(true));
    });

    test('conflicts block the commit and surface a banner', async () => {
        const api = makeApi({
            statusGet: vi.fn(async () => makeStatus([conflictedEntry], true)),
        });
        renderDialog(api);
        act(() => openWith({ subject: 'fix: resolve' }));
        const banner = await screen.findByRole('alert');
        expect(banner.textContent).toMatch(/conflict/i);
        await waitFor(() => expect(commitButton()?.disabled).toBe(true));
    });

    test('unborn branch disables amend + reuse and shows a notice', async () => {
        const api = makeApi({
            repoState: vi.fn(async () => unbornState),
            statusGet: vi.fn(async () => makeStatus([stagedEntry])),
        });
        renderDialog(api);
        act(() => openWith());
        const amend = await screen.findByLabelText('Amend');
        // Base UI Switch conveys its disabled state via `data-disabled`, not a native prop.
        await waitFor(() =>
            expect(amend.hasAttribute('data-disabled')).toBe(true),
        );
        expect(screen.getByText(/Unborn branch/i)).toBeTruthy();
        const reuse = screen.getByRole('button', {
            name: /reuse last message/i,
        }) as HTMLButtonElement;
        expect(reuse.disabled).toBe(true);
    });

    test('detached HEAD is messaged in the title and footer', async () => {
        const api = makeApi({ repoState: vi.fn(async () => detachedState) });
        renderDialog(api);
        act(() => openWith());
        expect(await screen.findAllByText(/detached HEAD/i)).toHaveLength(2);
    });

    test('commit with keep-open OFF closes the dialog', async () => {
        const api = makeApi({
            statusGet: vi.fn(async () => makeStatus([stagedEntry])),
        });
        renderDialog(api);
        act(() => openWith({ subject: 'feat: ship' }, false));
        await screen.findByText(/Commit —/);
        const btn = await waitFor(() => {
            const b = commitButton();
            expect(b?.disabled).toBe(false);
            return b!;
        });
        await act(async () => {
            fireEvent.click(btn);
        });
        await waitFor(() => expect(api.commitCreate).toHaveBeenCalled());
        await waitFor(() =>
            expect(useUiStore.getState().commitDialogOpen).toBe(false),
        );
    });

    test('Ctrl+Enter commits from within the dialog', async () => {
        const api = makeApi({
            statusGet: vi.fn(async () => makeStatus([stagedEntry])),
        });
        renderDialog(api);
        act(() => openWith({ subject: 'feat: keyboard' }));
        const title = await screen.findByText(/Commit —/);
        await waitFor(() => expect(commitButton()?.disabled).toBe(false));
        await act(async () => {
            fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true });
        });
        await waitFor(() => expect(api.commitCreate).toHaveBeenCalled());
    });

    test('Reuse Last Message seeds the composer from HEAD', async () => {
        const msg = new CommitMessage({
            subject: 'prev subject',
            body: 'prev body',
            raw: 'prev subject\n\nprev body',
        });
        const api = makeApi({
            statusGet: vi.fn(async () => makeStatus([stagedEntry])),
            commitLastMessage: vi.fn(async () => msg),
        });
        renderDialog(api);
        act(() => openWith());
        const reuse = await waitFor(() => {
            const btn = screen.getByRole('button', {
                name: /reuse last message/i,
            });
            expect((btn as HTMLButtonElement).disabled).toBe(false);
            return btn;
        });
        await act(async () => {
            fireEvent.click(reuse);
        });
        await waitFor(() =>
            expect(
                (screen.getByLabelText('Commit subject') as HTMLInputElement)
                    .value,
            ).toBe('prev subject'),
        );
    });
});
