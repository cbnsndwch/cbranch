import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
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
import type { PluginCredentialStore } from './plugin-credentials';
import {
    activatedPluginDirectory,
    makeTrustedPluginManager,
} from './plugin-manager';
import { makePluginRepositoryStore } from './plugin-repository-store';

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

const makeCredentialStore = (): PluginCredentialStore => {
    const credentials = new Map<string, string>();
    return {
        get: vi.fn(async repositoryUrl => credentials.get(repositoryUrl)),
        replace: vi.fn(async (repositoryUrl, credential) => {
            credentials.set(repositoryUrl, credential);
        }),
        reject: vi.fn(async (repositoryUrl, credential) => {
            if (credentials.get(repositoryUrl) === credential)
                credentials.delete(repositoryUrl);
        }),
    };
};

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
        const credentialStore = makeCredentialStore();
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore,
        });

        await expect(
            manager.repositoryAdd(
                'https',
                'https://plugins.example.test/catalog',
                'private-token-value',
            ),
        ).resolves.toMatchObject({
            trustState: 'untrusted',
            credentialState: 'available',
        });
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
        await expect(
            readFile(join(dataDirectory, 'repositories.json'), 'utf8'),
        ).resolves.not.toContain('private-token-value');
        await expect(
            makeTrustedPluginManager({
                dataDirectory,
                credentialStore,
            }).repositoryList(),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    url: 'https://plugins.example.test/catalog',
                    credentialState: 'available',
                }),
            ]),
        );
    });

    test('uses a private registry credential only for its configured HTTPS origin', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const fetch = vi.fn(
            async (_url: URL | string, _init?: RequestInit) =>
                new Response('root metadata', {
                    headers: { 'content-length': '13' },
                }),
        );
        vi.stubGlobal('fetch', fetch);
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore: makeCredentialStore(),
        });
        const repository = await manager.repositoryAdd(
            'https',
            'https://private.example.test/registry',
            'private-token-value',
        );

        await manager.repositoryRefresh(repository.id);

        expect(fetch).toHaveBeenCalledWith(
            new URL('https://private.example.test/registry/metadata/root.json'),
            expect.objectContaining({
                headers: { authorization: 'Bearer private-token-value' },
                redirect: 'manual',
            }),
        );
    });

    test('does not invoke the credential helper for a public publisher fetch', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const credentialStore = makeCredentialStore();
        const fetch = vi.fn(
            async (_url: URL | string, _init?: RequestInit) =>
                new Response('root metadata', {
                    headers: { 'content-length': '13' },
                }),
        );
        vi.stubGlobal('fetch', fetch);
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore,
        });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/registry',
        );

        await manager.repositoryRefresh(repository.id);

        expect(credentialStore.get).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledWith(
            new URL('https://plugins.example.test/registry/metadata/root.json'),
            expect.objectContaining({ headers: undefined, redirect: 'manual' }),
        );
    });

    test('marks a repository for credential replacement after a 401', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const credentialStore = makeCredentialStore();
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore,
        });
        const repository = await manager.repositoryAdd(
            'https',
            'https://private.example.test/registry',
            'private-token-value',
        );
        vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));

        await expect(manager.repositoryRefresh(repository.id)).rejects.toThrow(
            'HTTP 401',
        );
        await expect(manager.repositoryList()).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: repository.id,
                    credentialState: 'needs attention',
                }),
            ]),
        );
        expect(credentialStore.reject).toHaveBeenCalledWith(
            'https://private.example.test/registry',
            'private-token-value',
        );
    });

    test('reports an untrusted publisher metadata fetch failure to the caller', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore: makeCredentialStore(),
        });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/registry',
        );
        vi.stubGlobal('fetch', async () => {
            throw new Error('network unavailable');
        });

        await expect(
            manager.repositoryRefresh(repository.id),
        ).rejects.toMatchObject({
            code: 'networkError',
            message: 'Plugin repository request failed.',
        });
    });

    test('audits publisher trust and repository removal', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response('root metadata', {
                    headers: { 'content-length': '13' },
                }),
        );
        const manager = makeTrustedPluginManager({ dataDirectory });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/registry',
        );
        const refreshed = await manager.repositoryRefresh(repository.id);

        await manager.publisherTrust(
            repository.id,
            refreshed.repository.publisherFingerprint!,
            true,
        );
        await manager.repositoryRemove(repository.id);

        expect(
            (await manager.auditList({})).events.map(event => [
                event.action,
                event.outcome,
                event.repositoryId,
            ]),
        ).toEqual([
            ['publisher.rootFetchRequested', 'allowed', repository.id],
            ['publisher.rootFetched', 'allowed', repository.id],
            ['publisher.trustRequested', 'allowed', repository.id],
            ['publisher.trust', 'allowed', repository.id],
            ['repository.removeRequested', 'allowed', repository.id],
            ['repository.remove', 'allowed', repository.id],
        ]);
    });

    test('records a root-fetch request before root persistence', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response('root metadata', {
                    headers: { 'content-length': '13' },
                }),
        );
        const repositoryStore = makePluginRepositoryStore({ dataDirectory });
        const manager = makeTrustedPluginManager({
            dataDirectory,
            repositoryStore,
        });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/registry',
        );
        vi.spyOn(repositoryStore, 'setRoot').mockRejectedValueOnce(
            new Error('persistence failed'),
        );

        await expect(manager.repositoryRefresh(repository.id)).rejects.toThrow(
            'persistence failed',
        );
        await expect(manager.auditList({})).resolves.toMatchObject({
            events: [
                {
                    action: 'publisher.rootFetchRequested',
                    outcome: 'allowed',
                    repositoryId: repository.id,
                },
            ],
        });
    });

    test('does not transfer publisher trust to a concurrently fetched root', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        let releaseSecond!: () => void;
        const secondResponse = new Promise<void>(resolve => {
            releaseSecond = resolve;
        });
        let requests = 0;
        vi.stubGlobal('fetch', async () => {
            requests++;
            if (requests === 2) await secondResponse;
            const root = requests === 1 ? 'first root' : 'second root';
            return new Response(root, {
                headers: { 'content-length': String(root.length) },
            });
        });
        const manager = makeTrustedPluginManager({ dataDirectory });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/registry',
        );
        const first = await manager.repositoryRefresh(repository.id);
        const refreshing = manager.repositoryRefresh(repository.id);
        await vi.waitFor(() => expect(requests).toBe(2));

        const trusting = manager.publisherTrust(
            repository.id,
            first.repository.publisherFingerprint!,
            true,
        );
        releaseSecond();

        await expect(refreshing).resolves.toMatchObject({
            repository: {
                trustState: 'untrusted',
                publisherFingerprint: `sha256:${createHash('sha256').update('second root').digest('hex')}`,
            },
        });
        await expect(trusting).rejects.toMatchObject({
            code: 'pluginMetadataInvalid',
        });
        await expect(manager.catalogList(repository.id)).rejects.toMatchObject({
            code: 'pluginRepositoryUntrusted',
        });
    });

    test('does not add a repository when credential approval fails', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-manager-'),
        );
        const credentialStore = makeCredentialStore();
        vi.mocked(credentialStore.replace).mockRejectedValueOnce(
            new Error('credential helper failed'),
        );
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore,
        });

        await expect(
            manager.repositoryAdd(
                'https',
                'https://private.example.test/registry',
                'private-token-value',
            ),
        ).rejects.toThrow('credential helper failed');
        await expect(manager.repositoryList()).resolves.not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    url: 'https://private.example.test/registry',
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
        const expires = new Date(Date.now() + 60_000).toISOString();
        const root = tufRoot(expires);
        const manifest: PluginManifest = {
            schemaVersion: 1,
            id: PluginId.make('com.example.release'),
            version: '1.2.3',
            displayName: 'Release',
            publisherFingerprint: `sha256:${metadataDigest(root)}`,
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
            expires,
            root,
        });
        let unauthorized = false;
        vi.stubGlobal('fetch', async (url: URL | string) => {
            if (unauthorized) return new Response(null, { status: 401 });
            const path = new URL(String(url)).pathname.replace('/catalog/', '');
            const body =
                path === targetPath
                    ? artifact
                    : metadata[path as keyof typeof metadata];
            return new Response(Buffer.from(body), {
                headers: { 'content-length': String(body.byteLength) },
            });
        });
        const manager = makeTrustedPluginManager({
            dataDirectory,
            credentialStore: makeCredentialStore(),
        });
        const repository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/catalog',
            'private-token-value',
        );

        const untrusted = await manager.repositoryRefresh(repository.id);
        const trusted = await manager.publisherTrust(
            repository.id,
            untrusted.repository.publisherFingerprint!,
            true,
        );
        await manager.repositoryRefresh(trusted.id);
        await manager.catalogList(trusted.id);
        unauthorized = true;
        await expect(manager.catalogList(trusted.id)).rejects.toThrow(
            'HTTP 401',
        );
        await expect(manager.repositoryList()).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: trusted.id,
                    credentialState: 'needs attention',
                }),
            ]),
        );
        await expect(
            manager.installReview({
                repositoryId: trusted.id,
                pluginId: manifest.id,
                version: manifest.version,
            }),
        ).rejects.toThrow('current verified catalog');
        unauthorized = false;
        await expect(manager.catalogList(trusted.id)).resolves.not.toHaveLength(
            0,
        );
        const review = await manager.installReview({
            repositoryId: trusted.id,
            pluginId: manifest.id,
            version: manifest.version,
        });
        const secondRepository = await manager.repositoryAdd(
            'https',
            'https://plugins.example.test/catalog',
        );
        const secondUntrusted = await manager.repositoryRefresh(
            secondRepository.id,
        );
        const secondTrusted = await manager.publisherTrust(
            secondRepository.id,
            secondUntrusted.repository.publisherFingerprint!,
            true,
        );
        await manager.repositoryRefresh(secondTrusted.id);
        const secondReview = await manager.installReview({
            repositoryId: secondTrusted.id,
            pluginId: manifest.id,
            version: manifest.version,
        });
        const grant = {
            capabilities: [],
            repositoryIds: [],
            networkOrigins: [],
            automationActionIds: [],
            hostAutomationApproved: false,
        } as const;
        await expect(
            manager.install({
                repositoryId: trusted.id,
                pluginId: manifest.id,
                version: manifest.version,
                artifactSha256: review.target.artifactSha256,
                reviewToken: `sha256:${'0'.repeat(64)}`,
                grant,
            }),
        ).rejects.toThrow('changed');
        const attempts = await Promise.allSettled([
            manager.install({
                repositoryId: trusted.id,
                pluginId: manifest.id,
                version: manifest.version,
                artifactSha256: review.target.artifactSha256,
                reviewToken: review.reviewToken,
                grant,
            }),
            manager.install({
                repositoryId: secondTrusted.id,
                pluginId: manifest.id,
                version: manifest.version,
                artifactSha256: secondReview.target.artifactSha256,
                reviewToken: secondReview.reviewToken,
                grant,
            }),
        ]);
        const installed = attempts.find(
            attempt => attempt.status === 'fulfilled',
        )?.value;
        expect(
            attempts.filter(attempt => attempt.status === 'fulfilled'),
        ).toHaveLength(1);
        expect(
            attempts.filter(attempt => attempt.status === 'rejected'),
        ).toHaveLength(1);
        expect(
            attempts.find(attempt => attempt.status === 'rejected')?.reason,
        ).toMatchObject({ code: 'pluginPolicyDenied' });
        expect(installed).toBeDefined();

        expect(review.manifest.contributes.commands).toEqual([
            {
                id: 'com.example.release.run',
                title: 'Run release',
                placement: 'plugins',
            },
        ]);
        expect(installed!.enabled).toBe(false);
        expect(installed!.lock.tufTargetVersion).toBe(7);
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
                        input === 'fail'
                            ? (() => {
                                  throw new Error('expected failure');
                              })()
                            : input === 'dialog'
                            ? { _tag: 'dialog', title: 'Release', body: 'Ready' }
                            : input === 'exact-limit'
                            ? 'a'.repeat(1024 * 1024)
                            : input === 'escaped-exact-limit'
                            ? '\\n'.repeat(1024 * 1024)
                            : input === 'unicode-over'
                            ? 'é'.repeat(524289)
                            : input === 'structured-exact-limit'
                            ? (() => {
                                  const empty = JSON.stringify({ _tag: 'notice', message: '' });
                                  return { _tag: 'notice', message: 'a'.repeat(1024 * 1024 - empty.length) };
                              })()
                            : input === 'structured-over-limit'
                            ? (() => {
                                  const empty = JSON.stringify({ _tag: 'notice', message: '' });
                                  return { _tag: 'notice', message: 'a'.repeat(1024 * 1024 - empty.length + 1) };
                              })()
                            : 'ran:' + input,
                },
                commandExecuted: command => log('info', command),
                toolExecuteBefore: execution => log('info', 'before:' + execution.engagementId),
                toolExecuteAfter: execution => log('info', 'after:' + execution.state),
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
                engagementId: 'engagement-1',
                input: 'check',
            }),
        ).resolves.toMatchObject({ state: 'completed', output: 'ran:check' });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'fail',
            }),
        ).rejects.toThrow('failed');
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
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'exact-limit',
            }),
        ).resolves.toMatchObject({ state: 'completed' });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'escaped-exact-limit',
            }),
        ).resolves.toMatchObject({ state: 'completed' });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'unicode-over',
            }),
        ).rejects.toMatchObject({ code: 'resultTooLarge' });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'structured-exact-limit',
            }),
        ).resolves.toMatchObject({ state: 'completed' });
        await expect(
            manager.invoke({
                pluginId: record.pluginId,
                commandId: 'com.example.release.run',
                repoId: 'repo-1',
                input: 'structured-over-limit',
            }),
        ).rejects.toMatchObject({ code: 'resultTooLarge' });
        expect(
            (await manager.auditList({})).events.map(event => event.action),
        ).toEqual(
            expect.arrayContaining([
                'load',
                'invoke',
                'hook.commandExecuted',
                'hook.toolExecuteBefore',
                'hook.toolExecuteAfter',
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
    expires,
    root,
}: {
    readonly artifact: Uint8Array;
    readonly targetPath: string;
    readonly manifest: PluginManifest;
    readonly expires: string;
    readonly root: Uint8Array;
}) => {
    const targets = metadataBytes(
        metadataEnvelope({
            _type: 'targets',
            version: 7,
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
            _type: 'snapshot',
            version: 1,
            expires,
            meta: {
                'targets.json': {
                    version: 7,
                    length: targets.byteLength,
                    hashes: { sha256: metadataDigest(targets) },
                },
            },
        }),
    );
    const timestamp = metadataBytes(
        metadataEnvelope({
            _type: 'timestamp',
            version: 1,
            expires,
            meta: {
                'snapshot.json': {
                    version: 1,
                    length: snapshot.byteLength,
                    hashes: { sha256: metadataDigest(snapshot) },
                },
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

const tufRoot = (expires: string): Uint8Array =>
    metadataBytes(
        metadataEnvelope({
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
        }),
    );

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
