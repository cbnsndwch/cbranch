import { describe, expect, test } from 'vitest';

import { readThemePref, resolveDark } from './theme';

describe('resolveDark', () => {
    test('explicit light/dark ignore the OS preference', () => {
        expect(resolveDark('dark', false)).toBe(true);
        expect(resolveDark('light', true)).toBe(false);
    });

    test('system follows the OS preference', () => {
        expect(resolveDark('system', true)).toBe(true);
        expect(resolveDark('system', false)).toBe(false);
    });
});

describe('readThemePref', () => {
    test("falls back to 'system' when storage is unavailable", () => {
        expect(readThemePref()).toBe('system');
    });
});
