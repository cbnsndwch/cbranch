import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginId } from '@cbranch/plugin-contract';
import { describe, expect, test } from 'vitest';

import { makePluginArtifactStore } from './plugin-artifact-store';

const artifact = new TextEncoder().encode('verified plugin archive');
const sha256 = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
const target = {
    pluginId: PluginId.make('com.example.release'),
    version: '1.2.3',
    artifactLength: artifact.byteLength,
    artifactSha256: sha256,
};

describe('plugin artifact store', () => {
    test('atomically stores only a digest-verified artifact with owner-only mode', async () => {
        const directory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-artifact-'),
        );
        const store = makePluginArtifactStore({ dataDirectory: directory });

        const path = await store.stage(target, artifact);

        expect(await readFile(path)).toEqual(Buffer.from(artifact));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(path).toBe(
            join(
                directory,
                'artifacts',
                'com.example.release',
                '1.2.3.cbranch-plugin',
            ),
        );
    });

    test('rejects substituted bytes before they create an artifact file', async () => {
        const directory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-artifact-'),
        );
        const store = makePluginArtifactStore({ dataDirectory: directory });

        await expect(store.stage(target, new Uint8Array([0]))).rejects.toThrow(
            'digest',
        );
        await expect(
            access(
                join(
                    directory,
                    'artifacts',
                    'com.example.release',
                    '1.2.3.cbranch-plugin',
                ),
            ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('rejects an oversized target before writing artifact bytes', async () => {
        const directory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-artifact-'),
        );
        const store = makePluginArtifactStore({ dataDirectory: directory });

        await expect(
            store.stage(
                { ...target, artifactLength: 51 * 1024 * 1024 },
                artifact,
            ),
        ).rejects.toThrow('compressed size limit');
    });
});
