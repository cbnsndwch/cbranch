import {
    type PluginCatalogEntry,
    type PluginManifest,
} from '@cbranch/plugin-contract';
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

type VerifiedPluginTarget = {
    readonly target: PluginCatalogEntry;
    readonly tufTargetVersion: number;
};

/** Fetch and verify a repository catalog before staging one selected signed target. */
export const makeTufPluginRepository = (
    options: TufPluginRepositoryOptions,
) => {
    let catalog = new Map<string, VerifiedPluginTarget>();

    return {
        refresh: async (): Promise<readonly PluginCatalogEntry[]> => {
            const [timestamp, snapshot, targets] = await Promise.all([
                options.transport.fetchMetadata('metadata/timestamp.json'),
                options.transport.fetchMetadata('metadata/snapshot.json'),
                options.transport.fetchMetadata('metadata/targets.json'),
            ]);
            const verifiedCatalog = await verifyTufCatalog(
                { root: options.root, timestamp, snapshot, targets },
                options.verifySignature,
                options.now?.(),
            );
            catalog = new Map(
                verifiedCatalog.entries.map(entry => [
                    catalogKey(entry.pluginId, entry.version),
                    {
                        target: entry,
                        tufTargetVersion: verifiedCatalog.targetsVersion,
                    },
                ]),
            );
            return verifiedCatalog.entries;
        },
        stage: async (
            pluginId: string,
            version: string,
        ): Promise<VerifiedPluginTarget> => {
            const entry = catalog.get(catalogKey(pluginId, version));
            if (!entry) {
                throw new Error(
                    'Plugin target is not in the current verified catalog.',
                );
            }
            await options.artifactStore.stage(
                entry.target,
                await options.transport.fetchTarget(entry.target.artifactPath),
            );
            return entry;
        },
        review: async (
            pluginId: string,
            version: string,
        ): Promise<{
            readonly target: PluginCatalogEntry;
            readonly manifest: PluginManifest;
        }> => {
            const target = catalog.get(catalogKey(pluginId, version));
            if (!target) {
                throw new Error(
                    'Plugin target is not in the current verified catalog.',
                );
            }
            await options.artifactStore.stage(
                target.target,
                await options.transport.fetchTarget(target.target.artifactPath),
            );
            return {
                target: target.target,
                manifest: await options.artifactStore.review(target.target),
            };
        },
    };
};

const catalogKey = (pluginId: string, version: string): string =>
    `${pluginId}\0${version}`;
