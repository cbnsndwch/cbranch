import { describe, expect, test } from 'vitest';

import { containBlobPath, guessContentType, safeRev } from './side-channel';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const NUL = String.fromCharCode(0);

describe('containBlobPath (NF-SEC-5)', () => {
    test('accepts a normal repo-relative path', () => {
        expect(containBlobPath('src/app.ts')).toBe('src/app.ts');
    });

    test('normalizes backslashes and strips leading slashes', () => {
        expect(
            containBlobPath(
                `${String.fromCharCode(92)}src${String.fromCharCode(92)}app.ts`,
            ),
        ).toBe('src/app.ts');
        expect(containBlobPath('/src/app.ts')).toBe('src/app.ts');
    });

    test('allows spaces in file names', () => {
        expect(containBlobPath('my docs/read me.txt')).toBe(
            'my docs/read me.txt',
        );
    });

    test.each([
        '../etc/passwd',
        'a/../../b',
        '..',
        './x',
        '',
        'a//b',
        '.git/../x',
    ])('rejects traversal %j', p => {
        expect(containBlobPath(p)).toBeNull();
    });

    test('rejects control characters (cat-file batch injection)', () => {
        expect(containBlobPath(`a${LF}rev:b`)).toBeNull();
        expect(containBlobPath(`a${CR}b`)).toBeNull();
        expect(containBlobPath(`a${NUL}b`)).toBeNull();
    });
});

describe('safeRev (NF-SEC-6)', () => {
    test('accepts an oid or ref', () => {
        expect(safeRev('HEAD')).toBe('HEAD');
        expect(safeRev('0123abcd')).toBe('0123abcd');
    });

    test('rejects empty and control-character revs', () => {
        expect(safeRev('')).toBeNull();
        expect(safeRev(`a${LF}b`)).toBeNull();
        expect(safeRev(`a${CR}b`)).toBeNull();
        expect(safeRev(`a${NUL}b`)).toBeNull();
    });
});

describe('guessContentType (NF-SEC-11)', () => {
    test('maps known extensions', () => {
        expect(guessContentType('a.json')).toContain('application/json');
        expect(guessContentType('a.png')).toBe('image/png');
    });

    test('falls back to octet-stream for unknown extensions', () => {
        expect(guessContentType('a.unknownext')).toBe(
            'application/octet-stream',
        );
        expect(guessContentType('noext')).toBe('application/octet-stream');
    });
});
