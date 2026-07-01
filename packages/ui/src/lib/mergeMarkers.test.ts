import { describe, expect, test } from 'vitest';

import {
    applyResolution,
    detectEol,
    fromWorkingText,
    hasConflictMarkers,
    parseConflicts,
    toWorkingText,
    utf8ToBase64,
} from './mergeMarkers';

// Build multi-line fixtures from char codes so no literal escape ever reaches the file
// (the editor's write path JSON-decodes; a literal backslash-n would corrupt the source).
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const BOM = String.fromCharCode(0xfeff);
const join = (...xs: string[]) => xs.join(LF);

const OPEN = '<<<<<<< HEAD';
const BASE = '||||||| merged common ancestors';
const SEP = '=======';
const CLOSE = '>>>>>>> feature';

const diff3 = join(
    'context top',
    OPEN,
    'our change',
    BASE,
    'ancestor line',
    SEP,
    'their change',
    CLOSE,
    'context bottom',
);

const twoWay = join(
    'context top',
    OPEN,
    'our change',
    SEP,
    'their change',
    CLOSE,
    'context bottom',
);

describe('parseConflicts', () => {
    test('diff3 and 2-way produce identical ours/theirs hunks', () => {
        const a = parseConflicts(diff3);
        const b = parseConflicts(twoWay);
        expect(a.ambiguous).toBe(false);
        expect(b.ambiguous).toBe(false);
        expect(a.blocks).toHaveLength(1);
        expect(b.blocks).toHaveLength(1);
        expect(a.blocks[0]!.ours).toEqual(['our change']);
        expect(b.blocks[0]!.ours).toEqual(['our change']);
        expect(a.blocks[0]!.theirs).toEqual(['their change']);
        expect(b.blocks[0]!.theirs).toEqual(['their change']);
        // Only the diff3 variant carries a base section.
        expect(a.blocks[0]!.base).toEqual(['ancestor line']);
        expect(b.blocks[0]!.base).toBeUndefined();
    });

    test('an unbalanced separator with no open block is ambiguous', () => {
        const r = parseConflicts(join('plain', SEP, 'more'));
        expect(r.ambiguous).toBe(true);
        expect(r.blocks).toHaveLength(0);
    });

    test('a nested opener inside a block is ambiguous', () => {
        const r = parseConflicts(join(OPEN, 'a', OPEN, 'b', SEP, 'c', CLOSE));
        expect(r.ambiguous).toBe(true);
    });

    test('an unterminated block (EOF before closer) is ambiguous', () => {
        const r = parseConflicts(join(OPEN, 'a', SEP, 'b'));
        expect(r.ambiguous).toBe(true);
    });

    test('lines that only resemble markers are not misparsed', () => {
        // 6 equals (not 7); 7 '<' with no trailing space; 7 equals with trailing space.
        const r = parseConflicts(
            join('======', '<<<<<<<nope', '======= ', 'regular code'),
        );
        expect(r.ambiguous).toBe(false);
        expect(r.blocks).toHaveLength(0);
    });

    test('parses multiple blocks and re-indexes after resolving one', () => {
        const two = join(
            'top',
            OPEN,
            'ours1',
            SEP,
            'theirs1',
            CLOSE,
            'mid',
            OPEN,
            'ours2',
            SEP,
            'theirs2',
            CLOSE,
            'bottom',
        );
        const r = parseConflicts(two);
        expect(r.blocks).toHaveLength(2);
        // the second block's span follows the first (loop continuation past endLine).
        expect(r.blocks[1]!.startLine).toBeGreaterThan(r.blocks[0]!.endLine);
        // resolve the SECOND block by its non-zero index without touching the first.
        expect(applyResolution(two, 1, 'ours')).toBe(
            join(
                'top',
                OPEN,
                'ours1',
                SEP,
                'theirs1',
                CLOSE,
                'mid',
                'ours2',
                'bottom',
            ),
        );
        // after resolving block 0, the remaining block re-indexes to position 0.
        const afterFirst = applyResolution(two, 0, 'theirs');
        expect(parseConflicts(afterFirst).blocks).toHaveLength(1);
        expect(applyResolution(afterFirst, 0, 'ours')).toBe(
            join('top', 'theirs1', 'mid', 'ours2', 'bottom'),
        );
    });
});

describe('applyResolution', () => {
    const cases: Array<[Parameters<typeof applyResolution>[2], string[]]> = [
        ['ours', ['context top', 'our change', 'context bottom']],
        ['theirs', ['context top', 'their change', 'context bottom']],
        [
            'both',
            ['context top', 'our change', 'their change', 'context bottom'],
        ],
        [
            'both-reversed',
            ['context top', 'their change', 'our change', 'context bottom'],
        ],
        ['base', ['context top', 'ancestor line', 'context bottom']],
    ];
    for (const [choice, expected] of cases)
        test(`accept ${choice} splices the chosen side`, () => {
            expect(applyResolution(diff3, 0, choice)).toBe(join(...expected));
        });

    test('base on a 2-way block (no base) collapses to nothing', () => {
        expect(applyResolution(twoWay, 0, 'base')).toBe(
            join('context top', 'context bottom'),
        );
    });

    test('out-of-range / ambiguous input is a no-op', () => {
        expect(applyResolution(diff3, 5, 'ours')).toBe(diff3);
        const ambiguous = join(OPEN, 'x');
        expect(applyResolution(ambiguous, 0, 'ours')).toBe(ambiguous);
    });
});

describe('hasConflictMarkers', () => {
    test('true while a marker line remains, false once resolved', () => {
        expect(hasConflictMarkers(diff3)).toBe(true);
        expect(hasConflictMarkers(applyResolution(diff3, 0, 'theirs'))).toBe(
            false,
        );
    });
});

describe('byte fidelity (EOL + BOM round-trip)', () => {
    const body = ['a', 'b', 'c'];
    const variants: Array<[string, string]> = [
        ['LF, no BOM', body.join(LF)],
        ['CRLF, no BOM', body.join(CRLF)],
        ['LF + BOM', BOM + body.join(LF)],
        ['CRLF + BOM', BOM + body.join(CRLF)],
    ];
    for (const [name, raw] of variants)
        test(`${name} survives toWorkingText → fromWorkingText`, () => {
            const wt = toWorkingText(raw);
            // The editable view is always LF-normalized and BOM-stripped.
            expect(wt.working.includes(String.fromCharCode(13))).toBe(false);
            expect(wt.working.charCodeAt(0)).not.toBe(0xfeff);
            expect(fromWorkingText(wt.working, wt.bom, wt.eol)).toBe(raw);
        });

    test('detectEol picks CRLF when it dominates', () => {
        expect(detectEol(body.join(CRLF))).toBe(CRLF);
        expect(detectEol(body.join(LF))).toBe(LF);
    });

    test('detectEol resolves a tie to CRLF but yields to a lone-LF majority', () => {
        expect(detectEol('a' + CRLF + 'b' + LF + 'c')).toBe(CRLF); // 1 crlf, 1 lone lf
        expect(detectEol('a' + CRLF + 'b' + LF + 'c' + LF + 'd')).toBe(LF); // 1 vs 2
    });
});

describe('utf8ToBase64', () => {
    test('encodes utf-8 bytes (multibyte safe)', () => {
        const text = 'héllo ' + String.fromCodePoint(0x1f600); // 4-byte astral char
        const decoded = new TextDecoder().decode(
            Uint8Array.from(atob(utf8ToBase64(text)), c => c.charCodeAt(0)),
        );
        expect(decoded).toBe(text);
    });
});
