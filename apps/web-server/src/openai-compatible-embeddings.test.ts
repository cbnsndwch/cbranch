import {
    InferenceEmbeddingRequest,
    InferenceProfile,
} from '@cbranch/inference';
import { describe, expect, test } from 'vitest';

import { environmentInferenceSecretResolver } from './openai-compatible-inference';
import { openAICompatibleEmbeddingRunner } from './openai-compatible-embeddings';

const profile = InferenceProfile.parse({
    id: 'embeddings',
    label: 'Hosted embeddings',
    provider: 'openai-compatible',
    enabled: true,
    capabilities: ['embeddings'],
    modelId: 'text-embedding-example',
    endpoint: 'https://inference.example.test/v1',
    secretReference: { kind: 'environment', name: 'INFERENCE_TEST_KEY' },
});
const request = InferenceEmbeddingRequest.parse({
    profileId: 'embeddings',
    model: 'text-embedding-example',
    inputs: ['Component api exposes a user route.', 'Contract users.'],
});

describe('openAICompatibleEmbeddingRunner', () => {
    test('uses the constrained endpoint and returns normalized vectors', async () => {
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
                        { index: 1, embedding: [0, 1] },
                        { index: 0, embedding: [1, 0] },
                    ],
                    usage: { prompt_tokens: 7 },
                }),
            );
        };
        const runner = openAICompatibleEmbeddingRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                INFERENCE_TEST_KEY: 'test-secret',
            }),
            fetch,
        });

        await expect(runner.embed(request)).resolves.toEqual({
            vectors: [
                [1, 0],
                [0, 1],
            ],
            usage: { inputTokens: 7 },
        });
        expect(String(calls[0]?.[0])).toBe(
            'https://inference.example.test/v1/embeddings',
        );
        expect(new Headers(calls[0]?.[1]?.headers).get('Authorization')).toBe(
            'Bearer test-secret',
        );
        expect(calls[0]?.[1]).toEqual(
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
                body: JSON.stringify({
                    model: 'text-embedding-example',
                    input: request.inputs,
                    encoding_format: 'float',
                }),
            }),
        );
    });

    test('rejects malformed or out-of-order provider output', async () => {
        const fetch: typeof globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [
                        { index: 0, embedding: [1, 0] },
                        { index: 2, embedding: [0, 1] },
                    ],
                }),
            );
        const runner = openAICompatibleEmbeddingRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                INFERENCE_TEST_KEY: 'test-secret',
            }),
            fetch,
        });

        await expect(runner.embed(request)).rejects.toThrow(
            'unexpected vector order',
        );
    });

    test('does not construct an embedding runner from a generation-only profile', () => {
        expect(() =>
            openAICompatibleEmbeddingRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    capabilities: ['generation'],
                }),
                secrets: environmentInferenceSecretResolver({
                    INFERENCE_TEST_KEY: 'test-secret',
                }),
            }),
        ).toThrow('does not support embeddings');
    });

    test('keeps failure text free of response content', async () => {
        const fetch: typeof globalThis.fetch = async () =>
            new Response('provider-secret', { status: 500 });
        const runner = openAICompatibleEmbeddingRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                INFERENCE_TEST_KEY: 'test-secret',
            }),
            fetch,
        });

        await expect(runner.embed(request)).rejects.toThrow(
            'Embedding provider request failed (HTTP 500).',
        );
    });
});
