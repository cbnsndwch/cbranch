// The embedding transport is host-only for the same reason as generation:
// inference contracts remain pure and never acquire filesystem or network access.

import {
    InferenceEmbeddingRequest,
    normalizeEmbeddingResult,
    type InferenceEmbeddingRunner,
    type InferenceProfile,
} from '@cbranch/inference';

import {
    endpointRestrictedFetch,
    type InferenceSecretResolver,
} from './openai-compatible-inference';

const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;

const requireRemoteEmbeddingProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'openai-compatible')
        throw new Error(
            'This runner only supports OpenAI-compatible profiles.',
        );
    if (!profile.enabled) throw new Error('The inference profile is disabled.');
    if (!profile.capabilities.includes('embeddings'))
        throw new Error('The inference profile does not support embeddings.');
    if (profile.endpoint === undefined || profile.modelId === undefined)
        throw new Error(
            'An OpenAI-compatible embedding profile needs an endpoint and model ID.',
        );
    if (profile.secretReference === undefined)
        throw new Error(
            'An OpenAI-compatible embedding profile needs a named credential reference.',
        );
};

const embeddingUrl = (endpoint: string): URL => {
    const url = new URL(endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/embeddings`;
    return url;
};

interface EmbeddingProviderResponse {
    readonly data?: ReadonlyArray<{
        readonly index?: unknown;
        readonly embedding?: unknown;
    }>;
    readonly usage?: {
        readonly prompt_tokens?: unknown;
    };
}

const toNormalizedProviderResult = (value: unknown, expectedCount: number) => {
    if (value === null || typeof value !== 'object')
        throw new Error('The embedding provider returned invalid vectors.');
    const response = value as EmbeddingProviderResponse;
    if (!Array.isArray(response.data))
        throw new Error('The embedding provider returned invalid vectors.');
    const data = response.data.toSorted(
        (left, right) => Number(left.index) - Number(right.index),
    );
    if (data.some((item, index) => item.index !== index))
        throw new Error(
            'The embedding provider returned an unexpected vector order.',
        );
    return normalizeEmbeddingResult(
        {
            vectors: data.map(item => item.embedding),
            ...(typeof response.usage?.prompt_tokens === 'number'
                ? { usage: { inputTokens: response.usage.prompt_tokens } }
                : {}),
        },
        expectedCount,
    );
};

export interface OpenAICompatibleEmbeddingRunnerOptions {
    readonly profile: InferenceProfile;
    readonly secrets: InferenceSecretResolver;
    readonly fetch?: typeof globalThis.fetch;
    /** Per-provider request bound; never a token or aggregate-call budget. */
    readonly timeoutMs?: number;
}

/**
 * OpenAI-compatible `POST /embeddings` runner. It sends only host-selected
 * graph chunks, never an agent prompt, tool declaration, workspace path, or
 * repository contents outside those chunks.
 */
export const openAICompatibleEmbeddingRunner = ({
    profile,
    secrets,
    fetch: fetchImplementation,
    timeoutMs = DEFAULT_EMBEDDING_TIMEOUT_MS,
}: OpenAICompatibleEmbeddingRunnerOptions): InferenceEmbeddingRunner => {
    requireRemoteEmbeddingProfile(profile);
    const apiKey = secrets.resolve(profile.secretReference!);
    if (apiKey === undefined || apiKey === '')
        throw new Error('The named inference credential is unavailable.');
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'Inference timeout must be an integer between 1 and 120000 ms.',
        );
    const endpoint = profile.endpoint!;
    const requestUrl = embeddingUrl(endpoint);
    const restrictedFetch = endpointRestrictedFetch(
        endpoint,
        fetchImplementation,
        timeoutMs,
    );

    return {
        embed: async request => {
            const parsedRequest = InferenceEmbeddingRequest.parse(request);
            const response = await restrictedFetch(requestUrl, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: parsedRequest.model,
                    input: parsedRequest.inputs,
                    encoding_format: 'float',
                }),
            });
            if (!response.ok)
                throw new Error(
                    `Embedding provider request failed (HTTP ${response.status}).`,
                );
            let body: unknown;
            try {
                body = await response.json();
            } catch {
                throw new Error(
                    'The embedding provider returned invalid vectors.',
                );
            }
            return toNormalizedProviderResult(
                body,
                parsedRequest.inputs.length,
            );
        },
    };
};
