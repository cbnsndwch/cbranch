import { PluginCatalogEntry, PluginId } from '@cbranch/plugin-contract';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const verifyTufCatalog = vi.hoisted(() => vi.fn());

vi.mock('@cbranch/plugin-runtime', async importOriginal => ({
    ...(await importOriginal<typeof import('@cbranch/plugin-runtime')>()),
    verifyTufCatalog,
}));

import { makeTufPluginRepository } from './tuf-plugin-repository';

const target = new PluginCatalogEntry({
    pluginId: PluginId.make('com.example.release'),
    version: '1.2.3',
    publisherFingerprint: 'sha256:publisher',
    artifactPath: 'targets/release.cbranch-plugin',
    artifactSha256: `sha256:${'a'.repeat(64)}`,
    artifactLength: 1,
    minimumCbranchVersion: '0.2.4',
    pluginContractVersion: 1,
    capabilityDigest: `sha256:${'b'.repeat(64)}`,
    releaseNotes: '',
    advisoryIds: [],
});

describe('TUF plugin repository', () => {
    beforeEach(() => verifyTufCatalog.mockReset());

    test('rejects a cached target as soon as verified metadata expires', async () => {
        let now = 100;
        const fetchTarget = vi.fn(async () => new Uint8Array([1]));
        const stage = vi.fn(async () => '/tmp/plugin');
        verifyTufCatalog.mockResolvedValue({
            entries: [target],
            targetsVersion: 7,
            expiresAt: 200,
        });
        const repository = makeTufPluginRepository({
            root: new Uint8Array([1]),
            publisherFingerprint: target.publisherFingerprint,
            transport: {
                fetchMetadata: async () => new Uint8Array([1]),
                fetchTarget,
            },
            artifactStore: {
                stage,
                review: vi.fn(),
                activate: vi.fn(),
                remove: vi.fn(),
            },
            verifySignature: async () => true,
            now: () => now,
        });
        await repository.refresh();

        now = 201;
        await expect(
            repository.stage(String(target.pluginId), target.version),
        ).rejects.toMatchObject({ code: 'pluginMetadataExpired' });
        expect(fetchTarget).not.toHaveBeenCalled();
        expect(stage).not.toHaveBeenCalled();
    });

    test('discards the prior catalog before a failed refresh', async () => {
        let failRefresh = false;
        verifyTufCatalog.mockResolvedValue({
            entries: [target],
            targetsVersion: 7,
            expiresAt: 200,
        });
        const repository = makeTufPluginRepository({
            root: new Uint8Array([1]),
            publisherFingerprint: target.publisherFingerprint,
            transport: {
                fetchMetadata: async () => {
                    if (failRefresh) throw new Error('network unavailable');
                    return new Uint8Array([1]);
                },
                fetchTarget: async () => new Uint8Array([1]),
            },
            artifactStore: {
                stage: vi.fn(),
                review: vi.fn(),
                activate: vi.fn(),
                remove: vi.fn(),
            },
            verifySignature: async () => true,
            now: () => 100,
        });
        await repository.refresh();

        failRefresh = true;
        await expect(repository.refresh()).rejects.toThrow(
            'network unavailable',
        );
        await expect(
            repository.stage(String(target.pluginId), target.version),
        ).rejects.toMatchObject({ code: 'pluginMetadataInvalid' });
    });
});
