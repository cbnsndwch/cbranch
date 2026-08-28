// Narrow local embedding adapter for Ollama's loopback API. This is not an
// agent harness or a shell invocation: it has a fixed loopback endpoint and
// can receive only host-selected text batches.

import {
    InferenceEmbeddingRequest,
    normalizeEmbeddingResult,
    type InferenceEmbeddingRunner,
    type InferenceProfile,
} from '@cbranch/inference';

import { endpointRestrictedFetch } from './openai-compatible-inference';

const OLLAMA_API_ENDPOINT = 'http://127.0.0.1:11434/api';
const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;

const isOllamaExecutable = (executable: string): boolean =>
    /(^|[\\/])ollama(?:\.exe)?$/i.test(executable);

const requireLocalEmbeddingProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'local-embeddings')
        throw new Error('This runner only supports local embedding profiles.');
    if (!profile.enabled) throw new Error('The inference profile is disabled.');
    if (!profile.capabilities.includes('embeddings'))
        throw new Error('The inference profile does not support embeddings.');
    if (profile.executable === undefined)
        throw new Error(
            'A local embedding profile needs an explicitly discovered executable.',
        );
    if (!isOllamaExecutable(profile.executable))
        throw new Error(
            'This local embedding runner only supports an Ollama executable.',
        );
    if (profile.modelId === undefined)
        throw new Error('A local embedding profile needs a model ID.');
};

interface OllamaEmbedResponse {
    readonly embeddings?: unknown;
    readonly prompt_eval_count?: unknown;
}

export interface LocalOllamaEmbeddingRunnerOptions {
    readonly profile: InferenceProfile;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}

/**
 * Calls only Ollama's fixed loopback `/api/embed` endpoint. The declared
 * executable is configuration/provenance evidence and is never spawned here.
 */
export const localOllamaEmbeddingRunner = ({
    profile,
    fetch: fetchImplementation,
    timeoutMs = DEFAULT_OLLAMA_TIMEOUT_MS,
}: LocalOllamaEmbeddingRunnerOptions): InferenceEmbeddingRunner => {
    requireLocalEmbeddingProfile(profile);
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'Local embedding timeout must be an integer between 1 and 120000 ms.',
        );
    const fetch = endpointRestrictedFetch(
        OLLAMA_API_ENDPOINT,
        fetchImplementation,
        timeoutMs,
    );
    return {
        embed: async request => {
            const parsedRequest = InferenceEmbeddingRequest.parse(request);
            const response = await fetch(`${OLLAMA_API_ENDPOINT}/embed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: profile.modelId,
                    input: parsedRequest.inputs,
                    truncate: true,
                }),
            });
            if (!response.ok)
                throw new Error(
                    `Local embedding request failed (HTTP ${response.status}).`,
                );
            let body: unknown;
            try {
                body = await response.json();
            } catch {
                throw new Error(
                    'The local embedding service returned invalid vectors.',
                );
            }
            if (body === null || typeof body !== 'object')
                throw new Error(
                    'The local embedding service returned invalid vectors.',
                );
            const result = body as OllamaEmbedResponse;
            return normalizeEmbeddingResult(
                {
                    vectors: result.embeddings,
                    ...(typeof result.prompt_eval_count === 'number'
                        ? { usage: { inputTokens: result.prompt_eval_count } }
                        : {}),
                },
                parsedRequest.inputs.length,
            );
        },
    };
};
