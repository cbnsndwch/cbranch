import { describe, expect, test } from 'vitest';

import { parseRef, parseRefs } from './refs';

describe('parseRef (P1-UI-HIST-4; spec 10 REQ-GRAPH-013/014)', () => {
    test('detached HEAD is the head indicator', () => {
        expect(parseRef('HEAD')).toMatchObject({
            kind: 'head',
            name: 'HEAD',
            isHead: true,
        });
    });

    test('`HEAD -> main` is the current local branch', () => {
        expect(parseRef('HEAD -> main')).toMatchObject({
            kind: 'localBranch',
            name: 'main',
            isHead: true,
        });
    });

    test('`tag: v1.0` is a tag', () => {
        expect(parseRef('tag: v1.0')).toMatchObject({
            kind: 'tag',
            name: 'v1.0',
            isHead: false,
        });
    });

    test('a slashed short name is treated as a remote-tracking branch', () => {
        expect(parseRef('origin/main')).toMatchObject({
            kind: 'remoteBranch',
            name: 'origin/main',
        });
    });

    test('a bare short name is a local branch', () => {
        expect(parseRef('feature')).toMatchObject({
            kind: 'localBranch',
            name: 'feature',
            isHead: false,
        });
    });
});

describe('parseRefs ordering', () => {
    test('current-position labels sort first, then local/remote/tag by kind', () => {
        const labels = parseRefs([
            'origin/main',
            'tag: v1',
            'HEAD -> main',
            'HEAD',
        ]);
        expect(labels.map(l => l.name)).toEqual([
            'main',
            'HEAD',
            'origin/main',
            'v1',
        ]);
        expect(labels[0]!.isHead).toBe(true);
    });

    test('empty decorations yield no labels', () => {
        expect(parseRefs([])).toEqual([]);
    });
});
