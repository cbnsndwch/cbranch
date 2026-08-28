// The only provider execution currently admitted to Workspace Intelligence.
// It uses TanStack AI's non-agent, OpenAI-compatible structured-output path;
// no tools are configured and the request contains only cbranch-selected
// evidence. Local agent-harness CLIs are deliberately excluded by ADR 0003.

import { chat } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import {
    InferenceEnrichmentEnvelope,
    type InferenceProfile,
    type InferenceSecretReference,
    type InferenceStructuredOutputRunner,
} from '@cbranch/inference';

export interface InferenceSecretResolver {
    readonly resolve: (
        reference: InferenceSecretReference,
    ) => string | undefined;
}

const DEFAULT_INFERENCE_TIMEOUT_MS = 30_000;

/** Reads only a named environment variable; secret-store resolution is injected. */
export const environmentInferenceSecretResolver = (
    env: NodeJS.ProcessEnv = process.env,
): InferenceSecretResolver => ({
    resolve: reference =>
        reference.kind === 'environment' ? env[reference.name] : undefined,
});

export const endpointRestrictedFetch = (
    endpoint: string,
    delegate: typeof fetch = globalThis.fetch,
    timeoutMs = DEFAULT_INFERENCE_TIMEOUT_MS,
    externalSignal?: AbortSignal,
): typeof fetch => {
    const allowedEndpoint = new URL(endpoint);
    const allowedOrigin = allowedEndpoint.origin;
    const allowedPathPrefix = `${allowedEndpoint.pathname.replace(/\/$/, '')}/`;
    return async (input, init) => {
        const target =
            typeof input === 'string'
                ? new URL(input)
                : input instanceof URL
                  ? input
                  : new URL(input.url);
        if (
            target.origin !== allowedOrigin ||
            (target.pathname !== allowedEndpoint.pathname &&
                !target.pathname.startsWith(allowedPathPrefix))
        )
            throw new Error(
                'Inference provider attempted a request outside its configured endpoint.',
            );
        const controller = new AbortController();
        const callerSignal =
            init?.signal ??
            (input instanceof Request ? input.signal : undefined);
        const abortForCaller = () => controller.abort();
        const abortForExternal = () => controller.abort();
        if (callerSignal?.aborted) abortForCaller();
        else
            callerSignal?.addEventListener('abort', abortForCaller, {
                once: true,
            });
        if (externalSignal?.aborted) abortForExternal();
        else
            externalSignal?.addEventListener('abort', abortForExternal, {
                once: true,
            });
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await delegate(input, {
                ...init,
                redirect: 'error',
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
            callerSignal?.removeEventListener('abort', abortForCaller);
            externalSignal?.removeEventListener('abort', abortForExternal);
        }
    };
};

const requireRemoteGenerationProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'openai-compatible')
        throw new Error(
            'This runner only supports OpenAI-compatible profiles.',
        );
    if (!profile.enabled) throw new Error('The inference profile is disabled.');
    if (!profile.capabilities.includes('generation'))
        throw new Error('The inference profile does not support generation.');
    if (profile.endpoint === undefined || profile.modelId === undefined)
        throw new Error(
            'An OpenAI-compatible generation profile needs an endpoint and model ID.',
        );
    if (profile.secretReference === undefined)
        throw new Error(
            'An OpenAI-compatible generation profile needs a named credential reference.',
        );
};

const prompt = (input: Parameters<InferenceStructuredOutputRunner['run']>[0]) =>
    [
        'Infer only architecture relationships supported by the selected evidence.',
        'Do not use tools, browse, read files, or make requests other than this provider call.',
        'Every inferred edge must cite one or more supplied evidence IDs.',
        `Prompt schema: ${input.request.promptSchemaVersion}.`,
        'Selected evidence JSON:',
        JSON.stringify(input.request.evidence),
        ...(input.repair === undefined
            ? []
            : [
                  'The prior structured output was invalid. Return a complete repaired object only.',
                  `Validation diagnostics: ${JSON.stringify(input.repair.validationErrors)}`,
                  `Prior output: ${JSON.stringify(input.repair.invalidOutput)}`,
              ]),
    ].join('\n\n');

export interface OpenAICompatibleInferenceRunnerOptions {
    readonly profile: InferenceProfile;
    readonly secrets: InferenceSecretResolver;
    readonly fetch?: typeof globalThis.fetch;
    /** Per-provider request bound; never a token or aggregate-call budget. */
    readonly timeoutMs?: number;
    /** Host-controlled cancellation; it is never supplied by a provider. */
    readonly signal?: AbortSignal;
}

/**
 * Build a provider runner for the pure package's normalization/repair flow.
 * The caller decides when to invoke it; constructing a runner sends no request.
 */
export const openAICompatibleInferenceRunner = ({
    profile,
    secrets,
    fetch: fetchImplementation,
    timeoutMs = DEFAULT_INFERENCE_TIMEOUT_MS,
    signal,
}: OpenAICompatibleInferenceRunnerOptions): InferenceStructuredOutputRunner => {
    requireRemoteGenerationProfile(profile);
    const apiKey = secrets.resolve(profile.secretReference!);
    if (apiKey === undefined || apiKey === '')
        throw new Error('The named inference credential is unavailable.');
    const endpoint = profile.endpoint!;
    const model = profile.modelId!;
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'Inference timeout must be an integer between 1 and 120000 ms.',
        );

    return {
        run: input =>
            chat({
                adapter: openaiCompatibleText(model, {
                    name: profile.id,
                    baseURL: endpoint,
                    apiKey,
                    fetch: endpointRestrictedFetch(
                        endpoint,
                        fetchImplementation,
                        timeoutMs,
                        signal,
                    ),
                }),
                messages: [{ role: 'user', content: prompt(input) }],
                outputSchema: InferenceEnrichmentEnvelope,
            }),
    };
};
