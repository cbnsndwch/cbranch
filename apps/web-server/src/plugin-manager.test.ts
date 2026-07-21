import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
    InstalledPlugin,
    PluginId,
    PluginLockRecord,
    PluginRepositoryId,
    type PluginManifest,
} from '@cbranch/plugin-contract';
import { digestManifestCapabilities } from '@cbranch/plugin-runtime';
import { Schema } from 'effect';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { makePluginLockStore } from './plugin-lock-store';
import {
    activatedPluginDirectory,
    makeTrustedPluginManager,
} from './plugin-manager';

vi.mock('./tuf-signature-verifier', () => ({
    verifyTufEd25519Signature: async () => true,
}));

afterEach(() => vi.unstubAllGlobals());

const metadataEnvelope = (signed: unknown) => ({
    signed,
    signatures: [{ keyid: 'key-1', sig: 'signature' }],
});
const metadataBytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
const metadataDigest = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex');

const makeRecord = (
    enabled: boolean,
    pluginId = 'com.example.release',
): PluginLockRecord =>
    new PluginLockRecord({
        pluginId: PluginId.make(pluginId),
        version: '1.2.3',
        artifactSha256: `sha256:${'a'.repeat(64)}`,
        repositoryId: PluginRepositoryId.make('repository-1'),
        tufTargetVersion: 3,
        publisherFingerprint: `sha256:${'b'.repeat(64)}`,
        manifestCapabilityDigest: `sha256:${'c'.repeat(64)}`,
        grantDigest: `sha256:${'d'.repeat(64)}`,
        entrypoint: 'plugin.mjs',
        enabled,
        grant: {
            capabilities: ['ui.contribute'],
            repositoryIds: [],
            networkOrigins: [],
            automationActionIds: [],
            hostAutomationApproved: false,
        },
        contributions: {
            commands: [
                {
                    id: `${pluginId}.run`,
                    title: 'Run release check',
                    placement: 'plugins',
                },
            ],
            panels: [],
        },
    });

const materialize = async (
    dataDirectory: string,
    record: PluginLockRecord,
    source: string,
): Promise<void> => {
    const directory = activatedPluginDirectory(dataDirectory, record);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, record.entrypoint), source, 'utf8');
};

describe('trusted plugin manager', () => {
    test('adds only validated repository origins without exposing credentials', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const manager = makeTrustedPluginManager({ dataDirectory });

        await expect(
            manager.repositoryAdd(
                'https',
                'https://plugins.example.test/catalog',
            ),
        ).resolves.toMatchObject({ trustState: 'untrusted' });
        await expect(
            manager.repositoryAdd('https', 'http://plugins.example.test'),
        ).rejects.toThrow('forbidden transport');
        expect(await manager.repositoryList()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    url: 'https://plugins.example.test/catalog',
                }),
            ]),
        );
    });

    test('persists a verified activated artifact disabled until explicit enablement', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
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
        const artifactStore = {
            stage: vi.fn(),
            review: vi.fn(),
            activate: vi.fn(async () => ({
                directory: join(dataDirectory, 'activated'),
                manifest,
                entrypoint: join(dataDirectory, 'activated', 'plugin.mjs'),
            })),
            remove: vi.fn(),
        };
        const manager = makeTrustedPluginManager({
            dataDirectory,
            artifactStore,
        });

        const installed = await manager.installVerified({
            target: {
                pluginId: manifest.id,
                version: manifest.version,
                publisherFingerprint: manifest.publisherFingerprint,
                artifactPath: 'release.cbranch-plugin',
                artifactSha256: `sha256:${'a'.repeat(64)}`,
                artifactLength: 1,
                minimumCbranchVersion: '0.2.0',
                pluginContractVersion: 1,
                capabilityDigest: `sha256:${'b'.repeat(64)}`,
                releaseNotes: '',
                advisoryIds: [],
            },
            repositoryId: PluginRepositoryId.make('repository-1'),
            tufTargetVersion: 3,
            grant: {
                capabilities: [],
                repositoryIds: [],
                networkOrigins: [],
                automationActionIds: [],
                hostAutomationApproved: false,
            },
        });

        expect(installed.enabled).toBe(false);
        expect(installed).toBeInstanceOf(InstalledPlugin);
        expect(() =>
            Schema.encodeUnknownSync(InstalledPlugin)(installed),
        ).not.toThrow();
        expect((await manager.list())[0]?.lock.entrypoint).toBe('plugin.mjs');
        expect(artifactStore.activate).toHaveBeenCalledOnce();
        expect((await manager.auditList({})).events[0]?.action).toBe('install');
    });

    test('completes the HTTPS/TUF review, install, and enable lifecycle', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
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
            capabilities: ['ui.contribute'],
            automation: [],
            contributes: {
                commands: [
                    {
                        id: 'com.example.release.run',
                        title: 'Run release',
                        placement: 'plugins',
                    },
                ],
                panels: [],
            },
        };
        const artifact = zstdCompressSync(
            makeTar({
                'plugin.json': JSON.stringify(manifest),
                'plugin.mjs':
                    "export default () => ({ commands: { 'com.example.release.run': () => 'done' } });",
            }),
        );
        const targetPath =
            'targets/com.example.release/1.2.3/release.cbranch-plugin';
        const metadata = await tufMetadata({
            artifact,
            targetPath,
            manifest,
        });
        vi.stubGlobal('fetch', async (url: URL | string) => {
            const path = new URL(String(url)).pathname.replace('/catalog/', '');
            const body =
                path === targetPath
                    ? artifact
                    : metadata[path as keyof typeof metadata];
            return new Response(body, {
                headers: { 'content-length': String(body.byteLength) },
            });
        });
        const manager = makeTrustedPluginManager({ dataDirectory });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/catalog',
        );

        const untrusted = await manager.repositoryRefresh(repository.id);
        const trusted = await manager.publisherTrust(
            repository.id,
            untrusted.repository.publisherFingerprint!,
            true,
        );
        await manager.repositoryRefresh(trusted.id);
        await manager.catalogList(trusted.id);
        const review = await manager.installReview({
            repositoryId: trusted.id,
            pluginId: manifest.id,
            version: manifest.version,
        });
        const installed = await manager.install({
            repositoryId: trusted.id,
            pluginId: manifest.id,
            version: manifest.version,
            artifactSha256: review.target.artifactSha256,
            grant: {
                capabilities: [],
                repositoryIds: [],
                networkOrigins: [],
                automationActionIds: [],
                hostAutomationApproved: false,
            },
        });

        expect(review.manifest.contributes.commands).toEqual([
            {
                id: 'com.example.release.run',
                title: 'Run release',
                placement: 'plugins',
            },
        ]);
        expect(installed.enabled).toBe(false);
        await expect(manager.enable(manifest.id)).resolves.toMatchObject({
            enabled: true,
        });
    });

    test('loads enabled reviewed modules on startup, invokes declared commands, audits hooks, and unloads', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const record = makeRecord(true);
        await materialize(
            dataDirectory,
            record,
            `export default ({ log }) => ({
                commands: {
                    'com.example.release.run': input =>
                        input === 'dialog'
                            ? { _tag: 'dialog', title: 'Release', body: 'Ready' }
                            : 'ran:' + input,
                },
                commandExecuted: command => log('info', command),
            });`,
        );
        const lockStore = makePluginLockStore({ dataDirectory });
        await lockStore.write([record]);

        const manager = makeTrustedPluginManager({ dataDirectory, lockStore });
        expect((await manager.list())[0]?.enabled).toBe(true);

        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'check',
            }),
        ).resolves.toMatchObject({ state: 'completed', output: 'ran:check' });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'dialog',
            }),
        ).resolves.toMatchObject({
            state: 'completed',
            result: { _tag: 'dialog', title: 'Release', body: 'Ready' },
        });
        expect(
            (await manager.auditList({})).events.map(event => event.action),
        ).toEqual(
            expect.arrayContaining([
                'load',
                'invoke',
                'hook.commandExecuted',
                'log.info',
            ]),
        );

        await expect(
            manager.disable(String(record.pluginId)),
        ).resolves.toMatchObject({
            enabled: false,
        });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
            }),
        ).rejects.toThrow('disabled');
    });

    test('keeps a plugin disabled when its module commands differ from reviewed contributions', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const record = makeRecord(false);
        await materialize(
            dataDirectory,
            record,
            `export default () => ({ commands: { 'com.example.release.other': () => {} } });`,
        );
        const lockStore = makePluginLockStore({ dataDirectory });
        await lockStore.write([record]);
        const manager = makeTrustedPluginManager({ dataDirectory, lockStore });

        await expect(manager.enable(String(record.pluginId))).rejects.toThrow(
            'exactly match',
        );
        expect((await manager.list())[0]?.enabled).toBe(false);
    });

    test('dispatches command hooks in plugin-id order and isolates hook failures', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const first = makeRecord(true, 'com.example.alpha');
        const second = makeRecord(true, 'com.example.beta');
        await materialize(
            dataDirectory,
            first,
            `export default () => ({
                commands: { 'com.example.alpha.run': () => 'ok' },
                commandExecuted: () => {},
            });`,
        );
        await materialize(
            dataDirectory,
            second,
            `export default () => ({
                commands: { 'com.example.beta.run': () => 'ok' },
                commandExecuted: () => { throw new Error('hook failure'); },
            });`,
        );
        const lockStore = makePluginLockStore({ dataDirectory });
        await lockStore.write([second, first]);
        const manager = makeTrustedPluginManager({ dataDirectory, lockStore });

        await expect(
            manager.invoke({
                pluginId: first.pluginId,
                commandId: 'com.example.alpha.run',
                repoId: 'repo-1',
            }),
        ).resolves.toMatchObject({ state: 'completed', output: 'ok' });
        expect(
            (await manager.auditList({})).events
                .filter(event => event.action === 'hook.commandExecuted')
                .map(event => [event.pluginId, event.outcome]),
        ).toEqual([
            ['com.example.alpha', 'allowed'],
            ['com.example.beta', 'failed'],
        ]);
    });

    test('does not follow an entrypoint symlink outside the activated plugin root', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const record = makeRecord(false);
        const outside = join(dataDirectory, 'outside.mjs');
        await writeFile(
            outside,
            'export default () => ({ commands: {} });',
            'utf8',
        );
        const directory = activatedPluginDirectory(dataDirectory, record);
        await mkdir(directory, { recursive: true });
        await symlink(outside, join(directory, record.entrypoint));
        const lockStore = makePluginLockStore({ dataDirectory });
        await lockStore.write([record]);
        const manager = makeTrustedPluginManager({ dataDirectory, lockStore });

        await expect(manager.enable(String(record.pluginId))).rejects.toThrow(
            'activation root',
        );
    });
});

const tufMetadata = async ({
    artifact,
    targetPath,
    manifest,
}: {
    readonly artifact: Uint8Array;
    readonly targetPath: string;
    readonly manifest: PluginManifest;
}) => {
    const expires = new Date(Date.now() + 60_000).toISOString();
    const targets = metadataBytes(
        metadataEnvelope({
            version: 1,
            expires,
            targets: {
                [targetPath]: {
                    length: artifact.byteLength,
                    hashes: { sha256: metadataDigest(artifact) },
                    custom: {
                        pluginId: manifest.id,
                        version: manifest.version,
                        publisherFingerprint: manifest.publisherFingerprint,
                        minimumCbranchVersion: '0.2.0',
                        pluginContractVersion: 1,
                        capabilityDigest:
                            await digestManifestCapabilities(manifest),
                        releaseNotes: '',
                        advisoryIds: [],
                    },
                },
            },
        }),
    );
    const snapshot = metadataBytes(
        metadataEnvelope({
            version: 1,
            expires,
            meta: {
                'targets.json': {
                    length: targets.byteLength,
                    hashes: { sha256: metadataDigest(targets) },
                },
            },
        }),
    );
    const timestamp = metadataBytes(
        metadataEnvelope({
            version: 1,
            expires,
            meta: {
                'snapshot.json': {
                    length: snapshot.byteLength,
                    hashes: { sha256: metadataDigest(snapshot) },
                },
            },
        }),
    );
    const root = metadataBytes(
        metadataEnvelope({
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
    return {
        'metadata/root.json': root,
        'metadata/timestamp.json': timestamp,
        'metadata/snapshot.json': snapshot,
        'metadata/targets.json': targets,
    };
};

const makeTar = (files: Readonly<Record<string, string>>): Uint8Array => {
    const entries = Object.entries(files).flatMap(([path, contents]) => {
        const bytes = new TextEncoder().encode(contents);
        const header = new Uint8Array(512);
        writeTarString(header, 0, 100, path);
        writeTarString(header, 100, 8, '0000600');
        writeTarString(header, 124, 12, bytes.byteLength.toString(8));
        header[156] = '0'.charCodeAt(0);
        writeTarString(header, 257, 6, 'ustar');
        writeTarString(header, 263, 2, '00');
        header.fill(32, 148, 156);
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        writeTarString(header, 148, 8, checksum.toString(8));
        const padding = new Uint8Array(
            Math.ceil(bytes.byteLength / 512) * 512 - bytes.byteLength,
        );
        return [header, bytes, padding];
    });
    const length = entries.reduce(
        (total, entry) => total + entry.byteLength,
        0,
    );
    const archive = new Uint8Array(length + 1024);
    let offset = 0;
    for (const entry of entries) {
        archive.set(entry, offset);
        offset += entry.byteLength;
    }
    return archive;
};

const writeTarString = (
    target: Uint8Array,
    start: number,
    length: number,
    value: string,
): void => {
    target.set(new TextEncoder().encode(value), start);
    target[start + length - 1] = 0;
};
