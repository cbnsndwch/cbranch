import { PluginRepositoryId } from '@cbranch/plugin-contract';
import { describe, expect, test } from 'vitest';

import { makeProcessCredentialStore } from './plugin-credentials';

describe('process plugin credential store', () => {
    test('returns an opaque reference and retains credentials only in process memory', async () => {
        const store = makeProcessCredentialStore();
        const repositoryId = PluginRepositoryId.make('repository-1');
        const token = 'private-token-value';

        const reference = await store.replace(repositoryId, token);

        expect(store.persistent).toBe(false);
        expect(reference).toMatch(/^plugin-secret:/);
        expect(reference).not.toContain(token);
        expect(await store.get(repositoryId)).toBe(token);
    });

    test('replaces and removes the credential keyed to a repository id', async () => {
        const store = makeProcessCredentialStore();
        const repositoryId = PluginRepositoryId.make('repository-1');

        const first = await store.replace(repositoryId, 'first-token');
        const second = await store.replace(repositoryId, 'second-token');

        expect(second).not.toBe(first);
        expect(await store.get(repositoryId)).toBe('second-token');
        await store.remove(repositoryId);
        expect(await store.get(repositoryId)).toBeUndefined();
    });
});
