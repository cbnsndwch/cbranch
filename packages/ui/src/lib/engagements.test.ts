import { describe, expect, test } from 'vitest';

import { moveWorkspaceId } from './engagements';

describe('moveWorkspaceId', () => {
    test('moves a workspace before the drop target without mutating the source order', () => {
        const ids = ['client-a', 'client-b', 'internal'];
        expect(moveWorkspaceId(ids, 'internal', 'client-a')).toEqual([
            'internal',
            'client-a',
            'client-b',
        ]);
        expect(ids).toEqual(['client-a', 'client-b', 'internal']);
    });
});
