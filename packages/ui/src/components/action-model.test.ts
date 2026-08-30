import { describe, expect, test, vi } from 'vitest';

import { type ActionMenuEntry } from './action-menu';
import { resolveBranchActions } from './branch-action-model';
import { resolveCommitActions } from './commit-action-model';

const flatten = (
    entries: ReadonlyArray<ActionMenuEntry>,
): ReadonlyArray<ActionMenuEntry> =>
    entries.flatMap(entry =>
        entry.kind === 'submenu' ? [entry, ...flatten(entry.entries)] : [entry],
    );

const callbacks = () => ({
    switchTo: vi.fn(),
    createFrom: vi.fn(),
    merge: vi.fn(),
    checkoutDetached: vi.fn(),
    setUpstream: vi.fn(),
    push: vi.fn(),
    pull: vi.fn(),
    rename: vi.fn(),
    deleteLocal: vi.fn(),
    deleteRemote: vi.fn(),
    resetCurrent: vi.fn(),
    rebaseCurrent: vi.fn(),
    createTag: vi.fn(),
    cherryPickTip: vi.fn(),
    revertTip: vi.fn(),
    archiveTip: vi.fn(),
});

describe('context action resolvers', () => {
    test('commit inventory accounts for every reference submenu', () => {
        const entries = flatten(
            resolveCommitActions({
                callbacks: {},
                hasRefs: false,
                hasParent: false,
                hasChild: false,
                baseSelected: false,
            }),
        );
        const ids = new Set(entries.map(entry => entry.id));
        for (const id of [
            'copy',
            'commands.merge',
            'commands.rebaseCurrent',
            'commands.reset',
            'commands.createBranch',
            'commands.createTag',
            'commands.checkoutRevision',
            'commands.revert',
            'commands.cherryPick',
            'commands.archive',
            'advanced',
            'compare',
            'navigate',
            'view',
        ])
            expect(ids.has(id), id).toBe(true);
        for (const entry of entries) {
            if (entry.kind === 'action' && !entry.onSelect)
                expect(entry.disabledReason, entry.id).toBeTruthy();
        }
    });

    test('busy branch state disables every mutating action with a reason', () => {
        const entries = flatten(
            resolveBranchActions({
                isCurrent: false,
                isRemote: false,
                hasRemoteTarget: true,
                busy: true,
                callbacks: callbacks(),
            }),
        );
        for (const entry of entries) {
            if (entry.kind === 'separator') continue;
            expect(entry.disabledReason, entry.id).toBe(
                'Another branch operation is in progress.',
            );
            if (entry.kind === 'action')
                expect(entry.onSelect, entry.id).toBeUndefined();
        }
    });

    test('current and remote branch guards are resolved centrally', () => {
        const localCurrent = flatten(
            resolveBranchActions({
                isCurrent: true,
                isRemote: false,
                hasRemoteTarget: true,
                busy: false,
                callbacks: callbacks(),
            }),
        );
        const byId = (id: string) =>
            localCurrent.find(entry => entry.id === id);
        expect(byId('branch.switch')).toMatchObject({
            onSelect: undefined,
            disabledReason: 'This is already the current branch.',
        });
        expect(byId('branch.deleteLocal')).toMatchObject({
            onSelect: undefined,
            disabledReason: 'Switch away before deleting the current branch.',
        });
        expect(byId('branch.pull')).toMatchObject({
            disabledReason: undefined,
        });
    });

    test('does not claim branch-panel selection without a selection target', () => {
        const entries = flatten(
            resolveCommitActions({
                callbacks: {},
                hasRefs: true,
                hasParent: true,
                hasChild: true,
                baseSelected: false,
            }),
        );
        expect(
            entries.find(entry => entry.id === 'selection.revealRef'),
        ).toMatchObject({
            onSelect: undefined,
            disabledReason:
                'The branches panel does not expose programmatic ref selection yet.',
        });
    });
});
