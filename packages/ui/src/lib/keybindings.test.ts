import { describe, expect, test } from 'vitest';

import {
    DEFAULT_KEYBINDINGS,
    eventToChord,
    findConflicts,
    matchChord,
    mergeBindings,
    parseChord,
} from './keybindings';

const ev = (
    key: string,
    mods: Partial<{
        metaKey: boolean;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
    }> = {},
) => ({
    key,
    metaKey: mods.metaKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
});

describe('parseChord', () => {
    test('splits modifiers and upper-cases a single-letter key', () => {
        expect(parseChord('Mod+Shift+Enter')).toEqual({
            mod: true,
            shift: true,
            alt: false,
            key: 'Enter',
        });
        expect(parseChord('Mod+k')).toEqual({
            mod: true,
            shift: false,
            alt: false,
            key: 'K',
        });
    });
});

describe('matchChord', () => {
    test('Ctrl and Cmd both satisfy Mod', () => {
        expect(matchChord(ev('k', { ctrlKey: true }), 'Mod+K')).toBe(true);
        expect(matchChord(ev('k', { metaKey: true }), 'Mod+K')).toBe(true);
    });

    test('requires the exact modifier set', () => {
        expect(matchChord(ev('k'), 'Mod+K')).toBe(false);
        expect(
            matchChord(ev('k', { ctrlKey: true, shiftKey: true }), 'Mod+K'),
        ).toBe(false);
        expect(
            matchChord(
                ev('Enter', { metaKey: true, shiftKey: true }),
                'Mod+Shift+Enter',
            ),
        ).toBe(true);
    });

    test('never matches an empty (cleared) chord', () => {
        expect(matchChord(ev('k', { ctrlKey: true }), '')).toBe(false);
    });
});

describe('eventToChord', () => {
    test('captures the normalized chord', () => {
        expect(eventToChord(ev('f', { ctrlKey: true }))).toBe('Mod+F');
        expect(
            eventToChord(ev('Enter', { metaKey: true, shiftKey: true })),
        ).toBe('Mod+Shift+Enter');
    });

    test('returns null for a bare modifier press', () => {
        expect(eventToChord(ev('Control', { ctrlKey: true }))).toBeNull();
        expect(eventToChord(ev('Shift', { shiftKey: true }))).toBeNull();
    });
});

describe('mergeBindings', () => {
    test('returns defaults when there are no overrides', () => {
        expect(mergeBindings({})).toEqual({ ...DEFAULT_KEYBINDINGS });
    });

    test('remaps a default and ignores unknown command ids', () => {
        const merged = mergeBindings({
            'history.find': 'Mod+G',
            'bogus.command': 'Mod+Z',
        });
        expect(merged['history.find']).toBe('Mod+G');
        expect('bogus.command' in merged).toBe(false);
    });

    test('an empty-string override clears a default', () => {
        const merged = mergeBindings({ 'view.commandPalette': '' });
        expect('view.commandPalette' in merged).toBe(false);
    });
});

describe('findConflicts', () => {
    test('flags a chord bound to two commands', () => {
        const conflicts = findConflicts({
            'view.commandPalette': 'Mod+K',
            'history.find': 'Mod+K',
        });
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.chord).toBe('Mod+K');
        expect(conflicts[0]?.commandIds.toSorted()).toEqual([
            'history.find',
            'view.commandPalette',
        ]);
    });

    test('the shipped defaults have no conflicts', () => {
        expect(findConflicts(DEFAULT_KEYBINDINGS)).toEqual([]);
    });

    test('ignores cleared (empty) chords', () => {
        expect(findConflicts({ a: '', b: '' })).toEqual([]);
    });
});
