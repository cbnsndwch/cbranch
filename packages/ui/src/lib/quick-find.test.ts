import { describe, expect, test } from 'vitest';

import { findMatches, stepMatch } from './quick-find';

const rows = [
    { oid: 'aaaa1111', subject: 'fix the parser' },
    { oid: 'bbbb2222', subject: 'add a feature' },
    { oid: 'cccc3333', subject: 'fix the build' },
];

describe('findMatches (P1-FILT-7)', () => {
    test('matches by subject, case-insensitively', () => {
        expect(findMatches(rows, 'FIX')).toEqual([0, 2]);
    });

    test('matches by hash prefix (backs jump-to-hash, P1-HIST-7)', () => {
        expect(findMatches(rows, 'bbbb')).toEqual([1]);
    });

    test('an empty or whitespace query matches nothing', () => {
        expect(findMatches(rows, '')).toEqual([]);
        expect(findMatches(rows, '   ')).toEqual([]);
    });
});

describe('stepMatch wrap-around', () => {
    test('forward wraps past the end', () => {
        expect(stepMatch(3, 2, 1)).toBe(0);
    });
    test('backward wraps past the start', () => {
        expect(stepMatch(3, 0, -1)).toBe(2);
    });
    test('from no selection, forward picks the first and backward the last', () => {
        expect(stepMatch(3, -1, 1)).toBe(0);
        expect(stepMatch(3, -1, -1)).toBe(2);
    });
    test('no matches yields -1', () => {
        expect(stepMatch(0, -1, 1)).toBe(-1);
    });
});
