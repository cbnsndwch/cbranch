import { Schema } from 'effect';

/** Bump only for a breaking plugin manifest or broker protocol change. */
export const PLUGIN_CONTRACT_VERSION = 1;

export const PluginId = Schema.String.pipe(Schema.brand('cbranch/PluginId'));
export type PluginId = typeof PluginId.Type;

export const PluginRepositoryId = Schema.String.pipe(
    Schema.brand('cbranch/PluginRepositoryId'),
);
export type PluginRepositoryId = typeof PluginRepositoryId.Type;

export const PluginOperationId = Schema.String.pipe(
    Schema.brand('cbranch/PluginOperationId'),
);
export type PluginOperationId = typeof PluginOperationId.Type;

export const PluginCapability = Schema.Literals([
    'ui.contribute',
    'git.read',
    'git.write',
    'workspace.read',
    'workspace.write',
    'network.connect',
    'automation.exec',
    'hostAutomation',
]);
export type PluginCapability = typeof PluginCapability.Type;

export const PluginRepositorySourceKind = Schema.Literals(['https', 'git']);
export type PluginRepositorySourceKind = typeof PluginRepositorySourceKind.Type;

export const PluginRepositoryTrustState = Schema.Literals([
    'untrusted',
    'trusted',
    'revoked',
]);
export type PluginRepositoryTrustState = typeof PluginRepositoryTrustState.Type;

export const PluginRepositoryFreshness = Schema.Literals([
    'unknown',
    'fresh',
    'stale',
    'expired',
    'invalid',
]);
export type PluginRepositoryFreshness = typeof PluginRepositoryFreshness.Type;

export const PluginCredentialState = Schema.Literals([
    'not needed',
    'available',
    'needs attention',
]);
export type PluginCredentialState = typeof PluginCredentialState.Type;

/** Host-reported execution availability; the reason is safe for display and auditing. */
export class PluginRuntimeStatus extends Schema.Class<PluginRuntimeStatus>(
    'PluginRuntimeStatus',
)({
    available: Schema.Boolean,
    reason: Schema.optional(Schema.String),
}) {}

/** Redacted source descriptor. Credentials are never represented here. */
export class PluginRepository extends Schema.Class<PluginRepository>(
    'PluginRepository',
)({
    id: PluginRepositoryId,
    kind: PluginRepositorySourceKind,
    url: Schema.String,
    publisherFingerprint: Schema.optional(Schema.String),
    trustState: PluginRepositoryTrustState,
    freshness: PluginRepositoryFreshness,
    credentialState: PluginCredentialState,
    lastSuccessfulRefreshAt: Schema.optional(Schema.Number),
}) {}

/** Named host-owned command locations; arbitrary menu paths are not accepted. */
export const PluginCommandPlacement = Schema.Literals(['plugins', 'tools']);
export type PluginCommandPlacement = typeof PluginCommandPlacement.Type;

/** A strictly declarative command rendered by cbranch, never plugin-supplied UI code. */
export class PluginCommandContribution extends Schema.Class<PluginCommandContribution>(
    'PluginCommandContribution',
)({
    id: Schema.String,
    title: Schema.String,
    placement: Schema.optional(PluginCommandPlacement),
    /** Host-rendered nested labels below the fixed Plugins top-level menu. */
    submenu: Schema.optional(Schema.Array(Schema.String)),
}) {}

export const PluginPanelPlacement = Schema.Literals(['plugins']);
export type PluginPanelPlacement = typeof PluginPanelPlacement.Type;

export const PluginPanelContent = Schema.Union([
    Schema.TaggedStruct('text', { text: Schema.String }),
    Schema.TaggedStruct('keyValue', {
        items: Schema.Array(
            Schema.Struct({ label: Schema.String, value: Schema.String }),
        ),
    }),
]);
export type PluginPanelContent = typeof PluginPanelContent.Type;

/** A host-rendered panel descriptor with no markup, script, style, or URL fields. */
export class PluginPanelContribution extends Schema.Class<PluginPanelContribution>(
    'PluginPanelContribution',
)({
    id: Schema.String,
    title: Schema.String,
    placement: Schema.optional(PluginPanelPlacement),
    content: Schema.optional(PluginPanelContent),
}) {}

export class PluginContributions extends Schema.Class<PluginContributions>(
    'PluginContributions',
)({
    commands: Schema.Array(PluginCommandContribution),
    panels: Schema.Array(PluginPanelContribution),
}) {}

export class PluginAutomationAction extends Schema.Class<PluginAutomationAction>(
    'PluginAutomationAction',
)({
    id: Schema.String,
    executable: Schema.String,
    arguments: Schema.Array(Schema.String),
    workingDirectory: Schema.Literals(['repository', 'engagement']),
    environment: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class PluginEngines extends Schema.Class<PluginEngines>('PluginEngines')(
    {
        cbranch: Schema.String,
        pluginContract: Schema.Number,
    },
) {}

/** The canonical manifest found inside a verified plugin artifact. */
export class PluginManifest extends Schema.Class<PluginManifest>(
    'PluginManifest',
)({
    schemaVersion: Schema.Number,
    id: PluginId,
    version: Schema.String,
    displayName: Schema.String,
    publisherFingerprint: Schema.String,
    engines: PluginEngines,
    // Trusted extensions are local ESM modules. This is a distribution/runtime format,
    // not an isolation boundary: enabled code executes with the host user's authority.
    runtime: Schema.Literal('trusted-esm'),
    entrypoint: Schema.String,
    capabilities: Schema.Array(PluginCapability),
    automation: Schema.Array(PluginAutomationAction),
    contributes: PluginContributions,
}) {}

/** User-approved, capability-specific limits. All fields are descriptive, never secret. */
export class PluginGrant extends Schema.Class<PluginGrant>('PluginGrant')({
    capabilities: Schema.Array(PluginCapability),
    repositoryIds: Schema.Array(Schema.String),
    networkOrigins: Schema.Array(Schema.String),
    automationActionIds: Schema.Array(Schema.String),
    hostAutomationApproved: Schema.Boolean,
}) {}

export class PluginCatalogEntry extends Schema.Class<PluginCatalogEntry>(
    'PluginCatalogEntry',
)({
    pluginId: PluginId,
    version: Schema.String,
    publisherFingerprint: Schema.String,
    artifactPath: Schema.String,
    artifactSha256: Schema.String,
    artifactLength: Schema.Number,
    minimumCbranchVersion: Schema.String,
    pluginContractVersion: Schema.Number,
    capabilityDigest: Schema.String,
    releaseNotes: Schema.String,
    advisoryIds: Schema.Array(Schema.String),
}) {}

export class PluginLockRecord extends Schema.Class<PluginLockRecord>(
    'PluginLockRecord',
)({
    pluginId: PluginId,
    version: Schema.String,
    artifactSha256: Schema.String,
    repositoryId: PluginRepositoryId,
    tufTargetVersion: Schema.Number,
    publisherFingerprint: Schema.String,
    manifestCapabilityDigest: Schema.String,
    grantDigest: Schema.String,
    // The activated directory is derived from this immutable identity; the entrypoint
    // is retained so startup can reload the exact reviewed module without a catalog.
    entrypoint: Schema.String,
    enabled: Schema.Boolean,
    grant: PluginGrant,
    contributions: PluginContributions,
}) {}

export class InstalledPlugin extends Schema.Class<InstalledPlugin>(
    'InstalledPlugin',
)({
    lock: PluginLockRecord,
    enabled: Schema.Boolean,
    grant: PluginGrant,
    contributions: PluginContributions,
    availableVersions: Schema.Array(Schema.String),
}) {}

export const PluginAuditOutcome = Schema.Literals([
    'allowed',
    'denied',
    'failed',
]);
export type PluginAuditOutcome = typeof PluginAuditOutcome.Type;

export class PluginAuditEvent extends Schema.Class<PluginAuditEvent>(
    'PluginAuditEvent',
)({
    at: Schema.Number,
    pluginId: Schema.optional(PluginId),
    version: Schema.optional(Schema.String),
    publisherFingerprint: Schema.optional(Schema.String),
    repositoryId: Schema.optional(PluginRepositoryId),
    operationId: Schema.optional(PluginOperationId),
    action: Schema.String,
    capability: Schema.optional(PluginCapability),
    repoId: Schema.optional(Schema.String),
    engagementId: Schema.optional(Schema.String),
    outcome: PluginAuditOutcome,
    errorCode: Schema.optional(Schema.String),
}) {}

export class PluginAuditPage extends Schema.Class<PluginAuditPage>(
    'PluginAuditPage',
)({
    events: Schema.Array(PluginAuditEvent),
    nextCursor: Schema.optional(Schema.String),
}) {}

export const PluginInvocationState = Schema.Literals([
    'queued',
    'running',
    'completed',
    'cancelled',
    'failed',
]);
export type PluginInvocationState = typeof PluginInvocationState.Type;

export const PluginCommandResult = Schema.Union([
    Schema.TaggedStruct('notice', { message: Schema.String }),
    Schema.TaggedStruct('dialog', {
        title: Schema.String,
        body: Schema.String,
    }),
    Schema.TaggedStruct('panel', { panelId: Schema.String }),
]);
export type PluginCommandResult = typeof PluginCommandResult.Type;

export class PluginInvocation extends Schema.Class<PluginInvocation>(
    'PluginInvocation',
)({
    operationId: PluginOperationId,
    state: PluginInvocationState,
    output: Schema.optional(Schema.String),
    result: Schema.optional(PluginCommandResult),
}) {}

export const PluginRepositoryAddInput = Schema.Struct({
    kind: PluginRepositorySourceKind,
    url: Schema.String,
    // Accepted once by the guarded host RPC and never included in a result or record.
    credential: Schema.optional(Schema.String),
});
export type PluginRepositoryAddInput = typeof PluginRepositoryAddInput.Type;

export const PluginRepositoryIdInput = Schema.Struct({
    repositoryId: PluginRepositoryId,
});
export type PluginRepositoryIdInput = typeof PluginRepositoryIdInput.Type;

export const PluginPublisherTrustInput = Schema.Struct({
    repositoryId: PluginRepositoryId,
    rootFingerprint: Schema.String,
    approved: Schema.Boolean,
});
export type PluginPublisherTrustInput = typeof PluginPublisherTrustInput.Type;

export const PluginInstallInput = Schema.Struct({
    repositoryId: PluginRepositoryId,
    pluginId: PluginId,
    version: Schema.String,
    artifactSha256: Schema.String,
    grant: PluginGrant,
});
export type PluginInstallInput = typeof PluginInstallInput.Type;

/** Verified, non-executing artifact details shown before a user installs a plugin. */
export class PluginInstallReview extends Schema.Class<PluginInstallReview>(
    'PluginInstallReview',
)({
    target: PluginCatalogEntry,
    manifest: PluginManifest,
}) {}

export const PluginInstallReviewInput = Schema.Struct({
    repositoryId: PluginRepositoryId,
    pluginId: PluginId,
    version: Schema.String,
});
export type PluginInstallReviewInput = typeof PluginInstallReviewInput.Type;

export const PluginIdInput = Schema.Struct({ pluginId: PluginId });
export type PluginIdInput = typeof PluginIdInput.Type;

export const PluginAuditListInput = Schema.Struct({
    pluginId: Schema.optional(PluginId),
    cursor: Schema.optional(Schema.String),
});
export type PluginAuditListInput = typeof PluginAuditListInput.Type;

export const PluginInvokeInput = Schema.Struct({
    pluginId: PluginId,
    commandId: Schema.String,
    repoId: Schema.String,
    engagementId: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Unknown),
});
export type PluginInvokeInput = typeof PluginInvokeInput.Type;

export class PluginRepositoryRefresh extends Schema.Class<PluginRepositoryRefresh>(
    'PluginRepositoryRefresh',
)({
    repository: PluginRepository,
    catalogEntryCount: Schema.Number,
}) {}

/** Worker-to-host protocol envelope; every request is correlated and cancellable. */
export const PluginBrokerRequest = Schema.Union([
    Schema.Struct({
        protocolVersion: Schema.Literal(PLUGIN_CONTRACT_VERSION),
        operationId: PluginOperationId,
        kind: Schema.Literal('git.read'),
        repositoryId: Schema.String,
        operation: Schema.Literals(['repoState', 'status', 'branchList']),
    }),
    Schema.Struct({
        protocolVersion: Schema.Literal(PLUGIN_CONTRACT_VERSION),
        operationId: PluginOperationId,
        kind: Schema.Literal('automation.exec'),
        repositoryId: Schema.String,
        actionId: Schema.String,
    }),
    Schema.Struct({
        protocolVersion: Schema.Literal(PLUGIN_CONTRACT_VERSION),
        operationId: PluginOperationId,
        kind: Schema.Literal('cancel'),
        targetOperationId: PluginOperationId,
    }),
]);
export type PluginBrokerRequest = typeof PluginBrokerRequest.Type;

export const PluginBrokerResponse = Schema.Union([
    Schema.Struct({
        protocolVersion: Schema.Literal(PLUGIN_CONTRACT_VERSION),
        operationId: PluginOperationId,
        ok: Schema.Literal(true),
        result: Schema.Literals(['accepted', 'cancelled']),
    }),
    Schema.Struct({
        protocolVersion: Schema.Literal(PLUGIN_CONTRACT_VERSION),
        operationId: PluginOperationId,
        ok: Schema.Literal(false),
        code: Schema.String,
    }),
]);
export type PluginBrokerResponse = typeof PluginBrokerResponse.Type;
