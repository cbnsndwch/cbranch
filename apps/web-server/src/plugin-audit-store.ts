// Append-only, host-private audit persistence. Events contain identifiers and outcomes
// only; plugin output, credentials, and file contents are intentionally never recorded.

import { randomUUID } from 'node:crypto';
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { PluginAuditEvent } from '@cbranch/plugin-contract';
import { Schema } from 'effect';

import { resolvePluginDataDirectory } from './plugin-lock-store';

export const PLUGIN_AUDIT_FILE_NAME = 'plugins.audit.json';
const PLUGIN_AUDIT_VERSION = 1;

class PluginAuditFile extends Schema.Class<PluginAuditFile>('PluginAuditFile')({
    version: Schema.Literal(PLUGIN_AUDIT_VERSION),
    events: Schema.Array(PluginAuditEvent),
}) {}

export interface PluginAuditStore {
    readonly list: () => Promise<readonly PluginAuditEvent[]>;
    readonly record: (event: PluginAuditEvent) => Promise<void>;
}

export type PluginAuditStoreOptions = {
    readonly dataDirectory?: string;
    readonly env?: NodeJS.ProcessEnv;
};

/** Persist redacted lifecycle and extension-API audit events with owner-only access. */
export const makePluginAuditStore = (
    options: PluginAuditStoreOptions = {},
): PluginAuditStore => {
    const dataDirectory =
        options.dataDirectory ?? resolvePluginDataDirectory(options.env);
    const file = join(dataDirectory, PLUGIN_AUDIT_FILE_NAME);
    let writeTail = Promise.resolve();

    const load = async (): Promise<PluginAuditFile> => {
        try {
            return Schema.decodeUnknownSync(PluginAuditFile)(
                JSON.parse(await readFile(file, 'utf8')),
            );
        } catch (error) {
            if (
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                error.code === 'ENOENT'
            ) {
                return new PluginAuditFile({
                    version: PLUGIN_AUDIT_VERSION,
                    events: [],
                });
            }
            throw error;
        }
    };

    const write = async (
        events: readonly PluginAuditEvent[],
    ): Promise<void> => {
        const audit = Schema.decodeUnknownSync(PluginAuditFile)({
            version: PLUGIN_AUDIT_VERSION,
            events,
        });
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        await chmod(dataDirectory, 0o700);
        const temporary = join(
            dataDirectory,
            `.${PLUGIN_AUDIT_FILE_NAME}.${randomUUID()}.tmp`,
        );
        try {
            await writeFile(temporary, JSON.stringify(audit), {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
            });
            await rename(temporary, file);
            await chmod(file, 0o600);
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        }
    };

    return {
        list: () =>
            writeTail.then(
                () => load().then(audit => audit.events),
                () => load().then(audit => audit.events),
            ),
        record: event => {
            const operation = async (): Promise<void> => {
                const audit = await load();
                await write([...audit.events, event]);
            };
            const next = writeTail.then(operation, operation);
            writeTail = next.catch(() => undefined);
            return next;
        },
    };
};
