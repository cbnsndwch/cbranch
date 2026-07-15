// Host-only plugin repository credential boundary. Neither plugin-contract nor
// plugin-runtime imports this module, so a token cannot reach a worker or browser API.

import { randomUUID } from 'node:crypto';

import type { PluginRepositoryId } from '@cbranch/plugin-contract';

export type PluginCredentialReference = string & {
    readonly __pluginCredentialReference: unique symbol;
};

export interface PluginCredentialStore {
    /** True only for an OS-backed secret store. */
    readonly persistent: boolean;
    /** Replaces a repository credential and returns only its opaque reference. */
    readonly replace: (
        repositoryId: PluginRepositoryId,
        credential: string,
    ) => Promise<PluginCredentialReference>;
    /** Host repository clients use this immediately before an authenticated request. */
    readonly get: (
        repositoryId: PluginRepositoryId,
    ) => Promise<string | undefined>;
    readonly remove: (repositoryId: PluginRepositoryId) => Promise<void>;
}

/**
 * Fallback when the platform has no secure secret store. Its contents disappear with
 * the process and the only externally visible value is a random opaque reference.
 */
export const makeProcessCredentialStore = (): PluginCredentialStore => {
    const credentials = new Map<
        PluginRepositoryId,
        { reference: PluginCredentialReference; value: string }
    >();

    return {
        persistent: false,
        replace: async (repositoryId, credential) => {
            const reference =
                `plugin-secret:${randomUUID()}` as PluginCredentialReference;
            credentials.set(repositoryId, { reference, value: credential });
            return reference;
        },
        get: async repositoryId => credentials.get(repositoryId)?.value,
        remove: async repositoryId => {
            credentials.delete(repositoryId);
        },
    };
};
