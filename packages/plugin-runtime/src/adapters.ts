import type {
    PluginBrokerRequest,
    PluginBrokerResponse,
    PluginCatalogEntry,
    PluginManifest,
} from '@cbranch/plugin-contract';

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
        artifact: Uint8Array,
        target: PluginCatalogEntry,
    ) => Promise<void>;
    readonly activate: (pluginId: string, version: string) => Promise<void>;
    readonly remove: (pluginId: string) => Promise<void>;
}

/** The only runtime execution boundary. A Node worker or VM must not implement this. */
export interface PluginWorkerSupervisor {
    readonly sandboxAvailable: () => Promise<{
        readonly available: boolean;
        readonly reason?: string;
    }>;
    readonly start: (manifest: PluginManifest) => Promise<void>;
    readonly stop: (pluginId: string) => Promise<void>;
    readonly request: (
        request: PluginBrokerRequest,
    ) => Promise<PluginBrokerResponse>;
}
