// @vitest-environment jsdom
import { ConflictSides, ConflictStage, RepoId } from '@cbranch/rpc-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type CbranchApi } from '../rpc/api';
import { ApiProvider } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { MergeEditor } from './MergeEditor';

// Keep Shiki + the lazy CodeMirror merge surface offline; the textarea + hunk model are the
// testable core, the compare pane is a read-only visual aid.
vi.mock('../lib/shiki-highlighter', () => ({
    languageForPath: () => 'typescript',
    loadShikiLines: async () => null,
}));
vi.mock('@codemirror/state', () => ({
    EditorState: {
        create: () => ({ doc: { lines: 1, line: () => ({ from: 0, to: 0 }) } }),
        readOnly: { of: () => ({}) },
    },
    StateField: { define: () => ({}) },
    RangeSetBuilder: class {
        add() {}
        finish() {
            return {};
        }
    },
}));
vi.mock('@codemirror/view', () => ({
    EditorView: Object.assign(
        class {
            destroy() {}
        },
        {
            editable: { of: () => ({}) },
            decorations: { from: () => ({}) },
            theme: () => ({}),
        },
    ),
    lineNumbers: () => ({}),
    Decoration: { mark: () => ({}) },
}));
vi.mock('@codemirror/merge', () => ({
    MergeView: class {
        constructor({ parent }: { parent: HTMLElement }) {
            const el = document.createElement('div');
            el.className = 'cm-merge';
            parent.appendChild(el);
        }
        destroy() {}
    },
}));

const LF = String.fromCharCode(10);
const join = (...xs: string[]) => xs.join(LF);
const SEED = join(
    'context top',
    '<<<<<<< HEAD',
    'our change',
    '|||||||  base',
    'ancestor',
    '=======',
    'their change',
    '>>>>>>> feature',
    'context bottom',
);

const repoId = RepoId.make('repo-1');

const stage = (content: string, present = true): ConflictStage =>
    new ConflictStage({
        present,
        isBinary: false,
        encoding: 'utf8',
        content,
        size: content.length,
    });

const absent = (): ConflictStage =>
    new ConflictStage({
        present: false,
        isBinary: false,
        encoding: 'utf8',
        content: '',
        size: 0,
    });

const sides = (over: Partial<ConflictSides> = {}): ConflictSides =>
    new ConflictSides({
        path: 'a.ts',
        classification: 'bothModified',
        isBinary: false,
        isSubmodule: false,
        base: stage('ancestor'),
        ours: stage('our change'),
        theirs: stage('their change'),
        merged: stage(SEED),
        mergeable: true,
        ...over,
    });

const b64ToUtf8 = (b64: string): string =>
    new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

const discardButton = () =>
    screen.getByRole('button', {
        name: 'Discard changes',
    }) as HTMLButtonElement;

const makeApi = (over: Partial<CbranchApi>): CbranchApi =>
    ({
        conflictSides: vi.fn(async () => sides()),
        conflictSaveMerged: vi.fn(async () => undefined),
        conflictResolve: vi.fn(async () => undefined),
        ...over,
    }) as unknown as CbranchApi;

const renderEditor = (api: CbranchApi, onClose = vi.fn()) => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const wrap = (ui: ReactNode) => (
        <QueryClientProvider client={queryClient}>
            <ApiProvider api={api}>{ui}</ApiProvider>
        </QueryClientProvider>
    );
    return {
        onClose,
        ...render(
            wrap(<MergeEditor repoId={repoId} path="a.ts" onClose={onClose} />),
        ),
    };
};

beforeEach(() => {
    useUiStore.setState({ theme: 'light' });
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('MergeEditor (REQ-MERGE-010..020)', () => {
    test('accept theirs then save writes the assembled, marker-free bytes (AC-1)', async () => {
        const saveFn = vi.fn(async () => undefined);
        renderEditor(makeApi({ conflictSaveMerged: saveFn }));

        await screen.findByLabelText('Merged result');
        expect(screen.getByText('Conflict 1 of 1')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: 'Accept theirs' }));
        expect(screen.getByText('All conflicts addressed')).toBeTruthy();

        fireEvent.click(
            screen.getByRole('button', { name: /Save .* mark resolved/ }),
        );
        await waitFor(() => expect(saveFn).toHaveBeenCalled());
        const [, , content, encoding] = saveFn.mock.calls[0]!;
        expect(encoding).toBe('base64');
        expect(b64ToUtf8(content as string)).toBe(
            join('context top', 'their change', 'context bottom'),
        );
    });

    test('saving with markers requires confirmation, then writes them (AC-12)', async () => {
        const saveFn = vi.fn(async () => undefined);
        renderEditor(makeApi({ conflictSaveMerged: saveFn }));
        await screen.findByLabelText('Merged result');

        fireEvent.click(
            screen.getByRole('button', { name: /Save .* mark resolved/ }),
        );
        await screen.findByText('Conflict markers remain');
        expect(saveFn).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
        await waitFor(() => expect(saveFn).toHaveBeenCalled());
        const [, , content] = saveFn.mock.calls[0]!;
        expect(b64ToUtf8(content as string)).toBe(SEED);
    });

    test('an absent base is shown empty and the editor still opens (AC-3)', async () => {
        renderEditor(
            makeApi({
                conflictSides: vi.fn(async () =>
                    sides({ base: absent(), classification: 'bothAdded' }),
                ),
            }),
        );
        await screen.findByLabelText('Merged result');
        expect(
            screen.getByRole('button', { name: /Base \(none\)/ }),
        ).toBeTruthy();
    });

    test('an oversize file offers whole-file actions, not the editor (AC-13)', async () => {
        const resolveFn = vi.fn(async () => undefined);
        renderEditor(
            makeApi({
                conflictResolve: resolveFn,
                conflictSides: vi.fn(async () =>
                    sides({ mergeable: false, reason: 'oversize' }),
                ),
            }),
        );
        await screen.findByText(/too large to edit inline/);
        expect(screen.queryByLabelText('Merged result')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Take theirs' }));
        await waitFor(() =>
            expect(resolveFn).toHaveBeenCalledWith(repoId, ['a.ts'], 'theirs'),
        );
    });

    test('unbalanced markers fall back to plain-text editing (REQ-EDGE-004)', async () => {
        renderEditor(
            makeApi({
                conflictSides: vi.fn(async () =>
                    sides({ merged: stage(join('plain', '=======', 'stray')) }),
                ),
            }),
        );
        await screen.findByLabelText('Merged result');
        expect(screen.getByText(/unbalanced or nested/)).toBeTruthy();
        expect(screen.queryByText(/Conflict 1 of/)).toBeNull();
    });

    test('discard reverts the result to the loaded seed (REQ-MERGE-018)', async () => {
        renderEditor(makeApi({}));
        await screen.findByLabelText('Merged result');

        fireEvent.click(screen.getByRole('button', { name: 'Accept theirs' }));
        expect(screen.getByText('All conflicts addressed')).toBeTruthy();

        fireEvent.click(
            screen.getByRole('button', { name: 'Discard changes' }),
        );
        expect(screen.getByText('Conflict 1 of 1')).toBeTruthy();
    });

    test('free-text edits drive dirty state; discard restores the seed (REQ-MERGE-013/018)', async () => {
        renderEditor(makeApi({}));
        const ta = (await screen.findByLabelText(
            'Merged result',
        )) as HTMLTextAreaElement;
        expect(discardButton().disabled).toBe(true); // clean seed

        fireEvent.change(ta, { target: { value: 'hand edited' } });
        expect(discardButton().disabled).toBe(false); // dirty

        fireEvent.click(discardButton());
        expect(
            (screen.getByLabelText('Merged result') as HTMLTextAreaElement)
                .value,
        ).toBe(SEED);
        expect(discardButton().disabled).toBe(true); // clean again
    });

    test('resolves multiple hunks each to a different side (AC-1 multi-hunk)', async () => {
        const saveFn = vi.fn(async () => undefined);
        const seed2 = join(
            'top',
            '<<<<<<< HEAD',
            'ours1',
            '=======',
            'theirs1',
            '>>>>>>> feature',
            'mid',
            '<<<<<<< HEAD',
            'ours2',
            '=======',
            'theirs2',
            '>>>>>>> feature',
            'bottom',
        );
        renderEditor(
            makeApi({
                conflictSides: vi.fn(async () =>
                    sides({ merged: stage(seed2) }),
                ),
                conflictSaveMerged: saveFn,
            }),
        );
        await screen.findByLabelText('Merged result');
        expect(screen.getByText('Conflict 1 of 2')).toBeTruthy();

        // accept theirs on the first hunk; the second re-indexes to position 0
        fireEvent.click(
            screen.getAllByRole('button', { name: 'Accept theirs' })[0]!,
        );
        expect(screen.getByText('Conflict 1 of 1')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Accept ours' }));
        expect(screen.getByText('All conflicts addressed')).toBeTruthy();

        fireEvent.click(
            screen.getByRole('button', { name: /Save .* mark resolved/ }),
        );
        await waitFor(() => expect(saveFn).toHaveBeenCalled());
        const [, , content] = saveFn.mock.calls[0]!;
        expect(b64ToUtf8(content as string)).toBe(
            join('top', 'theirs1', 'mid', 'ours2', 'bottom'),
        );
    });

    test('a successful save closes the editor (REQ-MERGE-016)', async () => {
        const onClose = vi.fn();
        renderEditor(makeApi({}), onClose);
        await screen.findByLabelText('Merged result');
        fireEvent.click(screen.getByRole('button', { name: 'Accept theirs' }));
        fireEvent.click(
            screen.getByRole('button', { name: /Save .* mark resolved/ }),
        );
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    test('a failed save reports the error and leaves the path unresolved (REQ-UX-087)', async () => {
        const onClose = vi.fn();
        const saveFn = vi.fn(async () => {
            throw new Error('EACCES: write failed');
        });
        renderEditor(makeApi({ conflictSaveMerged: saveFn }), onClose);
        await screen.findByLabelText('Merged result');
        fireEvent.click(screen.getByRole('button', { name: 'Accept theirs' }));
        fireEvent.click(
            screen.getByRole('button', { name: /Save .* mark resolved/ }),
        );
        await waitFor(() => expect(saveFn).toHaveBeenCalled());
        expect(onClose).not.toHaveBeenCalled(); // dialog stays open
        expect(screen.getByLabelText('Merged result')).toBeTruthy();
    });

    test('the marker warning can be dismissed without saving (AC-12 cancel)', async () => {
        const saveFn = vi.fn(async () => undefined);
        const onClose = vi.fn();
        renderEditor(makeApi({ conflictSaveMerged: saveFn }), onClose);
        await screen.findByLabelText('Merged result');
        fireEvent.click(
            screen.getByRole('button', { name: /Save .* mark resolved/ }),
        );
        await screen.findByText('Conflict markers remain');

        fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        await waitFor(() =>
            expect(screen.queryByText('Conflict markers remain')).toBeNull(),
        );
        expect(saveFn).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    test('renders loading and error states for the conflict query', async () => {
        const loading = renderEditor(
            makeApi({
                conflictSides: vi.fn(() => new Promise<never>(() => {})),
            }),
        );
        expect(await screen.findByText('Loading conflict…')).toBeTruthy();
        loading.unmount();

        renderEditor(
            makeApi({
                conflictSides: vi.fn(async () => {
                    throw new Error('boom');
                }),
            }),
        );
        expect(
            await screen.findByText('Could not load this conflict.'),
        ).toBeTruthy();
    });

    test('an oversize resolve failure keeps the editor open (REQ-UX-087)', async () => {
        const onClose = vi.fn();
        const resolveFn = vi.fn(async () => {
            throw new Error('repo locked');
        });
        renderEditor(
            makeApi({
                conflictResolve: resolveFn,
                conflictSides: vi.fn(async () =>
                    sides({ mergeable: false, reason: 'oversize' }),
                ),
            }),
            onClose,
        );
        await screen.findByText(/too large to edit inline/);
        fireEvent.click(screen.getByRole('button', { name: 'Take theirs' }));
        await waitFor(() => expect(resolveFn).toHaveBeenCalled());
        expect(onClose).not.toHaveBeenCalled();
    });
});
