import { InferenceProfile } from '@cbranch/inference';
import { describe, expect, test } from 'vitest';

import { environmentInferenceSecretResolver } from './openai-compatible-inference';
import { discoverOpenAICompatibleModels } from './openai-compatible-model-discovery';

const profile = InferenceProfile.parse({
    id: 'hosted',
    label: 'Hosted model',
    provider: 'openai-compatible',
    enabled: false,
    capabilities: ['generation', 'embeddings'],
    endpoint: 'https://inference.example.test/v1',
    secretReference: { kind: 'environment', name: 'INFERENCE_TEST_KEY' },
});

describe('discoverOpenAICompatibleModels', () => {
    test('uses only the constrained models endpoint and normalizes IDs', async () => {
        const calls: Array<
            readonly [
                Parameters<typeof globalThis.fetch>[0],
                Parameters<typeof globalThis.fetch>[1],
            ]
        > = [];
        const fetch: typeof globalThis.fetch = async (input, init) => {
            calls.push([input, init]);
            return new Response(
                JSON.stringify({
                    data: [
                        { id: 'zeta' },
                        { id: 'alpha' },
                        { id: 'zeta' },
                        { id: 1 },
                    ],
                }),
            );
        };

        await expect(
            discoverOpenAICompatibleModels({
                profile,
                secrets: environmentInferenceSecretResolver({
                    INFERENCE_TEST_KEY: 'test-secret',
                }),
                fetch,
            }),
        ).resolves.toEqual({
            profileId: 'hosted',
            modelIds: ['alpha', 'zeta'],
        });
        expect(String(calls[0]?.[0])).toBe(
            'https://inference.example.test/v1/models',
        );
        expect(new Headers(calls[0]?.[1]?.headers).get('Authorization')).toBe(
            'Bearer test-secret',
        );
        expect(calls[0]?.[1]).toEqual(
            expect.objectContaining({ redirect: 'error' }),
        );
    });

    test('uses a disabled profile but rejects a local profile and raw error body', async () => {
        await expect(
            discoverOpenAICompatibleModels({
                profile: InferenceProfile.parse({
                    id: 'local',
                    label: 'Local',
                    provider: 'codex',
                    enabled: false,
                    capabilities: ['generation'],
                    executable: '/usr/bin/codex',
                }),
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).rejects.toThrow('only supports OpenAI-compatible');
        const fetch: typeof globalThis.fetch = async () =>
            new Response('provider-secret', { status: 401 });
        await expect(
            discoverOpenAICompatibleModels({
                profile,
                secrets: environmentInferenceSecretResolver({
                    INFERENCE_TEST_KEY: 'test-secret',
                }),
                fetch,
            }),
        ).rejects.toThrow('Model discovery request failed (HTTP 401).');
    });
});
