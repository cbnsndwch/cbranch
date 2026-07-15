// Trusted extensions run in the host process by explicit product decision. Their grants
// govern only cbranch-provided APIs; they are not a security boundary around Node access.

import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
    PluginAuditPage,
    PluginInvocation,
    PluginLockRecord,
    PluginOperationId,
    PluginRepositoryRefresh,
    PluginRuntimeStatus,
    PluginAuditEvent,
    type InstalledPlugin,
    type PluginAuditListInput,
    type PluginCatalogEntry,
    type PluginIdInput,
    type PluginInstallInput,
    type PluginInvokeInput,
    type PluginPublisherTrustInput,
    type PluginRepository,
    type PluginRepositoryAddInput,
    type PluginRepositoryIdInput,
    type PluginRollbackInput,
    type PluginUpdateInput,
} from '@cbranch/plugin-contract';
import {
    digestGrant,
    isSafeRelativePath,
    validateRepositoryUrl,
} from '@cbranch/plugin-runtime';
import { Context, Effect, Layer } from 'effect';

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
import { makeHttpsPluginRepositoryTransport } from './plugin-repository-transport';
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
    readonly list: () => Effect.Effect<readonly InstalledPlugin[], GitError>;
    readonly enable: (
        input: PluginIdInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
    readonly disable: (
        input: PluginIdInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
    readonly update: (
        input: PluginUpdateInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
    readonly rollback: (
        input: PluginRollbackInput,
    ) => Effect.Effect<InstalledPlugin, GitError>;
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

    const installed = (record: PluginLockRecord): InstalledPlugin => ({
        lock: record,
        enabled: loaded.has(String(record.pluginId)),
        grant: record.grant,
        contributions: record.contributions,
        availableVersions: [record.version],
    });

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
                reason: 'Trusted local ESM extensions execute as the host user. Remote installation remains unavailable until TUF repository verification is implemented.',
            });
        },
        repositoryList: async (): Promise<readonly PluginRepository[]> =>
            (await repositoryStore.list()).map(entry => entry.repository),
        repositoryAdd: async (
            kind: PluginRepositoryAddInput['kind'],
            url: string,
        ): Promise<PluginRepository> => {
            validateRepositoryUrl(kind, url);
            return repositoryStore.add(kind, url);
        },
        publisherTrust: async (
            repositoryId: PluginPublisherTrustInput['repositoryId'],
            fingerprint: string,
            approved: boolean,
        ): Promise<PluginRepository> => {
            const stored = await repositoryStore.get(repositoryId);
            if (
                !stored?.root ||
                stored.repository.publisherFingerprint !== fingerprint
            )
                throw new PluginManagerError(
                    'pluginMetadataInvalid',
                    'The supplied publisher fingerprint does not match fetched root metadata.',
                );
            if (!approved)
                throw new PluginManagerError(
                    'pluginRepositoryUntrusted',
                    'Publisher trust was not approved.',
                );
            return repositoryStore.trust(
                repositoryId,
                fingerprint,
                Buffer.from(stored.root, 'base64'),
            );
        },
        repositoryRefresh: async (
            repositoryId: PluginRepositoryIdInput['repositoryId'],
        ): Promise<PluginRepositoryRefresh> => {
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
                const root = await makeHttpsPluginRepositoryTransport({
                    url: stored.repository.url,
                }).fetchMetadata('metadata/root.json');
                const repository = await repositoryStore.setRoot(
                    repositoryId,
                    `sha256:${createHash('sha256').update(root).digest('hex')}`,
                    root,
                );
                return new PluginRepositoryRefresh({
                    repository,
                    catalogEntryCount: 0,
                });
            }
            if (!stored.root)
                throw new PluginManagerError(
                    'pluginRepositoryUntrusted',
                    'Approve the fetched publisher root before refreshing this repository.',
                );
            const repository = makeTufPluginRepository({
                root: Buffer.from(stored.root, 'base64'),
                transport: makeHttpsPluginRepositoryTransport({
                    url: stored.repository.url,
                }),
                artifactStore,
                verifySignature: verifyTufEd25519Signature,
            });
            const catalog = await repository.refresh();
            repositories.set(String(repositoryId), repository);
            return new PluginRepositoryRefresh({
                repository: stored.repository,
                catalogEntryCount: catalog.length,
            });
        },
        catalogList: async (
            repositoryId: PluginRepositoryIdInput['repositoryId'],
        ): Promise<readonly PluginCatalogEntry[]> => {
            const repository = repositories.get(String(repositoryId));
            if (!repository)
                throw new PluginManagerError(
                    'pluginMetadataInvalid',
                    'Refresh the trusted plugin repository before browsing its catalog.',
                );
            return repository.refresh();
        },
        install: async (
            input: PluginInstallInput,
        ): Promise<InstalledPlugin> => {
            const repository = repositories.get(String(input.repositoryId));
            if (!repository)
                throw new PluginManagerError(
                    'pluginMetadataInvalid',
                    'Refresh the trusted plugin repository before installing.',
                );
            const target = await repository.stage(
                input.pluginId,
                input.version,
            );
            return manager.installVerified({
                target,
                repositoryId: input.repositoryId,
                // The target role version is retained by the repository adapter in the
                // next cut; installation is still bound to its signed artifact digest.
                tufTargetVersion: 1,
                grant: input.grant,
            });
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
                );
                throw new PluginManagerError(
                    'pluginWorkerFailed',
                    `Plugin command ${input.commandId} is not available.`,
                );
            }

            let output: string | undefined;
            try {
                output = serializePluginOutput(
                    await command(input.input, { repoId: input.repoId }),
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
                throw new PluginManagerError(
                    'pluginWorkerFailed',
                    `Plugin command ${input.commandId} failed.`,
                );
            }

            // Hooks see completed commands in a stable order, even if an earlier hook fails.
            await [...loaded.values()]
                .toSorted((left, right) =>
                    String(left.record.pluginId).localeCompare(
                        String(right.record.pluginId),
                    ),
                )
                .reduce(
                    (chain, target) =>
                        chain.then(async () => {
                            if (!target.hooks.commandExecuted) return;
                            try {
                                await target.hooks.commandExecuted(
                                    input.commandId,
                                );
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
                output,
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

const remoteInstallationUnavailable = <A>(): Effect.Effect<A, GitError> =>
    Effect.fail(
        new GitError({
            code: 'pluginPolicyDenied',
            message:
                'Remote plugin repositories and installation remain unavailable until TUF repository verification is implemented.',
        }),
    );

const toGitError = (error: unknown): GitError =>
    error instanceof PluginManagerError
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
            effectFrom(() => manager.repositoryAdd(input.kind, input.url)),
        repositoryRefresh: input =>
            effectFrom(() => manager.repositoryRefresh(input.repositoryId)),
        repositoryRemove: () => remoteInstallationUnavailable(),
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
        list: () => effectFrom(manager.list),
        enable: input =>
            effectFrom(() => manager.enable(String(input.pluginId))),
        disable: input =>
            effectFrom(() => manager.disable(String(input.pluginId))),
        update: () => remoteInstallationUnavailable(),
        rollback: () => remoteInstallationUnavailable(),
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
    error instanceof PluginManagerError ? error.code : 'pluginWorkerFailed';

const serializePluginOutput = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    const output = typeof value === 'string' ? value : JSON.stringify(value);
    if (output.length > 1024 * 1024) {
        throw new PluginManagerError(
            'resultTooLarge',
            'Plugin command output exceeds the 1 MiB limit.',
        );
    }
    return output;
};
