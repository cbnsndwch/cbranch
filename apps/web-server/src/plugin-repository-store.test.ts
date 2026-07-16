import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
    FIRST_PARTY_PLUGIN_REGISTRY_URL,
    makePluginRepositoryStore,
    PLUGIN_REPOSITORY_FILE_NAME,
} from './plugin-repository-store';

describe('plugin repository store', () => {
    test('includes the first-party registry for a new installation', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-repository-'),
        );
        const store = makePluginRepositoryStore({ dataDirectory });

        await expect(store.list()).resolves.toMatchObject([
            {
                repository: {
                    id: 'cbranch-official',
                    kind: 'https',
                    url: FIRST_PARTY_PLUGIN_REGISTRY_URL,
                    trustState: 'untrusted',
                },
            },
        ]);
    });

    test('migrates existing registry files to include the first-party source', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-repository-'),
        );
        await writeFile(
            join(dataDirectory, PLUGIN_REPOSITORY_FILE_NAME),
            JSON.stringify({ version: 1, repositories: [] }),
        );

        await expect(
            makePluginRepositoryStore({ dataDirectory }).list(),
        ).resolves.toMatchObject([
            { repository: { url: FIRST_PARTY_PLUGIN_REGISTRY_URL } },
        ]);
    });

    test('does not restore the default after a user removes it', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-repository-'),
        );
        const store = makePluginRepositoryStore({ dataDirectory });
        const [repository] = await store.list();

        await store.remove(repository!.repository.id);

        await expect(
            makePluginRepositoryStore({ dataDirectory }).list(),
        ).resolves.toEqual([]);
    });

    test('persists explicit publisher trust and public root metadata privately', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-repository-'),
        );
        const store = makePluginRepositoryStore({ dataDirectory });
        const repository = await store.add(
            'https',
            'https://plugins.example.test',
        );
        const trusted = await store.trust(
            repository.id,
            'sha256:publisher',
            new TextEncoder().encode('root metadata'),
        );

        expect(trusted.trustState).toBe('trusted');
        expect(
            (await store.list()).find(
                entry => entry.repository.id === repository.id,
            )?.root,
        ).toBe(Buffer.from('root metadata').toString('base64'));
        expect(
            (await stat(join(dataDirectory, PLUGIN_REPOSITORY_FILE_NAME)))
                .mode & 0o777,
        ).toBe(0o600);
        expect(
            await readFile(
                join(dataDirectory, PLUGIN_REPOSITORY_FILE_NAME),
                'utf8',
            ),
        ).not.toContain('plugin-secret:');
    });
});
