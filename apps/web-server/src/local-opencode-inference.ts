// Constrained one-shot OpenCode adapter. It is deliberately host-only: the
// pure inference package receives only the normalized output runner, never a
// subprocess, temporary directory, environment, or provider credential.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
    type InferenceProfile,
    type InferenceSecretReference,
    type InferenceStructuredOutputRunner,
} from '@cbranch/inference';

import {
    constrainedLocalCliExecution,
    type ConstrainedLocalCliExecution,
    type ConstrainedLocalCliExecutionOptions,
} from './local-claude-code-inference';
import type { InferenceSecretResolver } from './openai-compatible-inference';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const CONFIG_FILENAME = 'opencode.json';
const AGENT_NAME = 'cbranch-inference';

const isOpenCodeExecutable = (executable: string): boolean =>
    /^opencode(?:\.exe)?$/i.test(basename(executable));

const requireOpenCodeProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'opencode')
        throw new Error('This runner only supports OpenCode profiles.');
    if (!profile.enabled) throw new Error('The inference profile is disabled.');
    if (!profile.capabilities.includes('generation'))
        throw new Error('The inference profile does not support generation.');
    if (
        profile.executable === undefined ||
        !isOpenCodeExecutable(profile.executable)
    )
        throw new Error(
            'An OpenCode profile requires an explicitly discovered OpenCode executable.',
        );
    if (profile.modelId === undefined)
        throw new Error('An OpenCode profile needs an explicit model ID.');
    if (profile.secretReference === undefined)
        throw new Error(
            'An OpenCode profile needs a named credential reference for constrained execution.',
        );
};

const requireSecret = (
    resolver: InferenceSecretResolver,
    reference: InferenceSecretReference,
): string => {
    const secret = resolver.resolve(reference);
    if (secret === undefined || secret === '')
        throw new Error('The named inference credential is unavailable.');
    return secret;
};

const environmentName = (
    reference: InferenceSecretReference,
): string | undefined =>
    reference.kind === 'environment' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.name)
        ? reference.name
        : undefined;

const prompt = (
    input: Parameters<InferenceStructuredOutputRunner['run']>[0],
): string =>
    [
        'Return one JSON object matching the Workspace Intelligence enrichment schema.',
        'Infer only architecture relationships supported by the selected evidence.',
        'Every inferred edge must cite one or more supplied evidence IDs.',
        'Do not use tools, browse, read files, make edits, or execute commands.',
        'Return JSON only, without Markdown or a code fence.',
        `Prompt schema: ${input.request.promptSchemaVersion}.`,
        'Required JSON shape:',
        JSON.stringify({
            schemaVersion: 1,
            inferredEdges: [
                {
                    from: 'stable-node-id',
                    to: 'stable-node-id',
                    kind: 'relationship-kind',
                    confidence: 0.5,
                    evidenceIds: ['selected-evidence-id'],
                    rationale: 'Evidence-backed explanation.',
                },
            ],
        }),
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

const openCodeConfiguration = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: { '*': 'deny' },
    agent: {
        [AGENT_NAME]: {
            description:
                'Return selected Workspace Intelligence evidence as JSON without using tools.',
            mode: 'primary',
            permission: { '*': 'deny' },
        },
    },
});

const parseResult = (text: string): unknown => {
    let value: unknown;
    try {
        value = JSON.parse(text.trim()) as unknown;
    } catch {
        throw new Error('OpenCode returned invalid structured output.');
    }
    if (value === null || typeof value !== 'object')
        throw new Error('OpenCode returned invalid structured output.');
    return value;
};

export type LocalOpenCodeExecutionOptions = ConstrainedLocalCliExecutionOptions;
export type LocalOpenCodeExecution = ConstrainedLocalCliExecution;

export const executeOpenCode = constrainedLocalCliExecution('OpenCode');

export interface LocalOpenCodeInferenceRunnerOptions {
    readonly profile: InferenceProfile;
    readonly secrets: InferenceSecretResolver;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /** Test seam; production uses a direct, constrained process spawn. */
    readonly execute?: LocalOpenCodeExecution;
}

/**
 * Builds a no-tool, one-shot OpenCode runner. The local configuration explicitly
 * denies every tool to both the selected agent and the global CLI. It runs in an
 * empty temporary directory, ignores external plugins, uses no repository cwd,
 * and erases the CLI's config, cache, and session data after the request.
 */
export const localOpenCodeInferenceRunner = ({
    profile,
    secrets,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    execute = executeOpenCode,
}: LocalOpenCodeInferenceRunnerOptions): InferenceStructuredOutputRunner => {
    requireOpenCodeProfile(profile);
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'OpenCode timeout must be an integer between 1 and 120000 ms.',
        );
    if (
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1 ||
        maxOutputBytes > 4_000_000
    )
        throw new Error(
            'OpenCode output limit must be an integer between 1 and 4000000 bytes.',
        );
    const credential = requireSecret(secrets, profile.secretReference!);
    const executable = profile.executable!;
    const model = profile.modelId!;
    const credentialEnvironmentName = environmentName(profile.secretReference!);
    return {
        run: async input => {
            if (signal?.aborted) throw new Error('OpenCode request cancelled.');
            const cwd = await mkdtemp(join(tmpdir(), 'cbranch-wi-opencode-'));
            try {
                await writeFile(
                    join(cwd, CONFIG_FILENAME),
                    openCodeConfiguration,
                );
                return parseResult(
                    await execute({
                        executable,
                        arguments: [
                            '--pure',
                            'run',
                            '--agent',
                            AGENT_NAME,
                            '--model',
                            model,
                            '--dir',
                            cwd,
                            prompt(input),
                        ],
                        cwd,
                        environment: {
                            PATH: process.env.PATH ?? '',
                            HOME: cwd,
                            XDG_CONFIG_HOME: cwd,
                            XDG_DATA_HOME: cwd,
                            XDG_CACHE_HOME: cwd,
                            TMPDIR: cwd,
                            LANG: process.env.LANG ?? 'C.UTF-8',
                            OPENCODE_API_KEY: credential,
                            ...(credentialEnvironmentName === undefined
                                ? {}
                                : {
                                      [credentialEnvironmentName]: credential,
                                  }),
                            NO_COLOR: '1',
                        },
                        signal,
                        timeoutMs,
                        maxOutputBytes,
                    }),
                );
            } finally {
                await rm(cwd, { recursive: true, force: true });
            }
        },
    };
};
