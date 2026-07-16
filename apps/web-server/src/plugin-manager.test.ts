import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    PluginId,
    PluginLockRecord,
    PluginRepositoryId,
    type PluginManifest,
} from '@cbranch/plugin-contract';
import { describe, expect, test, vi } from 'vitest';

import { makePluginLockStore } from './plugin-lock-store';
import {
    activatedPluginDirectory,
    makeTrustedPluginManager,
} from './plugin-manager';

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
        expect(await manager.repositoryList()).toHaveLength(1);
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
        expect((await manager.list())[0]?.lock.entrypoint).toBe('plugin.mjs');
        expect(artifactStore.activate).toHaveBeenCalledOnce();
        expect((await manager.auditList({})).events[0]?.action).toBe('install');
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
                commands: { 'com.example.release.run': input => 'ran:' + input },
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
