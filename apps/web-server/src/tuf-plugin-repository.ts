import {
    type PluginCatalogEntry,
    type PluginManifest,
} from '@cbranch/plugin-contract';
import type {
    PluginRepositoryTransport,
    TufSignatureVerifier,
} from '@cbranch/plugin-runtime';
import { PluginPolicyError, verifyTufCatalog } from '@cbranch/plugin-runtime';

import type { PluginArtifactStore } from './plugin-artifact-store';

export type TufPluginRepositoryOptions = {
    readonly root: Uint8Array;
    readonly transport: PluginRepositoryTransport;
    readonly artifactStore: PluginArtifactStore;
    readonly publisherFingerprint: string;
    readonly verifySignature: TufSignatureVerifier;
    readonly now?: () => number;
};

type VerifiedPluginTarget = {
    readonly target: PluginCatalogEntry;
    readonly tufTargetVersion: number;
    readonly expiresAt: number;
};

/** Fetch and verify a repository catalog before staging one selected signed target. */
export const makeTufPluginRepository = (
    options: TufPluginRepositoryOptions,
) => {
    let catalog = new Map<string, VerifiedPluginTarget>();
    const now = options.now ?? Date.now;
    const currentTarget = (
        pluginId: string,
        version: string,
    ): VerifiedPluginTarget => {
        const entry = catalog.get(catalogKey(pluginId, version));
        if (!entry) {
            throw new PluginPolicyError(
                'pluginMetadataInvalid',
                'Plugin target is not in the current verified catalog.',
            );
        }
        if (entry.expiresAt <= now()) {
            catalog.clear();
            throw new PluginPolicyError(
                'pluginMetadataExpired',
                'Plugin repository metadata has expired.',
            );
        }
        return entry;
    };

    return {
        refresh: async (): Promise<readonly PluginCatalogEntry[]> => {
            catalog.clear();
            const [timestamp, snapshot, targets] = await Promise.all([
                options.transport.fetchMetadata('metadata/timestamp.json'),
                options.transport.fetchMetadata('metadata/snapshot.json'),
                options.transport.fetchMetadata('metadata/targets.json'),
            ]);
            const verifiedCatalog = await verifyTufCatalog(
                { root: options.root, timestamp, snapshot, targets },
                options.verifySignature,
                now(),
            );
            if (
                verifiedCatalog.entries.some(
                    entry =>
                        entry.publisherFingerprint !==
                        options.publisherFingerprint,
                )
            ) {
                throw new PluginPolicyError(
                    'pluginMetadataInvalid',
                    'Plugin target publisher does not match the approved repository root.',
                );
            }
            catalog = new Map(
                verifiedCatalog.entries.map(entry => [
                    catalogKey(entry.pluginId, entry.version),
                    {
                        target: entry,
                        tufTargetVersion: verifiedCatalog.targetsVersion,
                        expiresAt: verifiedCatalog.expiresAt,
                    },
                ]),
            );
            return verifiedCatalog.entries;
        },
        stage: async (
            pluginId: string,
            version: string,
        ): Promise<VerifiedPluginTarget> => {
            const entry = currentTarget(pluginId, version);
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
            const target = currentTarget(pluginId, version);
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
