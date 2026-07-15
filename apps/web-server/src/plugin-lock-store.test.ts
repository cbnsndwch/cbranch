import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginId, PluginRepositoryId } from '@cbranch/plugin-contract';
import { describe, expect, test } from 'vitest';

import {
    makePluginLockStore,
    PluginLockFile,
    PLUGIN_LOCK_FILE_NAME,
    resolvePluginDataDirectory,
} from './plugin-lock-store';

const record = {
    pluginId: PluginId.make('com.example.release'),
    version: '1.2.3',
    artifactSha256: `sha256:${'a'.repeat(64)}`,
    repositoryId: PluginRepositoryId.make('repository-1'),
    tufTargetVersion: 3,
    publisherFingerprint: `sha256:${'b'.repeat(64)}`,
    manifestCapabilityDigest: `sha256:${'c'.repeat(64)}`,
    grantDigest: `sha256:${'d'.repeat(64)}`,
    entrypoint: 'plugin.mjs',
    enabled: false,
    grant: {
        capabilities: [],
        repositoryIds: [],
        networkOrigins: [],
        automationActionIds: [],
        hostAutomationApproved: false,
    },
    contributions: { commands: [], panels: [] },
};

describe('plugin lock store', () => {
    test('uses XDG data storage rather than host config storage', () => {
        expect(resolvePluginDataDirectory({ XDG_DATA_HOME: '/data' })).toBe(
            '/data/cbranch/plugins',
        );
    });

    test('starts empty and atomically persists validated lock records', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'cbranch-plugin-lock-'));
        const store = makePluginLockStore({ dataDirectory: directory });

        expect((await store.load()).plugins).toEqual([]);
        await store.write([record]);
        expect((await store.load()).plugins).toEqual([record]);

        const lockStat = await stat(join(directory, PLUGIN_LOCK_FILE_NAME));
        const directoryStat = await stat(directory);
        expect(lockStat.mode & 0o777).toBe(0o600);
        expect(directoryStat.mode & 0o777).toBe(0o700);

        await Promise.all([store.write([record]), store.write([])]);

        expect(await store.load()).toEqual(
            new PluginLockFile({ version: 1, plugins: [] }),
        );
    });
});
