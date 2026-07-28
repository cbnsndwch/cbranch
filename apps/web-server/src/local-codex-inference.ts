// Constrained one-shot Codex adapter. It is deliberately host-only: the pure
// inference package receives only the normalized output runner, never a
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
    constrainedStructuredOutputSchema,
    type ConstrainedLocalCliExecution,
    type ConstrainedLocalCliExecutionOptions,
} from './local-claude-code-inference';
import type { InferenceSecretResolver } from './openai-compatible-inference';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_SCHEMA_FILENAME = 'cbranch-output-schema.json';

const isCodexExecutable = (executable: string): boolean =>
    /^codex(?:\.exe)?$/i.test(basename(executable));

const requireCodexProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'codex')
        throw new Error('This runner only supports Codex profiles.');
    if (!profile.enabled) throw new Error('The inference profile is disabled.');
    if (!profile.capabilities.includes('generation'))
        throw new Error('The inference profile does not support generation.');
    if (
        profile.executable === undefined ||
        !isCodexExecutable(profile.executable)
    )
        throw new Error(
            'A Codex profile requires an explicitly discovered Codex executable.',
        );
    if (profile.modelId === undefined)
        throw new Error('A Codex profile needs an explicit model ID.');
    if (profile.secretReference === undefined)
        throw new Error(
            'A Codex profile needs a named credential reference for constrained execution.',
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

const prompt = (
    input: Parameters<InferenceStructuredOutputRunner['run']>[0],
): string =>
    [
        'Return one JSON object matching the supplied JSON schema.',
        'Infer only architecture relationships supported by the selected evidence.',
        'Every inferred edge must cite one or more supplied evidence IDs.',
        'Do not use tools, browse, read files, make edits, or execute commands.',
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

const parseResult = (text: string): unknown => {
    let value: unknown;
    try {
        value = JSON.parse(text) as unknown;
    } catch {
        throw new Error('Codex returned invalid structured output.');
    }
    if (value === null || typeof value !== 'object')
        throw new Error('Codex returned invalid structured output.');
    return value;
};

export type LocalCodexExecutionOptions = ConstrainedLocalCliExecutionOptions;
export type LocalCodexExecution = ConstrainedLocalCliExecution;

export const executeCodex = constrainedLocalCliExecution('Codex');

export interface LocalCodexInferenceRunnerOptions {
    readonly profile: InferenceProfile;
    readonly secrets: InferenceSecretResolver;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /** Test seam; production uses a direct, constrained process spawn. */
    readonly execute?: LocalCodexExecution;
}

/**
 * Builds a no-tool, one-shot Codex runner. The CLI gets an empty host temporary
 * directory, no user/project config or rules, a read-only sandbox, never
 * approval, disabled web search, a reduced environment, and no persisted
 * session. The model can only receive the supplied selected evidence.
 */
export const localCodexInferenceRunner = ({
    profile,
    secrets,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    execute = executeCodex,
}: LocalCodexInferenceRunnerOptions): InferenceStructuredOutputRunner => {
    requireCodexProfile(profile);
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'Codex timeout must be an integer between 1 and 120000 ms.',
        );
    if (
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1 ||
        maxOutputBytes > 4_000_000
    )
        throw new Error(
            'Codex output limit must be an integer between 1 and 4000000 bytes.',
        );
    const credential = requireSecret(secrets, profile.secretReference!);
    const executable = profile.executable!;
    const model = profile.modelId!;
    return {
        run: async input => {
            if (signal?.aborted) throw new Error('Codex request cancelled.');
            const cwd = await mkdtemp(join(tmpdir(), 'cbranch-wi-codex-'));
            const outputSchemaPath = join(cwd, OUTPUT_SCHEMA_FILENAME);
            try {
                await writeFile(
                    outputSchemaPath,
                    constrainedStructuredOutputSchema,
                );
                const result = await execute({
                    executable,
                    arguments: [
                        '--ask-for-approval',
                        'never',
                        'exec',
                        '--sandbox',
                        'read-only',
                        '--ignore-user-config',
                        '--ignore-rules',
                        '--ephemeral',
                        '--strict-config',
                        '--config',
                        'web_search = "disabled"',
                        '--skip-git-repo-check',
                        '--model',
                        model,
                        '--output-schema',
                        outputSchemaPath,
                        prompt(input),
                    ],
                    cwd,
                    environment: {
                        PATH: process.env.PATH ?? '',
                        HOME: cwd,
                        CODEX_HOME: cwd,
                        TMPDIR: cwd,
                        LANG: process.env.LANG ?? 'C.UTF-8',
                        CODEX_API_KEY: credential,
                        NO_COLOR: '1',
                    },
                    signal,
                    timeoutMs,
                    maxOutputBytes,
                });
                return parseResult(result);
            } finally {
                await rm(cwd, { recursive: true, force: true });
            }
        },
    };
};
