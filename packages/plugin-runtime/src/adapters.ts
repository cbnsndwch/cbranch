import type { PluginCatalogEntry } from '@cbranch/plugin-contract';

/**
 * Host adapters implement these interfaces. Keeping them here lets policy code be
 * tested without making the runtime capable of network, filesystem, or process access.
 */
export interface PluginRepositoryTransport {
    readonly fetchMetadata: (path: string) => Promise<Uint8Array>;
    readonly fetchTarget: (path: string) => Promise<Uint8Array>;
}

/** TUF verification is supplied by a host-selected implementation, never a plugin. */
export interface TufVerifier {
    readonly verifyCatalog: (
        metadata: Readonly<Record<string, Uint8Array>>,
    ) => Promise<readonly PluginCatalogEntry[]>;
}

/** Storage activates only verified artifacts and retains previous verified versions. */
export interface PluginArtifactStore {
    readonly stage: (
        target: PluginCatalogEntry,
        artifact: Uint8Array,
    ) => Promise<string>;
}
