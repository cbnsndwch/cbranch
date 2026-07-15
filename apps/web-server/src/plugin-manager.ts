// Plugin execution stays unavailable until a platform sandbox supervisor is installed.
// This service deliberately exposes no fallback worker, Node VM, or process execution.

import {
    PluginAuditPage,
    type InstalledPlugin,
    type PluginAuditListInput,
    type PluginCatalogEntry,
    type PluginIdInput,
    type PluginInstallInput,
    type PluginInvocation,
    type PluginInvokeInput,
    type PluginPublisherTrustInput,
    type PluginRepository,
    type PluginRepositoryAddInput,
    type PluginRepositoryIdInput,
    type PluginRepositoryRefresh,
    PluginRuntimeStatus,
    type PluginRollbackInput,
    type PluginUpdateInput,
} from '@cbranch/plugin-contract';
import { Context, Effect, Layer } from 'effect';

import { GitError } from '@cbranch/rpc-contract';

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

const sandboxUnavailable = <A>(): Effect.Effect<A, GitError> =>
    Effect.fail(
        new GitError({
            code: 'pluginSandboxUnavailable',
            message:
                'Plugin installation and execution are unavailable until a supported sandbox runtime is installed.',
        }),
    );

/**
 * Safe default while the cross-platform OS sandbox decision remains unresolved.
 * Read-only list calls remain deterministic and do not pretend an unverified cache is
 * a plugin repository or installation.
 */
export const pluginManagerUnavailableLayer = Layer.succeed(PluginManager, {
    runtimeStatus: () =>
        Effect.succeed(
            new PluginRuntimeStatus({
                available: false,
                reason: 'No supported OS sandbox runtime is installed for plugin workers.',
            }),
        ),
    repositoryList: () => Effect.succeed([]),
    repositoryAdd: () => sandboxUnavailable(),
    repositoryRefresh: () => sandboxUnavailable(),
    repositoryRemove: () => sandboxUnavailable(),
    publisherTrust: () => sandboxUnavailable(),
    catalogList: () => Effect.succeed([]),
    install: () => sandboxUnavailable(),
    list: () => Effect.succeed([]),
    enable: () => sandboxUnavailable(),
    disable: () => sandboxUnavailable(),
    update: () => sandboxUnavailable(),
    rollback: () => sandboxUnavailable(),
    auditList: () =>
        Effect.succeed(
            new PluginAuditPage({ events: [], nextCursor: undefined }),
        ),
    invoke: () => sandboxUnavailable(),
});
