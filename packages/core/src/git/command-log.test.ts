import { afterEach, describe, expect, test } from 'vitest';

import {
    COMMAND_LOG_CAPACITY,
    listInvocations,
    recordInvocation,
    redactSecret,
    resetCommandLog,
    subscribeInvocations,
} from './command-log';

const base = {
    cwd: '/repo',
    startedAt: 1000,
    durationMs: 5,
    exitCode: 0,
    success: true,
};

afterEach(() => resetCommandLog());

describe('command log ring buffer', () => {
    test('lists newest-first and assigns monotonic seq', () => {
        recordInvocation({ ...base, argv: ['status'] });
        recordInvocation({ ...base, argv: ['log'] });
        const rows = listInvocations();
        expect(rows.map(r => r.argv[0])).toEqual(['log', 'status']);
        expect(rows[0]!.seq).toBeGreaterThan(rows[1]!.seq);
    });

    test('caps the buffer at the fixed capacity (oldest age out)', () => {
        for (let i = 0; i < COMMAND_LOG_CAPACITY + 50; i++)
            recordInvocation({ ...base, argv: [`c${i}`] });
        const rows = listInvocations();
        expect(rows).toHaveLength(COMMAND_LOG_CAPACITY);
        // The very first entries have aged out.
        expect(rows.some(r => r.argv[0] === 'c0')).toBe(false);
    });

    test('a predicate filters and limit caps the result', () => {
        recordInvocation({ ...base, cwd: '/a', argv: ['x'] });
        recordInvocation({ ...base, cwd: '/b', argv: ['y'] });
        recordInvocation({ ...base, cwd: '/a', argv: ['z'] });
        const onlyA = listInvocations(r => r.cwd === '/a');
        expect(onlyA.map(r => r.argv[0])).toEqual(['z', 'x']);
        expect(listInvocations(undefined, 1)).toHaveLength(1);
    });

    test('failed records carry a bounded, scrubbed stderr excerpt', () => {
        recordInvocation({
            ...base,
            exitCode: 1,
            success: false,
            argv: ['push', 'https://alice:secret@example.com/r.git'],
            stderrExcerpt:
                'fatal: https://alice:secret@example.com/r.git denied',
        });
        const rec = listInvocations()[0]!;
        // Both argv and the excerpt have the password redacted (REQ-P6-CLOG-003).
        expect(rec.argv[1]).toBe('https://alice:***@example.com/r.git');
        expect(rec.stderrExcerpt).toContain('alice:***@');
        expect(rec.stderrExcerpt).not.toContain('secret');
    });

    test('subscribers receive new records until unsubscribed', () => {
        const seen: string[] = [];
        const unsub = subscribeInvocations(r => seen.push(r.argv[0]!));
        recordInvocation({ ...base, argv: ['a'] });
        unsub();
        recordInvocation({ ...base, argv: ['b'] });
        expect(seen).toEqual(['a']);
    });
});

describe('redactSecret', () => {
    test('scrubs URL userinfo passwords across schemes', () => {
        expect(redactSecret('ssh://u:p@h/x')).toBe('ssh://u:***@h/x');
        expect(redactSecret('https://tok:pw@github.com/o/r.git')).toBe(
            'https://tok:***@github.com/o/r.git',
        );
        expect(redactSecret('nothing to see')).toBe('nothing to see');
    });
});
