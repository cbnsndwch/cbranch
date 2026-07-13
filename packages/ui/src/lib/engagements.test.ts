import { describe, expect, test } from 'vitest';

import { moveWorkspaceId, workspaceSlugFromName } from './engagements';

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

describe('workspaceSlugFromName', () => {
    test('creates a URL-safe fallback for punctuation and non-ASCII-only names', () => {
        expect(workspaceSlugFromName('Acme Platform!')).toBe('acme-platform');
        expect(workspaceSlugFromName('Caf\u00e9')).toBe('cafe');
        expect(workspaceSlugFromName('\u6771\u4eac')).toBe('workspace');
    });
});
