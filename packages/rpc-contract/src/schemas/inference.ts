// Provider configuration schemas. These records intentionally carry only
// references to host-managed credentials, never credential values.

import { Schema } from 'effect';

import { EngagementId } from './engagements';

export const InferenceProviderKind = Schema.Literals([
    'claude-code',
    'codex',
    'opencode',
    'openai-compatible',
    'local-embeddings',
]);
export type InferenceProviderKind = typeof InferenceProviderKind.Type;

export const InferenceCapability = Schema.Literals([
    'generation',
    'embeddings',
]);
export type InferenceCapability = typeof InferenceCapability.Type;

export const InferenceSecretReference = Schema.Union([
    Schema.Struct({ kind: Schema.Literal('environment'), name: Schema.String }),
    Schema.Struct({
        kind: Schema.Literal('secret-store'),
        name: Schema.String,
    }),
]);
export type InferenceSecretReference = typeof InferenceSecretReference.Type;

export class InferenceProfile extends Schema.Class<InferenceProfile>(
    'InferenceProfile',
)({
    id: Schema.String,
    label: Schema.String,
    provider: InferenceProviderKind,
    enabled: Schema.Boolean,
    capabilities: Schema.Array(InferenceCapability),
    modelId: Schema.optional(Schema.String),
    endpoint: Schema.optional(Schema.String),
    executable: Schema.optional(Schema.String),
    secretReference: Schema.optional(InferenceSecretReference),
}) {}

/** A host-local executable discovered without invoking an inference request. */
export class InferenceProfileDiscovery extends Schema.Class<InferenceProfileDiscovery>(
    'InferenceProfileDiscovery',
)({
    provider: InferenceProviderKind,
    executable: Schema.String,
    version: Schema.String,
}) {}

/** A bounded endpoint-provided model list; credential and endpoint stay host-side. */
export class InferenceModelDiscovery extends Schema.Class<InferenceModelDiscovery>(
    'InferenceModelDiscovery',
)({
    profileId: Schema.String,
    modelIds: Schema.Array(Schema.String),
}) {}

export class WorkspaceInferenceDefaults extends Schema.Class<WorkspaceInferenceDefaults>(
    'WorkspaceInferenceDefaults',
)({
    generationProfileId: Schema.optional(Schema.String),
    embeddingProfileId: Schema.optional(Schema.String),
}) {}

export class InferenceProfilesSetInput extends Schema.Class<InferenceProfilesSetInput>(
    'InferenceProfilesSetInput',
)({
    profiles: Schema.Array(InferenceProfile),
}) {}

export class InferenceModelsDiscoverInput extends Schema.Class<InferenceModelsDiscoverInput>(
    'InferenceModelsDiscoverInput',
)({
    profileId: Schema.String,
}) {}

export class WorkspaceInferenceDefaultsInput extends Schema.Class<WorkspaceInferenceDefaultsInput>(
    'WorkspaceInferenceDefaultsInput',
)({
    engagementId: EngagementId,
}) {}

export class WorkspaceInferenceDefaultsSetInput extends Schema.Class<WorkspaceInferenceDefaultsSetInput>(
    'WorkspaceInferenceDefaultsSetInput',
)({
    engagementId: EngagementId,
    defaults: WorkspaceInferenceDefaults,
}) {}
