// Trusted extensions run in the host process by explicit product decision. Their grants
// govern only cbranch-provided APIs; they are not a security boundary around Node access.

import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
    PluginAuditPage,
    PluginCommandResult,
    PluginInvocation,
    PluginInstallReview,
    InstalledPlugin,
    PluginLockRecord,
    PluginOperationId,
    PluginRepositoryRefresh,
    PluginRuntimeStatus,
    PluginAuditEvent,
    type PluginAuditListInput,
    type PluginCatalogEntry,
    type PluginIdInput,
    type PluginInstallInput,
    type PluginInstallReviewInput,
    type PluginInvokeInput,
    type PluginPublisherTrustInput,
    PluginRepository,
    type PluginRepositoryAddInput,
    type PluginRepositoryIdInput,
} from '@cbranch/plugin-contract';
import {
    digestGrant,
    isSafeRelativePath,
    PluginPolicyError,
    validateRepositoryUrl,
} from '@cbranch/plugin-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

import { GitError, type GitErrorCode } from '@cbranch/rpc-contract';

import {
    makePluginAuditStore,
    type PluginAuditStore,
} from './plugin-audit-store';
import {
    makePluginArtifactStore,
    type PluginArtifactStore,
} from './plugin-artifact-store';
import {
    makePluginLockStore,
    resolvePluginDataDirectory,
    type PluginLockStore,
} from './plugin-lock-store';
import {
    makePluginRepositoryStore,
    type PluginRepositoryStore,
} from './plugin-repository-store';
import {
    makeGitCredentialStore,
    type PluginCredentialStore,
} from './plugin-credentials';
import { makeHttpsPluginRepositoryTransport } from './plugin-repository-transport';
import { PluginRepositoryTransportError } from './plugin-repository-transport';
import { verifyTufEd25519Signature } from './tuf-signature-verifier';
import { makeTufPluginRepository } from './tuf-plugin-repository';
import {
    loadTrustedPlugin,
    type TrustedPluginHooks,
} from './trusted-plugin-host';

export interface PluginManagerApi {
    readonly runtimeStatus: () => Effect.Effect<PluginRuntimeStatus, GitError>;
    readonly repositoryList: () => Effect.Effect<
        readonly PluginRepository[],
        GitError
    >;
    readonly repositoryAdd: (
        input: PluginRepositoryAddInput,
    ) => Effect.Effect<PluginRepository, GitError>;
    readonly repositoryRefresh: (
        input: PluginRepositoryIdInput,
    ) => Effect.Effect<PluginRepositoryRefresh, GitError>;
    readonly repositoryRemove: (
        input: PluginRepositoryIdInput,
    ) => Effect.Effect<void, GitError>;
    readonly publisherTrust: (
        input: PluginPublisherTrustInput,
    ) => Effect.Effect<PluginRepository, GitError>;
    readonly catalogList: (
        input: PluginRepositoryIdInput,
    ) => Effect.Effect<readonly PluginCatalogEntry[], GitError>;
    readonly install: (
        input: PluginInstallInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
    readonly installReview: (
        input: PluginInstallReviewInput,
    ) => Effect.Effect<PluginInstallReview, GitError>;
    readonly list: () => Effect.Effect<readonly InstalledPlugin[], GitError>;
    readonly enable: (
        input: PluginIdInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
    readonly disable: (
        input: PluginIdInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
    readonly uninstall: (input: PluginIdInput) => Effect.Effect<void, GitError>;
    readonly auditList: (
        input: PluginAuditListInput,
    ) => Effect.Effect<PluginAuditPage, GitError>;
    readonly invoke: (
        input: PluginInvokeInput,
    ) => Effect.Effect<PluginInvocation, GitError>;
}

export class PluginManager extends Context.Service<
    PluginManager,
    PluginManagerApi
>()('PluginManager') {}

export type TrustedPluginManagerOptions = {
    readonly dataDirectory?: string;
    readonly lockStore?: PluginLockStore;
    readonly auditStore?: PluginAuditStore;
    readonly artifactStore?: PluginArtifactStore;
    readonly repositoryStore?: PluginRepositoryStore;
    readonly credentialStore?: PluginCredentialStore;
};

/** Signed target data accepted only after a repository/TUF adapter verified it. */
export type VerifiedPluginInstall = {
    readonly target: PluginCatalogEntry;
    readonly repositoryId: PluginLockRecord['repositoryId'];
    readonly tufTargetVersion: number;
    readonly grant: PluginLockRecord['grant'];
};

type LoadedPlugin = {
    readonly record: PluginLockRecord;
    readonly hooks: TrustedPluginHooks;
};

class PluginManagerError extends Error {
    constructor(
        readonly code: GitErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'PluginManagerError';
    }
}

/**
 * Path for one reviewed, materialized plugin version. The installer owns creation of
 * this directory; this manager only loads a path already selected by a lock record.
 */
export const activatedPluginDirectory = (
    dataDirectory: string,
    record: Pick<PluginLockRecord, 'pluginId' | 'version' | 'artifactSha256'>,
): string => {
    const digest = record.artifactSha256.replace(/^sha256:/, '');
    if (
        !isSafePathComponent(String(record.pluginId)) ||
        !isSafePathComponent(record.version) ||
        !/^[0-9a-f]{64}$/.test(digest)
    ) {
        throw new PluginManagerError(
            'pluginArtifactInvalid',
            'Plugin lock record has an unsafe activation path.',
        );
    }
    return join(
        dataDirectory,
        'activated',
        record.pluginId,
        record.version,
        digest,
    );
};

const pluginReviewToken = (target: PluginCatalogEntry): string =>
    `sha256:${createHash('sha256')
        .update(
            JSON.stringify({
                pluginId: String(target.pluginId),
                version: target.version,
                publisherFingerprint: target.publisherFingerprint,
                artifactPath: target.artifactPath,
                artifactSha256: target.artifactSha256,
                artifactLength: target.artifactLength,
                minimumCbranchVersion: target.minimumCbranchVersion,
                pluginContractVersion: target.pluginContractVersion,
                capabilityDigest: target.capabilityDigest,
                releaseNotes: target.releaseNotes,
                advisoryIds: [...target.advisoryIds],
            }),
        )
        .digest('hex')}`;

/**
 * Create the practical first trusted-extension lifecycle. Network installation is not
 * enabled here: only the future verified artifact installer may add lock records.
 */
export const makeTrustedPluginManager = (
    options: TrustedPluginManagerOptions = {},
) => {
    const dataDirectory = options.dataDirectory ?? resolvePluginDataDirectory();
    const lockStore =
        options.lockStore ?? makePluginLockStore({ dataDirectory });
    const auditStore =
        options.auditStore ?? makePluginAuditStore({ dataDirectory });
    const artifactStore =
        options.artifactStore ?? makePluginArtifactStore({ dataDirectory });
    const repositoryStore =
        options.repositoryStore ?? makePluginRepositoryStore({ dataDirectory });
    const credentialStore = options.credentialStore ?? makeGitCredentialStore();
    const repositories = new Map<
        string,
        ReturnType<typeof makeTufPluginRepository>
    >();
    const records = new Map<string, PluginLockRecord>();
    const loaded = new Map<string, LoadedPlugin>();
    let startupFailure: unknown;

    const recordAudit = async (
        action: string,
        outcome: PluginAuditEvent['outcome'],
        record?: PluginLockRecord,
        errorCode?: string,
        capability?: PluginAuditEvent['capability'],
        repoId?: string,
        operationId?: PluginAuditEvent['operationId'],
        engagementId?: string,
    ): Promise<void> => {
        await auditStore.record(
            new PluginAuditEvent({
                at: Date.now(),
                pluginId: record?.pluginId,
                version: record?.version,
                publisherFingerprint: record?.publisherFingerprint,
                repositoryId: record?.repositoryId,
                operationId,
                action,
                outcome,
                errorCode,
                capability,
                repoId,
                engagementId,
            }),
        );
    };

    const recordRepositoryAudit = async (
        action: string,
        outcome: PluginAuditEvent['outcome'],
        repository: PluginRepository,
        auditErrorCode?: string,
    ): Promise<void> => {
        await auditStore.record(
            new PluginAuditEvent({
                at: Date.now(),
                publisherFingerprint: repository.publisherFingerprint,
                repositoryId: repository.id,
                action,
                outcome,
                errorCode: auditErrorCode,
            }),
        );
    };

    const load = async (record: PluginLockRecord): Promise<LoadedPlugin> => {
        if (!isSafeRelativePath(record.entrypoint)) {
            throw new PluginManagerError(
                'pluginArtifactInvalid',
                'Plugin lock record has an unsafe entrypoint.',
            );
        }
        const directory = activatedPluginDirectory(dataDirectory, record);
        const hooks = await loadTrustedPlugin(
            resolve(directory, record.entrypoint),
            {
                directory,
                log: (level, _message) => {
                    void recordAudit(`log.${level}`, 'allowed', record).catch(
                        () => undefined,
                    );
                },
            },
            { root: directory, cacheKey: record.artifactSha256 },
        );
        const declared = new Set(
            record.contributions.commands.map(command => command.id),
        );
        const implemented = Object.keys(hooks.commands ?? {});
        if (
            implemented.some(command => !declared.has(command)) ||
            [...declared].some(command => !implemented.includes(command))
        ) {
            throw new PluginManagerError(
                'pluginArtifactInvalid',
                'Trusted plugin commands must exactly match its reviewed contributions.',
            );
        }
        const plugin = { record, hooks };
        loaded.set(String(record.pluginId), plugin);
        await recordAudit('load', 'allowed', record);
        return plugin;
    };

    const ready = (async (): Promise<void> => {
        const lock = await lockStore.load();
        for (const record of lock.plugins)
            records.set(String(record.pluginId), record);
        await Promise.all(
            lock.plugins
                .filter(record => record.enabled)
                .map(async record => {
                    try {
                        await load(record);
                    } catch (error) {
                        await recordAudit(
                            'load',
                            'failed',
                            record,
                            errorCode(error),
                        );
                    }
                }),
        );
    })().catch(error => {
        startupFailure = error;
    });

    const requireReady = async (): Promise<void> => {
        await ready;
        if (startupFailure) throw startupFailure;
    };

    const repositoryOperationTails = new Map<string, Promise<void>>();
    const serializeRepositoryOperation = async <Result>(
        repositoryId: PluginRepositoryIdInput['repositoryId'],
        operation: () => Promise<Result>,
    ): Promise<Result> => {
        const key = String(repositoryId);
        const previous = repositoryOperationTails.get(key) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.then(
            () => undefined,
            () => undefined,
        );
        repositoryOperationTails.set(key, tail);
        try {
            return await result;
        } finally {
            if (repositoryOperationTails.get(key) === tail) {
                repositoryOperationTails.delete(key);
            }
        }
    };

    const pluginOperationTails = new Map<string, Promise<void>>();
    const serializePluginOperation = async <Result>(
        pluginId: string,
        operation: () => Promise<Result>,
    ): Promise<Result> => {
        const previous =
            pluginOperationTails.get(pluginId) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.then(
            () => undefined,
            () => undefined,
        );
        pluginOperationTails.set(pluginId, tail);
        try {
            return await result;
        } finally {
            if (pluginOperationTails.get(pluginId) === tail) {
                pluginOperationTails.delete(pluginId);
            }
        }
    };

    const persist = async (): Promise<void> => {
        await lockStore.write([...records.values()]);
    };

    const getRecord = async (pluginId: string): Promise<PluginLockRecord> => {
        await requireReady();
        const record = records.get(pluginId);
        if (!record) {
            throw new PluginManagerError(
                'pluginArtifactInvalid',
                `Plugin ${pluginId} is not installed.`,
            );
        }
        return record;
    };

    const installed = (record: PluginLockRecord): InstalledPlugin =>
        new InstalledPlugin({
            lock: record,
            enabled: loaded.has(String(record.pluginId)),
            grant: record.grant,
            contributions: record.contributions,
            availableVersions: [record.version],
        });

    const trustedRepository = async (
        repositoryId: PluginRepositoryIdInput['repositoryId'],
    ): Promise<ReturnType<typeof makeTufPluginRepository>> => {
        const stored = await repositoryStore.get(repositoryId);
        if (!stored?.root || stored.repository.trustState !== 'trusted')
            throw new PluginManagerError(
                'pluginRepositoryUntrusted',
                'Approve the publisher before browsing its catalog.',
            );
        const existing = repositories.get(String(repositoryId));
        if (existing) return existing;
        const repository = makeTufPluginRepository({
            root: Buffer.from(stored.root, 'base64'),
            publisherFingerprint: stored.repository.publisherFingerprint!,
            transport: makeHttpsPluginRepositoryTransport({
                url: stored.repository.url,
                getCredential: async () => {
                    if (stored.repository.credentialState === 'not needed')
                        return undefined;
                    const credential = await credentialStore.get(
                        stored.repository.url,
                    );
                    if (
                        credential &&
                        stored.repository.credentialState !== 'available'
                    )
                        await repositoryStore.setCredentialState(
                            repositoryId,
                            'available',
                        );
                    return credential;
                },
                rejectCredential: async credential => {
                    if (credential)
                        await credentialStore
                            .reject(stored.repository.url, credential)
                            .catch(() => undefined);
                    repositories.delete(String(repositoryId));
                    await repositoryStore.setCredentialState(
                        repositoryId,
                        'needs attention',
                    );
                },
            }),
            artifactStore,
            verifySignature: verifyTufEd25519Signature,
        });
        repositories.set(String(repositoryId), repository);
        return repository;
    };

    const fetchPublisherRoot = async (
        repositoryId: PluginRepositoryIdInput['repositoryId'],
        url: string,
        credentialState: PluginRepository['credentialState'],
    ): Promise<Uint8Array> => {
        try {
            return await makeHttpsPluginRepositoryTransport({
                url,
                getCredential: () =>
                    credentialState === 'not needed'
                        ? Promise.resolve(undefined)
                        : credentialStore.get(url),
                rejectCredential: async credential => {
                    if (credential)
                        await credentialStore
                            .reject(url, credential)
                            .catch(() => undefined);
                    await repositoryStore.setCredentialState(
                        repositoryId,
                        'needs attention',
                    );
                },
            }).fetchMetadata('metadata/root.json');
        } catch (error) {
            if (error instanceof PluginRepositoryTransportError) {
                throw new PluginManagerError(error.code, error.message);
            }
            if (error instanceof PluginPolicyError) {
                throw new PluginManagerError(
                    rpcPluginPolicyCode(error.code),
                    error.message,
                );
            }
            const detail =
                error instanceof Error && error.message
                    ? error.message.slice(0, 500)
                    : 'the repository did not return valid metadata.';
            throw new PluginManagerError(
                'pluginMetadataInvalid',
                `Could not fetch publisher metadata: ${detail}`,
            );
        }
    };

    const refreshTrustedCatalog = async (
        repositoryId: PluginRepositoryIdInput['repositoryId'],
        repository: ReturnType<typeof makeTufPluginRepository>,
    ): Promise<readonly PluginCatalogEntry[]> => {
        try {
            const catalog = await repository.refresh();
            await repositoryStore.setRefreshState(
                repositoryId,
                'fresh',
                Date.now(),
            );
            return catalog;
        } catch (error) {
            const freshness =
                error instanceof PluginPolicyError
                    ? error.code === 'pluginMetadataExpired'
                        ? 'expired'
                        : 'invalid'
                    : 'stale';
            await repositoryStore
                .setRefreshState(repositoryId, freshness)
                .catch(() => undefined);
            throw error;
        }
    };

    const manager = {
        runtimeStatus: async (): Promise<PluginRuntimeStatus> => {
            await ready;
            if (startupFailure) {
                return new PluginRuntimeStatus({
                    available: false,
                    reason: 'Trusted plugin state could not be loaded.',
                });
            }
            return new PluginRuntimeStatus({
                available: true,
                reason: 'Trusted local ESM extensions execute as the host user.',
            });
        },
        repositoryList: async (): Promise<readonly PluginRepository[]> =>
            (await repositoryStore.list()).map(
                entry => new PluginRepository(entry.repository),
            ),
        repositoryAdd: async (
            kind: PluginRepositoryAddInput['kind'],
            url: string,
            credential?: string,
        ): Promise<PluginRepository> => {
            validateRepositoryUrl(kind, url);
            if (!credential) return repositoryStore.add(kind, url);
            await credentialStore.replace(url, credential);
            try {
                return await repositoryStore.add(kind, url, 'available');
            } catch (error) {
                await credentialStore
                    .reject(url, credential)
                    .catch(() => undefined);
                throw error;
            }
        },
        repositoryRemove: async (
            repositoryId: PluginRepositoryIdInput['repositoryId'],
        ): Promise<void> => {
            return await serializeRepositoryOperation(
                repositoryId,
                async () => {
                    const stored = await repositoryStore.get(repositoryId);
                    if (stored) {
                        await recordRepositoryAudit(
                            'repository.removeRequested',
                            'allowed',
                            stored.repository,
                        );
                    }
                    try {
                        await repositoryStore.remove(repositoryId);
                        if (stored) {
                            await recordRepositoryAudit(
                                'repository.remove',
                                'allowed',
                                stored.repository,
                            );
                        }
                    } catch (error) {
                        if (stored) {
                            await recordRepositoryAudit(
                                'repository.remove',
                                'failed',
                                stored.repository,
                                errorCode(error),
                            );
                        }
                        throw error;
                    }
                    repositories.delete(String(repositoryId));
                },
            );
        },
        publisherTrust: async (
            repositoryId: PluginPublisherTrustInput['repositoryId'],
            fingerprint: string,
            approved: boolean,
        ): Promise<PluginRepository> => {
            return await serializeRepositoryOperation(
                repositoryId,
                async () => {
                    const stored = await repositoryStore.get(repositoryId);
                    if (!stored?.root) {
                        throw new PluginManagerError(
                            'pluginMetadataInvalid',
                            'Publisher root metadata has not been fetched.',
                        );
                    }
                    if (
                        stored.repository.publisherFingerprint !== fingerprint
                    ) {
                        await recordRepositoryAudit(
                            'publisher.trust',
                            'failed',
                            stored.repository,
                            'pluginMetadataInvalid',
                        );
                        throw new PluginManagerError(
                            'pluginMetadataInvalid',
                            'The supplied publisher fingerprint does not match fetched root metadata.',
                        );
                    }
                    if (!approved) {
                        await recordRepositoryAudit(
                            'publisher.trust',
                            'denied',
                            stored.repository,
                            'pluginRepositoryUntrusted',
                        );
                        throw new PluginManagerError(
                            'pluginRepositoryUntrusted',
                            'Publisher trust was not approved.',
                        );
                    }
                    await recordRepositoryAudit(
                        'publisher.trustRequested',
                        'allowed',
                        stored.repository,
                    );
                    try {
                        const trusted = await repositoryStore.trust(
                            repositoryId,
                            fingerprint,
                        );
                        await recordRepositoryAudit(
                            'publisher.trust',
                            'allowed',
                            trusted,
                        );
                        return trusted;
                    } catch (error) {
                        await recordRepositoryAudit(
                            'publisher.trust',
                            'failed',
                            stored.repository,
                            errorCode(error),
                        );
                        if (
                            error instanceof Error &&
                            error.message.includes('fingerprint does not match')
                        )
                            throw new PluginManagerError(
                                'pluginMetadataInvalid',
                                error.message,
                            );
                        throw error;
                    }
                },
            );
        },
        repositoryRefresh: async (
            repositoryId: PluginRepositoryIdInput['repositoryId'],
        ): Promise<PluginRepositoryRefresh> => {
            return await serializeRepositoryOperation(
                repositoryId,
                async () => {
                    const stored = await repositoryStore.get(repositoryId);
                    if (!stored)
                        throw new PluginManagerError(
                            'pluginArtifactInvalid',
                            'Plugin repository was not found.',
                        );
                    if (stored.repository.kind !== 'https')
                        throw new PluginManagerError(
                            'pluginPolicyDenied',
                            'Git-backed plugin repositories are not implemented yet.',
                        );
                    if (stored.repository.trustState !== 'trusted') {
                        const root = await fetchPublisherRoot(
                            repositoryId,
                            stored.repository.url,
                            stored.repository.credentialState,
                        );
                        const nextFingerprint = `sha256:${createHash('sha256').update(root).digest('hex')}`;
                        const proposedRepository = new PluginRepository({
                            ...stored.repository,
                            publisherFingerprint: nextFingerprint,
                            trustState: 'untrusted',
                            freshness: 'fresh',
                        });
                        await recordRepositoryAudit(
                            stored.repository.publisherFingerprint
                                ? 'publisher.rootChangeRequested'
                                : 'publisher.rootFetchRequested',
                            'allowed',
                            proposedRepository,
                        );
                        const repository = await repositoryStore.setRoot(
                            repositoryId,
                            nextFingerprint,
                            root,
                        );
                        repositories.delete(String(repositoryId));
                        await recordRepositoryAudit(
                            stored.repository.publisherFingerprint
                                ? 'publisher.rootChanged'
                                : 'publisher.rootFetched',
                            'allowed',
                            repository,
                        );
                        return new PluginRepositoryRefresh({
                            repository,
                            catalogEntryCount: 0,
                        });
                    }
                    const repository = await trustedRepository(repositoryId);
                    const catalog = await refreshTrustedCatalog(
                        repositoryId,
                        repository,
                    );
                    const currentRepository =
                        await trustedRepository(repositoryId);
                    if (currentRepository !== repository) {
                        throw new PluginManagerError(
                            'pluginRepositoryUntrusted',
                            'Plugin repository trust changed during refresh.',
                        );
                    }
                    const current = await repositoryStore.get(repositoryId);
                    return new PluginRepositoryRefresh({
                        repository: current!.repository,
                        catalogEntryCount: catalog.length,
                    });
                },
            );
        },
        catalogList: async (
            repositoryId: PluginRepositoryIdInput['repositoryId'],
        ): Promise<readonly PluginCatalogEntry[]> => {
            return await serializeRepositoryOperation(
                repositoryId,
                async () => {
                    const repository = await trustedRepository(repositoryId);
                    const catalog = await refreshTrustedCatalog(
                        repositoryId,
                        repository,
                    );
                    if (
                        (await trustedRepository(repositoryId)) !== repository
                    ) {
                        throw new PluginManagerError(
                            'pluginRepositoryUntrusted',
                            'Plugin repository trust changed during catalog refresh.',
                        );
                    }
                    return catalog;
                },
            );
        },
        install: async (
            input: PluginInstallInput,
        ): Promise<InstalledPlugin> => {
            return await serializeRepositoryOperation(
                input.repositoryId,
                async () =>
                    await serializePluginOperation(input.pluginId, async () => {
                        const repository = await trustedRepository(
                            input.repositoryId,
                        );
                        const verifiedTarget = await repository.stage(
                            input.pluginId,
                            input.version,
                        );
                        if (
                            verifiedTarget.target.artifactSha256 !==
                                input.artifactSha256 ||
                            pluginReviewToken(verifiedTarget.target) !==
                                input.reviewToken
                        ) {
                            throw new PluginManagerError(
                                'pluginMetadataInvalid',
                                'The reviewed plugin artifact changed. Review it again before installing.',
                            );
                        }
                        if (
                            (await trustedRepository(input.repositoryId)) !==
                            repository
                        ) {
                            throw new PluginManagerError(
                                'pluginRepositoryUntrusted',
                                'Plugin repository trust changed during installation.',
                            );
                        }
                        return manager.installVerified({
                            target: verifiedTarget.target,
                            repositoryId: input.repositoryId,
                            tufTargetVersion: verifiedTarget.tufTargetVersion,
                            grant: input.grant,
                        });
                    }),
            );
        },
        installReview: async (
            input: PluginInstallReviewInput,
        ): Promise<PluginInstallReview> => {
            return await serializeRepositoryOperation(
                input.repositoryId,
                async () => {
                    const repository = await trustedRepository(
                        input.repositoryId,
                    );
                    const review = await repository.review(
                        input.pluginId,
                        input.version,
                    );
                    if (
                        (await trustedRepository(input.repositoryId)) !==
                        repository
                    ) {
                        throw new PluginManagerError(
                            'pluginRepositoryUntrusted',
                            'Plugin repository trust changed during install review.',
                        );
                    }
                    return new PluginInstallReview({
                        ...review,
                        reviewToken: pluginReviewToken(review.target),
                    });
                },
            );
        },
        list: async (): Promise<readonly InstalledPlugin[]> => {
            await requireReady();
            return [...records.values()].map(installed);
        },
        installVerified: async (
            install: VerifiedPluginInstall,
        ): Promise<InstalledPlugin> => {
            await requireReady();
            const pluginId = String(install.target.pluginId);
            if (records.has(pluginId)) {
                throw new PluginManagerError(
                    'pluginPolicyDenied',
                    `Plugin ${pluginId} is already installed; use a reviewed update instead.`,
                );
            }
            try {
                const activated = await artifactStore.activate(
                    install.target,
                    install.grant,
                );
                const record = new PluginLockRecord({
                    pluginId: install.target.pluginId,
                    version: install.target.version,
                    artifactSha256: install.target.artifactSha256,
                    repositoryId: install.repositoryId,
                    tufTargetVersion: install.tufTargetVersion,
                    publisherFingerprint: install.target.publisherFingerprint,
                    manifestCapabilityDigest: install.target.capabilityDigest,
                    grantDigest: await digestGrant(install.grant),
                    entrypoint: activated.manifest.entrypoint,
                    enabled: false,
                    grant: install.grant,
                    contributions: activated.manifest.contributes,
                });
                records.set(pluginId, record);
                await persist();
                await recordAudit('install', 'allowed', record);
                return installed(record);
            } catch (error) {
                await recordAudit(
                    'install',
                    'failed',
                    undefined,
                    errorCode(error),
                );
                throw error;
            }
        },
        enable: async (pluginId: string): Promise<InstalledPlugin> => {
            const record = await getRecord(pluginId);
            if (!loaded.has(pluginId)) {
                try {
                    await load(record);
                } catch (error) {
                    await recordAudit(
                        'enable',
                        'failed',
                        record,
                        errorCode(error),
                    );
                    throw error;
                }
            }
            const enabled = new PluginLockRecord({ ...record, enabled: true });
            records.set(pluginId, enabled);
            loaded.set(pluginId, { ...loaded.get(pluginId)!, record: enabled });
            await persist();
            await recordAudit('enable', 'allowed', enabled);
            return installed(enabled);
        },
        disable: async (pluginId: string): Promise<InstalledPlugin> => {
            const record = await getRecord(pluginId);
            const plugin = loaded.get(pluginId);
            loaded.delete(pluginId);
            if (plugin?.hooks.dispose) {
                try {
                    await plugin.hooks.dispose();
                } catch (error) {
                    await recordAudit(
                        'dispose',
                        'failed',
                        record,
                        errorCode(error),
                    );
                }
            }
            const disabled = new PluginLockRecord({
                ...record,
                enabled: false,
            });
            records.set(pluginId, disabled);
            await persist();
            await recordAudit('disable', 'allowed', disabled);
            return installed(disabled);
        },
        uninstall: async (pluginId: string): Promise<void> => {
            const record = await getRecord(pluginId);
            if (loaded.has(pluginId)) await manager.disable(pluginId);
            records.delete(pluginId);
            await persist();
            try {
                await artifactStore.remove(pluginId);
                await recordAudit('uninstall', 'allowed', record);
            } catch (error) {
                await recordAudit(
                    'uninstall',
                    'failed',
                    record,
                    errorCode(error),
                );
                throw error;
            }
        },
        invoke: async (input: PluginInvokeInput): Promise<PluginInvocation> => {
            const record = await getRecord(String(input.pluginId));
            const operationId = PluginOperationId.make(randomUUID());
            const plugin = loaded.get(String(input.pluginId));
            if (!plugin) {
                await recordAudit(
                    'invoke',
                    'denied',
                    record,
                    'pluginPermissionDenied',
                    undefined,
                    input.repoId,
                    operationId,
                    input.engagementId,
                );
                throw new PluginManagerError(
                    'pluginPermissionDenied',
                    `Plugin ${input.pluginId} is disabled or could not be loaded.`,
                );
            }
            if (
                !record.contributions.commands.some(
                    command => command.id === input.commandId,
                )
            ) {
                await recordAudit(
                    'invoke',
                    'denied',
                    record,
                    'pluginPermissionDenied',
                    undefined,
                    input.repoId,
                    operationId,
                    input.engagementId,
                );
                throw new PluginManagerError(
                    'pluginPermissionDenied',
                    `Plugin command ${input.commandId} is not declared by ${input.pluginId}.`,
                );
            }
            const command = plugin.hooks.commands?.[input.commandId];
            if (!command) {
                await recordAudit(
                    'invoke',
                    'failed',
                    record,
                    'pluginWorkerFailed',
                    undefined,
                    input.repoId,
                    operationId,
                    input.engagementId,
                );
                throw new PluginManagerError(
                    'pluginWorkerFailed',
                    `Plugin command ${input.commandId} is not available.`,
                );
            }

            const hookTargets = [...loaded.values()].toSorted((left, right) =>
                String(left.record.pluginId).localeCompare(
                    String(right.record.pluginId),
                ),
            );
            const execution = {
                operationId: String(operationId),
                pluginId: String(input.pluginId),
                commandId: input.commandId,
                repoId: input.repoId,
                engagementId: input.engagementId,
            };
            const dispatchToolHooks = async (
                stage: 'before' | 'after',
                state?: 'completed' | 'failed',
            ): Promise<void> => {
                for (const target of hookTargets) {
                    if (
                        stage === 'before'
                            ? !target.hooks.toolExecuteBefore
                            : !target.hooks.toolExecuteAfter
                    )
                        continue;
                    try {
                        if (stage === 'before')
                            await target.hooks.toolExecuteBefore?.(execution);
                        else
                            await target.hooks.toolExecuteAfter?.({
                                ...execution,
                                state: state!,
                            });
                        await recordAudit(
                            `hook.toolExecute${stage === 'before' ? 'Before' : 'After'}`,
                            'allowed',
                            target.record,
                            undefined,
                            undefined,
                            input.repoId,
                            operationId,
                            input.engagementId,
                        ).catch(() => undefined);
                    } catch (error) {
                        await recordAudit(
                            `hook.toolExecute${stage === 'before' ? 'Before' : 'After'}`,
                            'failed',
                            target.record,
                            errorCode(error),
                            undefined,
                            input.repoId,
                            operationId,
                            input.engagementId,
                        ).catch(() => undefined);
                    }
                }
            };

            await dispatchToolHooks('before');
            let outcome: Pick<PluginInvocation, 'output' | 'result'>;
            try {
                outcome = serializePluginOutput(
                    await command(input.input, {
                        repoId: input.repoId,
                        engagementId: input.engagementId,
                    }),
                );
                await recordAudit(
                    'invoke',
                    'allowed',
                    record,
                    undefined,
                    'ui.contribute',
                    input.repoId,
                    operationId,
                );
            } catch (error) {
                await recordAudit(
                    'invoke',
                    'failed',
                    record,
                    errorCode(error),
                    'ui.contribute',
                    input.repoId,
                    operationId,
                );
                await dispatchToolHooks('after', 'failed');
                throw classifiedPluginError(error);
            }

            await dispatchToolHooks('after', 'completed');

            // Hooks see completed commands in a stable order, even if an earlier hook fails.
            await hookTargets.reduce(
                (chain, target) =>
                    chain.then(async () => {
                        if (!target.hooks.commandExecuted) return;
                        try {
                            await target.hooks.commandExecuted(input.commandId);
                            await recordAudit(
                                'hook.commandExecuted',
                                'allowed',
                                target.record,
                                undefined,
                                undefined,
                                input.repoId,
                                operationId,
                            );
                        } catch (error) {
                            await recordAudit(
                                'hook.commandExecuted',
                                'failed',
                                target.record,
                                errorCode(error),
                                undefined,
                                input.repoId,
                                operationId,
                            );
                        }
                    }),
                Promise.resolve(),
            );
            return new PluginInvocation({
                operationId,
                state: 'completed',
                ...outcome,
            });
        },
        auditList: async (
            input: PluginAuditListInput,
        ): Promise<PluginAuditPage> => {
            await requireReady();
            const offset = Number(input.cursor ?? '0');
            const start =
                Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
            const events = (await auditStore.list()).filter(
                event =>
                    input.pluginId === undefined ||
                    event.pluginId === input.pluginId,
            );
            const page = events.slice(start, start + 100);
            return new PluginAuditPage({
                events: page,
                nextCursor:
                    start + page.length < events.length
                        ? String(start + page.length)
                        : undefined,
            });
        },
    };
    return manager;
};

const toGitError = (error: unknown): GitError =>
    error instanceof PluginManagerError
        ? new GitError({ code: error.code, message: error.message })
        : error instanceof PluginPolicyError
          ? new GitError({
                code: rpcPluginPolicyCode(error.code),
                message: error.message,
            })
          : error instanceof PluginRepositoryTransportError
            ? new GitError({ code: error.code, message: error.message })
            : new GitError({
                  code: 'pluginWorkerFailed',
                  message: 'Trusted plugin operation failed.',
              });

const effectFrom = <A>(
    operation: () => Promise<A>,
): Effect.Effect<A, GitError> =>
    Effect.tryPromise({ try: operation, catch: toGitError });

/** The server's lifecycle layer. It starts enabled reviewed modules from the lock file. */
export const trustedPluginManagerLayer = Layer.sync(PluginManager, () => {
    const manager = makeTrustedPluginManager();
    return {
        runtimeStatus: () => effectFrom(manager.runtimeStatus),
        repositoryList: () => effectFrom(manager.repositoryList),
        repositoryAdd: input =>
            effectFrom(() =>
                manager.repositoryAdd(input.kind, input.url, input.credential),
            ),
        repositoryRefresh: input =>
            effectFrom(() => manager.repositoryRefresh(input.repositoryId)),
        repositoryRemove: input =>
            effectFrom(() => manager.repositoryRemove(input.repositoryId)),
        publisherTrust: input =>
            effectFrom(() =>
                manager.publisherTrust(
                    input.repositoryId,
                    input.rootFingerprint,
                    input.approved,
                ),
            ),
        catalogList: input =>
            effectFrom(() => manager.catalogList(input.repositoryId)),
        install: input => effectFrom(() => manager.install(input)),
        installReview: input => effectFrom(() => manager.installReview(input)),
        list: () => effectFrom(manager.list),
        enable: input =>
            effectFrom(() => manager.enable(String(input.pluginId))),
        disable: input =>
            effectFrom(() => manager.disable(String(input.pluginId))),
        uninstall: input =>
            effectFrom(() => manager.uninstall(String(input.pluginId))),
        auditList: input => effectFrom(() => manager.auditList(input)),
        invoke: input => effectFrom(() => manager.invoke(input)),
    };
});

const isSafePathComponent = (value: string): boolean =>
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..';

const errorCode = (error: unknown): string =>
    error instanceof PluginManagerError || error instanceof PluginPolicyError
        ? error.code
        : 'pluginWorkerFailed';

const classifiedPluginError = (error: unknown): PluginManagerError => {
    if (error instanceof PluginManagerError) return error;
    if (error instanceof PluginPolicyError)
        return new PluginManagerError(
            rpcPluginPolicyCode(error.code),
            error.message,
        );
    return new PluginManagerError(
        'pluginWorkerFailed',
        'Plugin command failed.',
    );
};

const rpcPluginPolicyCode = (code: PluginPolicyError['code']): GitErrorCode =>
    code === 'pluginRepositoryInvalid' ? 'pluginMetadataInvalid' : code;

const serializePluginOutput = (
    value: unknown,
): Pick<PluginInvocation, 'output' | 'result'> => {
    if (value === undefined) return {};
    const result = Schema.decodeUnknownOption(PluginCommandResult)(value);
    if (result._tag === 'Some') {
        // Structured results are serialized as JSON on the RPC boundary.
        assertOutputLimit(JSON.stringify(result.value));
        return { result: result.value };
    }
    const output = typeof value === 'string' ? value : JSON.stringify(value);
    // Legacy output is carried as a string, so measure its UTF-8 payload rather
    // than JSON escaping that happens only during the enclosing RPC encoding.
    assertOutputLimit(output);
    return { output };
};

const assertOutputLimit = (output: string): void => {
    if (new TextEncoder().encode(output).byteLength > 1024 * 1024) {
        throw new PluginManagerError(
            'resultTooLarge',
            'Plugin command output exceeds the 1 MiB limit.',
        );
    }
};
