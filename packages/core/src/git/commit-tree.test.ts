import { describe, expect, test } from 'vitest';

import { parseCommitTreePaths } from './commit-tree';

describe('parseCommitTreePaths', () => {
    test('preserves NUL-delimited paths containing spaces and newlines', () => {
        expect(
            parseCommitTreePaths(
                Buffer.from(
                    'README.md\0src/with space.ts\0notes/line\nbreak\0',
                ),
            ),
        ).toEqual(['README.md', 'src/with space.ts', 'notes/line\nbreak']);
    });

    test('rejects rather than truncates paths over the cap', () => {
        expect(parseCommitTreePaths(Buffer.from('a\0b\0c\0'), 2)).toBeNull();
    });
});
