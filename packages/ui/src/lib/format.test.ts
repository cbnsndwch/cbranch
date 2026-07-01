import { describe, expect, test } from 'vitest';

import {
    formatDate,
    formatInstant,
    formatRelativeMs,
    shortOid,
} from './format';

const NOW = Date.UTC(2024, 0, 10, 0, 0, 0);

describe('shortOid', () => {
    test('abbreviates to 8 chars', () => {
        expect(shortOid('0123456789abcdef')).toBe('01234567');
    });
});

describe('formatRelativeMs (P1-HIST-8)', () => {
    test('renders coarse past distances', () => {
        expect(formatRelativeMs(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
        expect(formatRelativeMs(NOW - 2 * 3_600_000, NOW)).toBe('2 hours ago');
    });

    test("sub-second is 'just now'", () => {
        expect(formatRelativeMs(NOW, NOW)).toBe('just now');
    });

    test('invalid input is empty', () => {
        expect(formatRelativeMs(Number.NaN, NOW)).toBe('');
    });
});

describe('formatDate / formatInstant honor the mode (P1-HIST-8)', () => {
    test('relative mode returns a relative string; absolute mode does not', () => {
        const iso = new Date(NOW - 86_400_000).toISOString();
        expect(formatDate(iso, 'relative', NOW)).toBe('yesterday');
        expect(formatDate(iso, 'absolute', NOW)).not.toContain('ago');
    });

    test('formatInstant maps epoch seconds through the mode', () => {
        const epoch = Math.floor((NOW - 86_400_000) / 1000);
        expect(formatInstant(epoch, 'relative', NOW)).toBe('yesterday');
    });
});
