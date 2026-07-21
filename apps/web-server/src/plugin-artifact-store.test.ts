import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import { PluginId, type PluginManifest } from '@cbranch/plugin-contract';
import { digestManifestCapabilities } from '@cbranch/plugin-runtime';
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

    test('materializes a verified ESM artifact atomically into its activation root', async () => {
        const directory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-artifact-'),
        );
        const manifest: PluginManifest = {
            schemaVersion: 1,
            id: PluginId.make('com.example.release'),
            version: '1.2.3',
            displayName: 'Release',
            publisherFingerprint: 'sha256:publisher',
            engines: { cbranch: '>=0.2.0 <1.0.0', pluginContract: 1 },
            runtime: 'trusted-esm',
            entrypoint: 'plugin.mjs',
            capabilities: [],
            automation: [],
            contributes: { commands: [], panels: [] },
        };
        const archive = zstdCompressSync(
            makeTar({
                'plugin.json': JSON.stringify(manifest),
                'plugin.mjs': 'export default () => ({ commands: {} });',
            }),
        );
        const activationTarget = {
            pluginId: manifest.id,
            version: manifest.version,
            publisherFingerprint: manifest.publisherFingerprint,
            artifactPath: 'release.cbranch-plugin',
            artifactSha256: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
            artifactLength: archive.byteLength,
            minimumCbranchVersion: '0.2.0',
            pluginContractVersion: 1,
            capabilityDigest: await digestManifestCapabilities(manifest),
            releaseNotes: '',
            advisoryIds: [],
        };
        const store = makePluginArtifactStore({ dataDirectory: directory });

        await store.stage(activationTarget, archive);
        await expect(store.review(activationTarget)).resolves.toMatchObject({
            displayName: 'Release',
            capabilities: [],
            contributes: { commands: [], panels: [] },
        });
        const activated = await store.activate(activationTarget, {
            capabilities: [],
            repositoryIds: [],
            networkOrigins: [],
            automationActionIds: [],
            hostAutomationApproved: false,
        });

        expect(await readFile(activated.entrypoint, 'utf8')).toContain(
            'export default',
        );
        expect((await stat(activated.directory)).mode & 0o777).toBe(0o700);
        await expect(
            store.activate(activationTarget, {
                capabilities: [],
                repositoryIds: [],
                networkOrigins: [],
                automationActionIds: [],
                hostAutomationApproved: false,
            }),
        ).resolves.toEqual(activated);
    });
});

const makeTar = (files: Readonly<Record<string, string>>): Uint8Array => {
    const entries = Object.entries(files).flatMap(([path, contents]) => {
        const bytes = new TextEncoder().encode(contents);
        const header = new Uint8Array(512);
        writeTarString(header, 0, 100, path);
        writeTarString(header, 100, 8, '0000600');
        writeTarString(header, 124, 12, bytes.byteLength.toString(8));
        header[156] = '0'.charCodeAt(0);
        writeTarString(
            header,
            148,
            8,
            header
                .reduce(
                    (sum, byte, index) =>
                        sum + (index >= 148 && index < 156 ? 32 : byte),
                    0,
                )
                .toString(8),
        );
        return [
            header,
            bytes,
            new Uint8Array((512 - (bytes.byteLength % 512)) % 512),
        ];
    });
    return concat([...entries, new Uint8Array(1024)]);
};

const writeTarString = (
    destination: Uint8Array,
    start: number,
    length: number,
    value: string,
): void => {
    destination.set(new TextEncoder().encode(value), start);
    destination[start + length - 1] = 0;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
    const result = new Uint8Array(
        parts.reduce((length, part) => length + part.byteLength, 0),
    );
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
};
