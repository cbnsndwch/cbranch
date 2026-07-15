// Host-private verified artifact staging. This module stores bytes only after the
// transport/TUF layer supplied signed target metadata; it never extracts or executes them.

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginCatalogEntry } from '@cbranch/plugin-contract';
import {
    MAX_PLUGIN_ARCHIVE_COMPRESSED_BYTES,
    PluginPolicyError,
    validateArtifact,
} from '@cbranch/plugin-runtime';

import { resolvePluginDataDirectory } from './plugin-lock-store';

export interface PluginArtifactStore {
    readonly stage: (
        target: Pick<
            PluginCatalogEntry,
            'pluginId' | 'version' | 'artifactLength' | 'artifactSha256'
        >,
        artifact: Uint8Array,
    ) => Promise<string>;
}

export type PluginArtifactStoreOptions = {
    readonly dataDirectory?: string;
    readonly env?: NodeJS.ProcessEnv;
};

/** Stage one digest-verified artifact atomically, retaining artifacts by exact version. */
export const makePluginArtifactStore = (
    options: PluginArtifactStoreOptions = {},
): PluginArtifactStore => {
    const dataDirectory =
        options.dataDirectory ?? resolvePluginDataDirectory(options.env);

    return {
        stage: async (target, artifact) => {
            const pluginId = String(target.pluginId);
            if (
                !isSafePathComponent(pluginId) ||
                !isSafePathComponent(target.version)
            ) {
                throw new PluginPolicyError(
                    'pluginArtifactInvalid',
                    'Plugin target has an unsafe local storage path.',
                );
            }
            if (target.artifactLength > MAX_PLUGIN_ARCHIVE_COMPRESSED_BYTES) {
                throw new PluginPolicyError(
                    'pluginArtifactInvalid',
                    'Plugin artifact exceeds the compressed size limit.',
                );
            }
            const actualSha256 = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
            validateArtifact(target, artifact.byteLength, actualSha256);

            const directory = join(dataDirectory, 'artifacts', pluginId);
            const destination = join(
                directory,
                `${target.version}.cbranch-plugin`,
            );
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await chmod(directory, 0o700);

            const temporary = join(
                directory,
                `.${target.version}.${randomUUID()}.tmp`,
            );
            try {
                await writeFile(temporary, artifact, {
                    mode: 0o600,
                    flag: 'wx',
                });
                await rename(temporary, destination);
                await chmod(destination, 0o600);
                return destination;
            } catch (error) {
                await rm(temporary, { force: true });
                throw error;
            }
        },
    };
};

const isSafePathComponent = (value: string): boolean =>
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..';
