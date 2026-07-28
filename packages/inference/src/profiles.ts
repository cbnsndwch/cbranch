import { z } from 'zod';

const profileId = z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const referenceName = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_./-]*$/);

export const InferenceProviderKind = z.enum([
    'claude-code',
    'codex',
    'opencode',
    'openai-compatible',
    'local-embeddings',
]);
export type InferenceProviderKind = z.infer<typeof InferenceProviderKind>;

export const InferenceCapability = z.enum(['generation', 'embeddings']);
export type InferenceCapability = z.infer<typeof InferenceCapability>;

/**
 * A durable pointer to host-managed credentials. It deliberately has no field
 * that can carry a credential value; profile persistence may retain this
 * reference but never an API key, token, or password.
 */
export const InferenceSecretReference = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('environment'),
        name: referenceName,
    }),
    z.object({
        kind: z.literal('secret-store'),
        name: referenceName,
    }),
]);
export type InferenceSecretReference = z.infer<typeof InferenceSecretReference>;

const endpoint = z
    .string()
    .url()
    .superRefine((value, context) => {
        if (!/^https?:\/\/[^/?#@]+(?:\/[^?#]*)?$/i.test(value))
            context.addIssue({
                code: 'custom',
                message:
                    'An endpoint must use http(s) without embedded credentials, query, or fragment data.',
            });
    });

const uniqueCapabilities = (capabilities: ReadonlyArray<string>): boolean =>
    new Set(capabilities).size === capabilities.length;

/**
 * Non-secret, host-level provider profile configuration. Provider execution is
 * intentionally outside this package and receives only this normalized shape.
 */
export const InferenceProfile = z
    .object({
        id: profileId,
        label: z.string().min(1).max(160),
        provider: InferenceProviderKind,
        enabled: z.boolean(),
        capabilities: z
            .array(InferenceCapability)
            .min(1)
            .max(2)
            .refine(uniqueCapabilities, 'Capabilities must be unique.'),
        modelId: z.string().min(1).max(200).optional(),
        endpoint: endpoint.optional(),
        executable: z.string().min(1).max(1_024).optional(),
        secretReference: InferenceSecretReference.optional(),
    })
    .superRefine((profile, context) => {
        const isRemote = profile.provider === 'openai-compatible';
        if (isRemote && profile.endpoint === undefined)
            context.addIssue({
                code: 'custom',
                path: ['endpoint'],
                message: 'An OpenAI-compatible profile requires an endpoint.',
            });
        if (isRemote && profile.executable !== undefined)
            context.addIssue({
                code: 'custom',
                path: ['executable'],
                message:
                    'An OpenAI-compatible profile cannot declare a local executable.',
            });
        if (!isRemote && profile.endpoint !== undefined)
            context.addIssue({
                code: 'custom',
                path: ['endpoint'],
                message: 'A local profile cannot declare a remote endpoint.',
            });
        if (!isRemote && profile.executable === undefined)
            context.addIssue({
                code: 'custom',
                path: ['executable'],
                message:
                    'A local profile requires an explicitly discovered executable.',
            });
        if (
            profile.provider === 'local-embeddings' &&
            profile.capabilities.includes('generation')
        )
            context.addIssue({
                code: 'custom',
                path: ['capabilities'],
                message: 'A local embedding profile cannot declare generation.',
            });
        if (
            profile.provider !== 'openai-compatible' &&
            profile.provider !== 'local-embeddings' &&
            profile.capabilities.includes('embeddings')
        )
            context.addIssue({
                code: 'custom',
                path: ['capabilities'],
                message:
                    'A constrained local generation profile cannot declare embeddings.',
            });
        if (profile.enabled && profile.modelId === undefined)
            context.addIssue({
                code: 'custom',
                path: ['modelId'],
                message:
                    'An enabled inference profile requires an explicit model ID.',
            });
        if (
            profile.enabled &&
            profile.provider !== 'local-embeddings' &&
            profile.secretReference === undefined
        )
            context.addIssue({
                code: 'custom',
                path: ['secretReference'],
                message:
                    'An enabled generation profile requires a named credential reference.',
            });
    });
export type InferenceProfile = z.infer<typeof InferenceProfile>;

/** A bounded host configuration projection with unique stable profile IDs. */
export const InferenceProfiles = z
    .array(InferenceProfile)
    .max(32)
    .superRefine((profiles, context) => {
        const seen = new Set<string>();
        for (const [index, profile] of profiles.entries()) {
            if (!seen.has(profile.id)) {
                seen.add(profile.id);
                continue;
            }
            context.addIssue({
                code: 'custom',
                path: [index, 'id'],
                message: 'Profile IDs must be unique.',
            });
        }
    });
export type InferenceProfiles = z.infer<typeof InferenceProfiles>;

/** Workspace presentation defaults refer to host profiles by stable ID only. */
export const InferenceWorkspaceDefaults = z.object({
    generationProfileId: profileId.optional(),
    embeddingProfileId: profileId.optional(),
});
export type InferenceWorkspaceDefaults = z.infer<
    typeof InferenceWorkspaceDefaults
>;
