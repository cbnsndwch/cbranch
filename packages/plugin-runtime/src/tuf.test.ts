import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { verifyTufCatalog } from './tuf';

const bytes = (value: unknown): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(value));
const digest = (value: Uint8Array): string =>
    createHash('sha256').update(value).digest('hex');
const envelope = (signed: unknown) => ({
    signed,
    signatures: [{ keyid: 'key-1', sig: 'signature' }],
});

describe('TUF catalog verification', () => {
    test('verifies the root to targets chain before returning catalog entries', async () => {
        const expires = new Date(Date.now() + 60_000).toISOString();
        const targets = bytes(
            envelope({
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
                version: 1,
                expires,
                meta: {
                    'targets.json': {
                        length: targets.byteLength,
                        hashes: { sha256: digest(targets) },
                    },
                },
            }),
        );
        const timestamp = bytes(
            envelope({
                version: 1,
                expires,
                meta: {
                    'snapshot.json': {
                        length: snapshot.byteLength,
                        hashes: { sha256: digest(snapshot) },
                    },
                },
            }),
        );
        const root = bytes(
            envelope({
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
                { root, timestamp, snapshot, targets },
                async () => true,
            ),
        ).resolves.toMatchObject([
            {
                pluginId: 'com.example.release',
                artifactSha256: `sha256:${'a'.repeat(64)}`,
            },
        ]);
    });

    test('rejects changed metadata and insufficient signatures', async () => {
        const expired = new Date(Date.now() - 60_000).toISOString();
        const root = bytes(
            envelope({
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
                async () => false,
            ),
        ).rejects.toThrow('threshold');
    });
});
