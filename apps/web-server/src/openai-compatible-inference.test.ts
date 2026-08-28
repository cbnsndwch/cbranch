import { chat } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import {
    InferenceEnrichmentRequest,
    InferenceProfile,
} from '@cbranch/inference';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
    endpointRestrictedFetch,
    environmentInferenceSecretResolver,
    openAICompatibleInferenceRunner,
} from './openai-compatible-inference';

vi.mock('@tanstack/ai', () => ({ chat: vi.fn() }));
vi.mock('@tanstack/ai-openai/compatible', () => ({
    openaiCompatibleText: vi.fn(() => ({ kind: 'text' })),
}));

const profile = InferenceProfile.parse({
    id: 'hosted',
    label: 'Hosted model',
    provider: 'openai-compatible',
    enabled: true,
    capabilities: ['generation'],
    modelId: 'example-model',
    endpoint: 'https://inference.example.test/v1',
    secretReference: { kind: 'environment', name: 'INFERENCE_TEST_KEY' },
});
const request = InferenceEnrichmentRequest.parse({
    profileId: 'hosted',
    model: 'example-model',
    evidence: [{ id: 'evidence-1', content: 'The handler registers /users.' }],
    promptSchemaVersion: 'workspace-intelligence.enrichment@1',
});
const response = {
    schemaVersion: 1,
    inferredEdges: [
        {
            from: 'component:api',
            to: 'contract:users',
            kind: 'exposes',
            confidence: 0.8,
            evidenceIds: ['evidence-1'],
            rationale: 'The selected handler registers the route.',
        },
    ],
};

beforeEach(() => vi.clearAllMocks());

describe('openAICompatibleInferenceRunner', () => {
    test('uses the structured-output path with selected evidence and no tools', async () => {
        vi.mocked(chat).mockResolvedValue(response);
        const runner = openAICompatibleInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                INFERENCE_TEST_KEY: 'test-secret',
            }),
        });

        await expect(runner.run({ request })).resolves.toEqual(response);
        expect(openaiCompatibleText).toHaveBeenCalledWith(
            'example-model',
            expect.objectContaining({
                name: 'hosted',
                baseURL: 'https://inference.example.test/v1',
                apiKey: 'test-secret',
            }),
        );
        expect(chat).toHaveBeenCalledWith(
            expect.objectContaining({
                outputSchema: expect.anything(),
                messages: [
                    expect.objectContaining({
                        content: expect.stringContaining('evidence-1'),
                    }),
                ],
            }),
        );
        expect(
            (chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
        ).not.toHaveProperty('tools');
    });

    test('passes a fetch boundary that rejects a different endpoint origin', async () => {
        vi.mocked(chat).mockResolvedValue(response);
        const runner = openAICompatibleInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                INFERENCE_TEST_KEY: 'test-secret',
            }),
        });
        await runner.run({ request });
        const config = (openaiCompatibleText as ReturnType<typeof vi.fn>).mock
            .calls[0]?.[1] as { fetch: typeof fetch };

        await expect(
            config.fetch('https://unapproved.example.test/v1/chat/completions'),
        ).rejects.toThrow('outside its configured endpoint');
        await expect(
            config.fetch('https://inference.example.test/other-service'),
        ).rejects.toThrow('outside its configured endpoint');
    });

    test('forces same-origin requests to fail closed on redirects', async () => {
        const delegate = vi.fn(async () => new Response('{}'));
        const fetch = endpointRestrictedFetch(
            'https://inference.example.test/v1',
            delegate,
        );

        await fetch('https://inference.example.test/v1/chat/completions');

        expect(delegate).toHaveBeenCalledWith(
            'https://inference.example.test/v1/chat/completions',
            expect.objectContaining({
                redirect: 'error',
                signal: expect.anything(),
            }),
        );
    });

    test('propagates a host cancellation signal to the restricted provider fetch', async () => {
        const controller = new AbortController();
        const delegate: typeof fetch = async (_input, init) =>
            new Promise((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => reject(new Error('request aborted')),
                    { once: true },
                );
            });
        const fetch = endpointRestrictedFetch(
            'https://inference.example.test/v1',
            delegate,
            30_000,
            controller.signal,
        );

        const pending = fetch(
            'https://inference.example.test/v1/chat/completions',
        );
        controller.abort();

        await expect(pending).rejects.toThrow('request aborted');
    });

    test('fails before a request when no named credential can be resolved', () => {
        expect(() =>
            openAICompatibleInferenceRunner({
                profile,
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('credential is unavailable');
        expect(chat).not.toHaveBeenCalled();
    });

    test('requires a bounded per-provider timeout', () => {
        expect(() =>
            openAICompatibleInferenceRunner({
                profile,
                secrets: environmentInferenceSecretResolver({
                    INFERENCE_TEST_KEY: 'test-secret',
                }),
                timeoutMs: 0,
            }),
        ).toThrow('Inference timeout');
    });

    test('refuses a local agent profile at the remote adapter boundary', () => {
        expect(() =>
            openAICompatibleInferenceRunner({
                profile: InferenceProfile.parse({
                    id: 'local',
                    label: 'Local Codex',
                    provider: 'codex',
                    enabled: true,
                    capabilities: ['generation'],
                    executable: '/usr/local/bin/codex',
                    modelId: 'gpt-5.6-codex',
                    secretReference: {
                        kind: 'environment',
                        name: 'CODEX_API_KEY',
                    },
                }),
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('only supports OpenAI-compatible');
    });
});
