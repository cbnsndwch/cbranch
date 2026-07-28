// Host-only OpenAI-compatible model discovery. It intentionally receives no
// workspace/evidence values, so Settings can validate a remote profile safely.

import type { InferenceProfile } from '@cbranch/inference';
import type { InferenceModelDiscovery } from '@cbranch/rpc-contract';

import {
    endpointRestrictedFetch,
    type InferenceSecretResolver,
} from './openai-compatible-inference';

const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERED_MODELS = 500;

const requireRemoteProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'openai-compatible')
        throw new Error(
            'Model discovery only supports OpenAI-compatible profiles.',
        );
    if (profile.endpoint === undefined)
        throw new Error(
            'An OpenAI-compatible profile needs an endpoint for model discovery.',
        );
    if (profile.secretReference === undefined)
        throw new Error(
            'An OpenAI-compatible profile needs a named credential reference for model discovery.',
        );
};

const modelsUrl = (endpoint: string): URL => {
    const url = new URL(endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
    return url;
};

interface ModelsResponse {
    readonly data?: ReadonlyArray<{ readonly id?: unknown }>;
}

export interface OpenAICompatibleModelDiscoveryOptions {
    readonly profile: InferenceProfile;
    readonly secrets: InferenceSecretResolver;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
}

/**
 * Reads a bounded normalized model list from the configured endpoint. Profile
 * enablement is intentionally not required: this is the Settings test before
 * a user explicitly enables a profile for workspace use.
 */
export const discoverOpenAICompatibleModels = async ({
    profile,
    secrets,
    fetch: fetchImplementation,
    timeoutMs = DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
}: OpenAICompatibleModelDiscoveryOptions): Promise<InferenceModelDiscovery> => {
    requireRemoteProfile(profile);
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'Model discovery timeout must be an integer between 1 and 120000 ms.',
        );
    const apiKey = secrets.resolve(profile.secretReference!);
    if (apiKey === undefined || apiKey === '')
        throw new Error('The named inference credential is unavailable.');
    const response = await endpointRestrictedFetch(
        profile.endpoint!,
        fetchImplementation,
        timeoutMs,
    )(modelsUrl(profile.endpoint!), {
        headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok)
        throw new Error(
            `Model discovery request failed (HTTP ${response.status}).`,
        );
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new Error('Model discovery returned an invalid response.');
    }
    if (body === null || typeof body !== 'object')
        throw new Error('Model discovery returned an invalid response.');
    const data = (body as ModelsResponse).data;
    if (!Array.isArray(data))
        throw new Error('Model discovery returned an invalid response.');
    const modelIds = [
        ...new Set(
            data.flatMap(item =>
                typeof item.id === 'string' &&
                item.id.length > 0 &&
                item.id.length <= 200
                    ? [item.id]
                    : [],
            ),
        ),
    ]
        .toSorted((left, right) => left.localeCompare(right))
        .slice(0, MAX_DISCOVERED_MODELS);
    return { profileId: profile.id, modelIds };
};
