import { createHash } from 'node:crypto';

import { PluginCatalogEntry } from '@cbranch/plugin-contract';
import { describe, expect, test } from 'vitest';

import { verifyTufCatalog } from './tuf';

const bytes = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));
const digest = (value: Uint8Array): string =>
    createHash('sha256').update(value).digest('hex');
const envelope = (
    signed: unknown,
    signatures = [{ keyid: 'key-1', sig: 'signature' }],
) => ({
    signed,
    signatures,
});

describe('TUF catalog verification', () => {
    test('verifies the root to targets chain before returning catalog entries', async () => {
        const expires = new Date(Date.now() + 60_000).toISOString();
        const targets = bytes(
            envelope({
                _type: 'targets',
                version: 1,
                expires,
                targets: {
                    'targets/com.example.release/1.2.3/release.cbranch-plugin':
                        {
                            length: 4,
                            hashes: { sha256: 'a'.repeat(64) },
                            custom: {
                                pluginId: 'com.example.release',
                                version: '1.2.3',
                                publisherFingerprint: 'sha256:publisher',
                                minimumCbranchVersion: '0.2.0',
                                pluginContractVersion: 1,
                                capabilityDigest: 'sha256:capabilities',
                                releaseNotes: 'Release',
                                advisoryIds: [],
                            },
                        },
                },
            }),
        );
        const snapshot = bytes(
            envelope({
                _type: 'snapshot',
                version: 1,
                expires,
                meta: {
                    'targets.json': {
                        version: 1,
                        length: targets.byteLength,
                        hashes: { sha256: digest(targets) },
                    },
                },
            }),
        );
        const timestamp = bytes(
            envelope({
                _type: 'timestamp',
                version: 1,
                expires,
                meta: {
                    'snapshot.json': {
                        version: 1,
                        length: snapshot.byteLength,
                        hashes: { sha256: digest(snapshot) },
                    },
                },
            }),
        );
        const root = bytes(
            envelope(
                {
                    _type: 'root',
                    version: 1,
                    expires,
                    keys: {
                        'key-1': {
                            keytype: 'ed25519',
                            keyval: { public: 'a'.repeat(64) },
                        },
                    },
                    roles: {
                        root: { keyids: ['key-1'], threshold: 1 },
                        timestamp: { keyids: ['key-1'], threshold: 1 },
                        snapshot: { keyids: ['key-1'], threshold: 1 },
                        targets: { keyids: ['key-1'], threshold: 1 },
                    },
                },
                [
                    { keyid: 'key-1', sig: 'invalid' },
                    { keyid: 'key-1', sig: 'signature' },
                ],
            ),
        );

        const catalog = await verifyTufCatalog(
            { root, timestamp, snapshot, targets },
            async (_key, _signed, signature) => signature !== 'invalid',
        );
        expect(catalog.entries).toMatchObject([
            {
                pluginId: 'com.example.release',
                artifactSha256: `sha256:${'a'.repeat(64)}`,
            },
        ]);
        expect(catalog.targetsVersion).toBe(1);
        expect(catalog.entries[0]).toBeInstanceOf(PluginCatalogEntry);
    });

    test('rejects changed metadata and insufficient signatures', async () => {
        const expired = new Date(Date.now() - 60_000).toISOString();
        const root = bytes(
            envelope({
                _type: 'root',
                version: 1,
                expires: expired,
                keys: {
                    'key-1': {
                        keytype: 'ed25519',
                        keyval: { public: 'a'.repeat(64) },
                    },
                },
                roles: {
                    root: { keyids: ['key-1'], threshold: 1 },
                    timestamp: { keyids: ['key-1'], threshold: 1 },
                    snapshot: { keyids: ['key-1'], threshold: 1 },
                    targets: { keyids: ['key-1'], threshold: 1 },
                },
            }),
        );
        await expect(
            verifyTufCatalog(
                { root, timestamp: root, snapshot: root, targets: root },
                async () => true,
            ),
        ).rejects.toThrow('expired');
        await expect(
            verifyTufCatalog(
                { root, timestamp: root, snapshot: root, targets: root },
                async () => false,
            ),
        ).rejects.toThrow('threshold');
    });

    test('rejects zero thresholds and nonpositive metadata versions', async () => {
        const expires = new Date(Date.now() + 60_000).toISOString();
        const rootValue = {
            _type: 'root',
            version: 1,
            expires,
            keys: {},
            roles: {
                root: { keyids: [], threshold: 0 },
                timestamp: { keyids: [], threshold: 0 },
                snapshot: { keyids: [], threshold: 0 },
                targets: { keyids: [], threshold: 0 },
            },
        };
        const unsignedRoot = bytes({ signed: rootValue, signatures: [] });
        await expect(
            verifyTufCatalog(
                {
                    root: unsignedRoot,
                    timestamp: unsignedRoot,
                    snapshot: unsignedRoot,
                    targets: unsignedRoot,
                },
                async () => true,
            ),
        ).rejects.toThrow('threshold is malformed');

        const invalidVersion = bytes(
            envelope({
                ...rootValue,
                version: 0,
                keys: {
                    'key-1': {
                        keytype: 'ed25519',
                        keyval: { public: 'a'.repeat(64) },
                    },
                },
                roles: {
                    root: { keyids: ['key-1'], threshold: 1 },
                    timestamp: { keyids: ['key-1'], threshold: 1 },
                    snapshot: { keyids: ['key-1'], threshold: 1 },
                    targets: { keyids: ['key-1'], threshold: 1 },
                },
            }),
        );
        await expect(
            verifyTufCatalog(
                {
                    root: invalidVersion,
                    timestamp: invalidVersion,
                    snapshot: invalidVersion,
                    targets: invalidVersion,
                },
                async () => true,
            ),
        ).rejects.toThrow('root version');
    });

    test('rejects metadata with the wrong signed role type', async () => {
        const expires = new Date(Date.now() + 60_000).toISOString();
        const root = bytes(
            envelope({
                _type: 'targets',
                version: 1,
                expires,
                keys: {
                    'key-1': {
                        keytype: 'ed25519',
                        keyval: { public: 'a'.repeat(64) },
                    },
                },
                roles: {
                    root: { keyids: ['key-1'], threshold: 1 },
                    timestamp: { keyids: ['key-1'], threshold: 1 },
                    snapshot: { keyids: ['key-1'], threshold: 1 },
                    targets: { keyids: ['key-1'], threshold: 1 },
                },
            }),
        );
        await expect(
            verifyTufCatalog(
                { root, timestamp: root, snapshot: root, targets: root },
                async () => true,
            ),
        ).rejects.toThrow('invalid role type');
    });
});
