import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
    makePluginRepositoryStore,
    PLUGIN_REPOSITORY_FILE_NAME,
} from './plugin-repository-store';

describe('plugin repository store', () => {
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
        expect((await store.list())[0]?.root).toBe(
            Buffer.from('root metadata').toString('base64'),
        );
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
