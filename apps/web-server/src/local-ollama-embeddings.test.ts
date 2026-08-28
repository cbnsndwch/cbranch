import {
    InferenceEmbeddingRequest,
    InferenceProfile,
} from '@cbranch/inference';
import { describe, expect, test } from 'vitest';

import { localOllamaEmbeddingRunner } from './local-ollama-embeddings';

const profile = InferenceProfile.parse({
    id: 'ollama-local',
    label: 'Ollama local embeddings',
    provider: 'local-embeddings',
    enabled: true,
    capabilities: ['embeddings'],
    executable: '/usr/bin/ollama',
    modelId: 'mxbai-embed-large:latest',
});
const request = InferenceEmbeddingRequest.parse({
    profileId: 'ollama-local',
    model: 'mxbai-embed-large:latest',
    inputs: ['Component API.', 'Contract users.'],
});

describe('localOllamaEmbeddingRunner', () => {
    test('uses only the fixed loopback embed endpoint and normalizes vectors', async () => {
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
                    embeddings: [
                        [1, 0],
                        [0, 1],
                    ],
                    prompt_eval_count: 4,
                }),
            );
        };
        const runner = localOllamaEmbeddingRunner({ profile, fetch });

        await expect(runner.embed(request)).resolves.toEqual({
            vectors: [
                [1, 0],
                [0, 1],
            ],
            usage: { inputTokens: 4 },
        });
        expect(String(calls[0]?.[0])).toBe('http://127.0.0.1:11434/api/embed');
        expect(calls[0]?.[1]).toEqual(
            expect.objectContaining({
                method: 'POST',
                redirect: 'error',
                body: JSON.stringify({
                    model: 'mxbai-embed-large:latest',
                    input: request.inputs,
                    truncate: true,
                }),
            }),
        );
    });

    test('rejects an incompatible provider and does not include response text in failures', async () => {
        expect(() =>
            localOllamaEmbeddingRunner({
                profile: InferenceProfile.parse({
                    id: 'remote',
                    label: 'Remote',
                    provider: 'openai-compatible',
                    enabled: true,
                    capabilities: ['generation'],
                    modelId: 'remote-model',
                    endpoint: 'https://provider.example/v1',
                    secretReference: {
                        kind: 'environment',
                        name: 'REMOTE_API_KEY',
                    },
                }),
            }),
        ).toThrow('only supports local embedding profiles');
        const fetch: typeof globalThis.fetch = async () =>
            new Response('provider-secret', { status: 503 });
        await expect(
            localOllamaEmbeddingRunner({ profile, fetch }).embed(request),
        ).rejects.toThrow('Local embedding request failed (HTTP 503).');
    });

    test('rejects a manually configured non-Ollama executable', () => {
        expect(() =>
            localOllamaEmbeddingRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    executable: '/usr/bin/unrelated-local-tool',
                }),
            }),
        ).toThrow('only supports an Ollama executable');
    });

    test.skipIf(process.env.CBRANCH_OLLAMA_EMBEDDINGS_MODEL === undefined)(
        'embeds generic text through an explicitly available local Ollama model',
        async () => {
            const modelId = process.env.CBRANCH_OLLAMA_EMBEDDINGS_MODEL;
            if (modelId === undefined)
                throw new Error('A model ID is required.');
            const runner = localOllamaEmbeddingRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    modelId,
                }),
                timeoutMs: 120_000,
            });

            const result = await runner.embed(
                InferenceEmbeddingRequest.parse({
                    profileId: 'ollama-local',
                    model: modelId,
                    inputs: ['Component API.', 'Contract users.'],
                }),
            );

            expect(result.vectors).toHaveLength(2);
            expect(result.vectors[0]?.length).toBeGreaterThan(0);
            expect(result.vectors[0]?.every(Number.isFinite)).toBe(true);
        },
        120_000,
    );
});
