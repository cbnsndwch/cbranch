import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    PluginAuditEvent,
    PluginId,
    PluginRepositoryId,
} from '@cbranch/plugin-contract';
import { describe, expect, test } from 'vitest';

import {
    makePluginAuditStore,
    PLUGIN_AUDIT_FILE_NAME,
} from './plugin-audit-store';

describe('plugin audit store', () => {
    test('serializes structured redacted events into an owner-only audit file', async () => {
        const dataDirectory = await mkdtemp(
            join(tmpdir(), 'cbranch-plugin-audit-'),
        );
        const store = makePluginAuditStore({ dataDirectory });
        const event = new PluginAuditEvent({
            at: 1,
            pluginId: PluginId.make('com.example.release'),
            version: '1.2.3',
            publisherFingerprint: 'sha256:publisher',
            repositoryId: PluginRepositoryId.make('repository-1'),
            action: 'invoke',
            outcome: 'allowed',
            repoId: 'repo-1',
        });

        await Promise.all([store.record(event), store.record(event)]);

        expect(await store.list()).toEqual([event, event]);
        expect(
            (await stat(join(dataDirectory, PLUGIN_AUDIT_FILE_NAME))).mode &
                0o777,
        ).toBe(0o600);
    });
});
