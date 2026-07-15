// Machine-managed plugin lock persistence. This deliberately lives in the host app:
// plugin-runtime defines data/policy only and must not access the filesystem.

import { randomUUID } from 'node:crypto';
import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { PluginLockRecord } from '@cbranch/plugin-contract';
import { Schema } from 'effect';

export const PLUGIN_LOCK_FILE_NAME = 'plugins.lock.json';
export const PLUGIN_LOCK_VERSION = 1;

export class PluginLockFile extends Schema.Class<PluginLockFile>(
    'PluginLockFile',
)({
    version: Schema.Literal(PLUGIN_LOCK_VERSION),
    plugins: Schema.Array(PluginLockRecord),
}) {}

export interface PluginLockStore {
    readonly load: () => Promise<PluginLockFile>;
    readonly write: (plugins: readonly PluginLockRecord[]) => Promise<void>;
}

export type PluginLockStoreOptions = {
    readonly dataDirectory?: string;
    readonly env?: NodeJS.ProcessEnv;
};

/** Resolve the host-private data directory without putting plugins in config.json. */
export const resolvePluginDataDirectory = (
    env: NodeJS.ProcessEnv = process.env,
): string => {
    const xdg = env.XDG_DATA_HOME?.trim();
    return join(
        xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'share'),
        'cbranch',
        'plugins',
    );
};

/**
 * Atomically replaces the lock file after validating its schema. A per-store queue keeps
 * concurrent host operations from overwriting each other's accepted lock records.
 */
export const makePluginLockStore = (
    options: PluginLockStoreOptions = {},
): PluginLockStore => {
    const dataDirectory =
        options.dataDirectory ?? resolvePluginDataDirectory(options.env);
    const file = join(dataDirectory, PLUGIN_LOCK_FILE_NAME);
    let writeTail = Promise.resolve();

    const ensureDirectory = async (): Promise<void> => {
        await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        await chmod(dataDirectory, 0o700);
    };

    return {
        load: async () => {
            try {
                const json = await readFile(file, 'utf8');
                return Schema.decodeUnknownSync(PluginLockFile)(
                    JSON.parse(json),
                );
            } catch (error) {
                if (
                    typeof error === 'object' &&
                    error !== null &&
                    'code' in error &&
                    error.code === 'ENOENT'
                ) {
                    return new PluginLockFile({
                        version: PLUGIN_LOCK_VERSION,
                        plugins: [],
                    });
                }
                throw error;
            }
        },
        write: plugins => {
            const operation = async (): Promise<void> => {
                const lock = Schema.decodeUnknownSync(PluginLockFile)({
                    version: PLUGIN_LOCK_VERSION,
                    plugins,
                });
                await ensureDirectory();
                const temporary = join(
                    dirname(file),
                    `.${PLUGIN_LOCK_FILE_NAME}.${randomUUID()}.tmp`,
                );
                try {
                    await writeFile(temporary, JSON.stringify(lock), {
                        encoding: 'utf8',
                        mode: 0o600,
                        flag: 'wx',
                    });
                    await rename(temporary, file);
                    await chmod(file, 0o600);
                } catch (error) {
                    // A failed staging write never replaces the last known-good lock.
                    await rm(temporary, { force: true });
                    throw error;
                }
            };
            const next = writeTail.then(operation, operation);
            writeTail = next.catch(() => undefined);
            return next;
        },
    };
};
