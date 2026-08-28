import { describe, expect, test } from 'vitest';

import {
    InferenceProfile,
    InferenceProfiles,
    InferenceWorkspaceDefaults,
} from './profiles';

describe('InferenceProfile', () => {
    test('accepts a non-secret OpenAI-compatible generation profile', () => {
        expect(
            InferenceProfile.parse({
                id: 'host-openai',
                label: 'Hosted compatibility endpoint',
                provider: 'openai-compatible',
                enabled: true,
                capabilities: ['generation'],
                modelId: 'configured-model',
                endpoint: 'https://inference.example.test/v1',
                secretReference: {
                    kind: 'environment',
                    name: 'CBRANCH_INFERENCE_TOKEN',
                },
            }),
        ).toMatchObject({
            id: 'host-openai',
            secretReference: {
                kind: 'environment',
                name: 'CBRANCH_INFERENCE_TOKEN',
            },
        });
    });

    test('rejects raw or credential-bearing remote configuration', () => {
        const rawSecret = InferenceProfile.safeParse({
            id: 'unsafe',
            label: 'Unsafe',
            provider: 'openai-compatible',
            enabled: true,
            capabilities: ['generation'],
            endpoint: 'https://inference.example.test/v1',
            secretReference: 'sk-not-a-reference',
        });
        const credentialInUrl = InferenceProfile.safeParse({
            id: 'unsafe-url',
            label: 'Unsafe URL',
            provider: 'openai-compatible',
            enabled: true,
            capabilities: ['generation'],
            endpoint: 'https://token@inference.example.test/v1?api_key=value',
        });

        expect(rawSecret.success).toBe(false);
        expect(credentialInUrl.success).toBe(false);
    });

    test('requires the correct host execution shape for local and remote providers', () => {
        const missingLocalExecutable = InferenceProfile.safeParse({
            id: 'codex',
            label: 'Codex',
            provider: 'codex',
            enabled: true,
            capabilities: ['generation'],
        });
        const missingRemoteEndpoint = InferenceProfile.safeParse({
            id: 'remote',
            label: 'Remote',
            provider: 'openai-compatible',
            enabled: true,
            capabilities: ['generation'],
        });

        expect(missingLocalExecutable.success).toBe(false);
        expect(missingRemoteEndpoint.success).toBe(false);
        expect(
            InferenceProfile.safeParse({
                id: 'missing-model',
                label: 'Missing model',
                provider: 'openai-compatible',
                enabled: true,
                capabilities: ['generation'],
                endpoint: 'https://inference.example.test/v1',
                secretReference: {
                    kind: 'environment',
                    name: 'CBRANCH_INFERENCE_TOKEN',
                },
            }).success,
        ).toBe(false);
        expect(
            InferenceProfile.safeParse({
                id: 'missing-credential',
                label: 'Missing credential',
                provider: 'codex',
                enabled: true,
                capabilities: ['generation'],
                executable: 'codex',
                modelId: 'configured-model',
            }).success,
        ).toBe(false);
        expect(
            InferenceProfile.safeParse({
                id: 'invalid-local-embedding',
                label: 'Invalid local embedding',
                provider: 'local-embeddings',
                enabled: true,
                capabilities: ['generation', 'embeddings'],
                executable: 'ollama',
            }).success,
        ).toBe(false);
        expect(
            InferenceProfile.safeParse({
                id: 'invalid-local-generation',
                label: 'Invalid local generation',
                provider: 'codex',
                enabled: true,
                capabilities: ['generation', 'embeddings'],
                executable: 'codex',
            }).success,
        ).toBe(false);
    });

    test('enforces unique profiles and permits independent workspace defaults', () => {
        expect(
            InferenceProfiles.safeParse([
                {
                    id: 'embedding',
                    label: 'Embedding',
                    provider: 'local-embeddings',
                    enabled: true,
                    capabilities: ['embeddings'],
                    executable: 'local-embed',
                },
                {
                    id: 'embedding',
                    label: 'Duplicate',
                    provider: 'local-embeddings',
                    enabled: false,
                    capabilities: ['embeddings'],
                    executable: 'local-embed',
                },
            ]).success,
        ).toBe(false);
        expect(
            InferenceWorkspaceDefaults.parse({
                generationProfileId: 'generation',
                embeddingProfileId: 'embedding',
            }),
        ).toEqual({
            generationProfileId: 'generation',
            embeddingProfileId: 'embedding',
        });
    });
});
