import { type LogQuery } from '@cbranch/rpc-contract';
import {
    LogQuery as LogQueryClass,
    RepoId as RepoIdBrand,
} from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import {
    buildLogArgs,
    cappedLimit,
    decodeLogCursor,
    encodeLogCursor,
    LOG_WINDOW_CAP,
    nextLogCursor,
    parseCommitSummaries,
} from './history';

const repoId = RepoIdBrand.make('a'.repeat(64));
const query = (
    over: Partial<ConstructorParameters<typeof LogQueryClass>[0]>,
): LogQuery => new LogQueryClass({ repoId, limit: 50, ...over });

describe('cappedLimit', () => {
    test('caps at the server window and defaults non-positive limits', () => {
        expect(cappedLimit(10)).toBe(10);
        expect(cappedLimit(10_000)).toBe(LOG_WINDOW_CAP);
        expect(cappedLimit(0)).toBe(LOG_WINDOW_CAP);
        expect(cappedLimit(-5)).toBe(LOG_WINDOW_CAP);
    });
});

describe('log cursor codec', () => {
    test('round-trips skip + boundary oid through an opaque token', () => {
        const token = encodeLogCursor(40, 'deadbeef');
        expect(typeof token).toBe('string');
        expect(decodeLogCursor(token)).toEqual({ skip: 40, oid: 'deadbeef' });
    });

    test('treats absent/garbage cursors as the start of the traversal', () => {
        expect(decodeLogCursor(undefined)).toBeNull();
        expect(decodeLogCursor('')).toBeNull();
        expect(decodeLogCursor('not-base64-json!!')).toBeNull();
    });
});

describe('buildLogArgs', () => {
    test('fixes topo+date ordering and the format, applies window + skip', () => {
        const args = buildLogArgs(
            query({ limit: 5, cursor: encodeLogCursor(10, 'x') }),
        );
        expect(args).toContain('--topo-order');
        expect(args).toContain('--date-order');
        expect(args).toContain('--parents');
        expect(args).toContain('-z');
        expect(args).toContain('--max-count=5');
        expect(args).toContain('--skip=10');
        expect(args[args.length - 1]).toBe('HEAD'); // default "current" scope
    });

    test('maps refScope + filters to the documented flags (=form is injection-safe)', () => {
        const args = buildLogArgs(
            query({
                refScope: 'all',
                author: 'alice',
                grep: 'fix',
                since: '2023-01-01',
                until: '2023-12-31',
                path: 'src/x.ts',
            }),
        );
        expect(args).toContain('--all');
        expect(args).toContain('--author=alice');
        expect(args).toContain('--grep=fix');
        expect(args).toContain('--regexp-ignore-case');
        expect(args).toContain('--since=2023-01-01');
        expect(args).toContain('--until=2023-12-31');
        expect(args.slice(-2)).toEqual(['--', 'src/x.ts']);
    });

    test('pattern scope maps to --glob', () => {
        expect(
            buildLogArgs(
                query({ refScope: 'pattern', refPattern: 'release/*' }),
            ),
        ).toContain('--glob=release/*');
    });
});

describe('nextLogCursor', () => {
    test('advances skip by rows received', () => {
        const rows = parseCommitSummaries(
            Buffer.from(
                'o1\x1f\x1fan\x1fae\x1fad\x1fcd\x1f\x1fsubject\0',
                'utf8',
            ),
        );
        const cursor = nextLogCursor(
            query({ cursor: encodeLogCursor(2, 'prev') }),
            rows,
        );
        expect(decodeLogCursor(cursor ?? undefined)).toEqual({
            skip: 3,
            oid: 'o1',
        });
    });

    test('no continuation cursor for an empty window', () => {
        expect(nextLogCursor(query({}), [])).toBeNull();
    });
});

describe('parseCommitSummaries', () => {
    test('parses ordered parents and decorations from a NUL/US record', () => {
        const rec =
            [
                'c2',
                'p1 p0',
                'Ann',
                'a@x',
                '2023-01-02T00:00:00Z',
                '2023-01-02T00:00:00Z',
                'HEAD -> main, tag: v1',
                'subj, with comma',
            ].join('\x1f') + '\0';
        const rows = parseCommitSummaries(Buffer.from(rec, 'utf8'));
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.oid).toBe('c2');
        expect(row.parents).toEqual(['p1', 'p0']);
        expect(row.authorName).toBe('Ann');
        expect(row.authorDate).toBe('2023-01-02T00:00:00Z');
        expect(row.refs).toEqual(['HEAD -> main', 'tag: v1']);
        expect(row.subject).toBe('subj, with comma');
    });

    test('root commit has no parents and no decorations', () => {
        const rec =
            ['root', '', 'Ann', 'a@x', 'd', 'd', '', 'init'].join('\x1f') +
            '\0';
        const row = parseCommitSummaries(Buffer.from(rec, 'utf8'))[0]!;
        expect(row.parents).toEqual([]);
        expect(row.refs).toEqual([]);
    });
});
