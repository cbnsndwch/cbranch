import type { PluginCatalogEntry } from '@cbranch/plugin-contract';
import type {
    PluginRepositoryTransport,
    TufSignatureVerifier,
} from '@cbranch/plugin-runtime';
import { verifyTufCatalog } from '@cbranch/plugin-runtime';

import type { PluginArtifactStore } from './plugin-artifact-store';

export type TufPluginRepositoryOptions = {
    readonly root: Uint8Array;
    readonly transport: PluginRepositoryTransport;
    readonly artifactStore: PluginArtifactStore;
    readonly verifySignature: TufSignatureVerifier;
    readonly now?: () => number;
};

/** Fetch and verify a repository catalog before staging one selected signed target. */
export const makeTufPluginRepository = (
    options: TufPluginRepositoryOptions,
) => {
    let catalog = new Map<string, PluginCatalogEntry>();

    return {
        refresh: async (): Promise<readonly PluginCatalogEntry[]> => {
            const [timestamp, snapshot, targets] = await Promise.all([
                options.transport.fetchMetadata('metadata/timestamp.json'),
                options.transport.fetchMetadata('metadata/snapshot.json'),
                options.transport.fetchMetadata('metadata/targets.json'),
            ]);
            const entries = await verifyTufCatalog(
                { root: options.root, timestamp, snapshot, targets },
                options.verifySignature,
                options.now?.(),
            );
            catalog = new Map(
                entries.map(entry => [
                    catalogKey(entry.pluginId, entry.version),
                    entry,
                ]),
            );
            return entries;
        },
        stage: async (
            pluginId: string,
            version: string,
        ): Promise<PluginCatalogEntry> => {
            const entry = catalog.get(catalogKey(pluginId, version));
            if (!entry) {
                throw new Error(
                    'Plugin target is not in the current verified catalog.',
                );
            }
            await options.artifactStore.stage(
                entry,
                await options.transport.fetchTarget(entry.artifactPath),
            );
            return entry;
        },
    };
};

const catalogKey = (pluginId: string, version: string): string =>
    `${pluginId}\0${version}`;
