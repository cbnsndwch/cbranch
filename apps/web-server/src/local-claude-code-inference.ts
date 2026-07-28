// Constrained one-shot Claude Code adapter. It is deliberately host-only: the
// pure inference package receives only the normalized output runner, never a
// subprocess, temp directory, environment, or provider credential.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
    type InferenceProfile,
    type InferenceSecretReference,
    type InferenceStructuredOutputRunner,
} from '@cbranch/inference';

import type { InferenceSecretResolver } from './openai-compatible-inference';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const EMPTY_MCP_CONFIGURATION = '{"mcpServers":{}}';

export const constrainedStructuredOutputSchema = JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'inferredEdges'],
    properties: {
        schemaVersion: { const: 1 },
        inferredEdges: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'from',
                    'to',
                    'kind',
                    'confidence',
                    'evidenceIds',
                    'rationale',
                ],
                properties: {
                    from: { type: 'string', minLength: 1 },
                    to: { type: 'string', minLength: 1 },
                    kind: { type: 'string', minLength: 1 },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                    evidenceIds: {
                        type: 'array',
                        minItems: 1,
                        items: { type: 'string', minLength: 1 },
                    },
                    rationale: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 4_000,
                    },
                },
            },
        },
        summary: { type: 'string', minLength: 1, maxLength: 12_000 },
        usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
                inputTokens: { type: 'integer', minimum: 0 },
                outputTokens: { type: 'integer', minimum: 0 },
            },
        },
        timing: {
            type: 'object',
            additionalProperties: false,
            required: ['durationMs'],
            properties: {
                durationMs: { type: 'number', minimum: 0 },
            },
        },
    },
});

const isClaudeExecutable = (executable: string): boolean =>
    /^claude(?:\.exe)?$/i.test(basename(executable));

const requireClaudeProfile = (profile: InferenceProfile): void => {
    if (profile.provider !== 'claude-code')
        throw new Error('This runner only supports Claude Code profiles.');
    if (!profile.enabled) throw new Error('The inference profile is disabled.');
    if (!profile.capabilities.includes('generation'))
        throw new Error('The inference profile does not support generation.');
    if (
        profile.executable === undefined ||
        !isClaudeExecutable(profile.executable)
    )
        throw new Error(
            'A Claude Code profile requires an explicitly discovered Claude executable.',
        );
    if (profile.modelId === undefined)
        throw new Error('A Claude Code profile needs an explicit model ID.');
    if (profile.secretReference === undefined)
        throw new Error(
            'A Claude Code profile needs a named credential reference for constrained execution.',
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

interface ClaudeCodeResult {
    readonly type?: unknown;
    readonly subtype?: unknown;
    readonly is_error?: unknown;
    readonly result?: unknown;
    readonly structured_output?: unknown;
}

const parseResult = (text: string): unknown => {
    let document: ClaudeCodeResult;
    try {
        document = JSON.parse(text) as ClaudeCodeResult;
    } catch {
        throw new Error('Claude Code returned invalid structured output.');
    }
    if (
        document.type !== 'result' ||
        document.subtype !== 'success' ||
        document.is_error === true
    )
        throw new Error(
            'Claude Code did not complete the constrained request.',
        );
    const value = document.structured_output ?? document.result;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as unknown;
        } catch {
            throw new Error('Claude Code returned invalid structured output.');
        }
    }
    if (value === null || typeof value !== 'object')
        throw new Error('Claude Code returned invalid structured output.');
    return value;
};

export interface ConstrainedLocalCliExecutionOptions {
    readonly executable: string;
    readonly arguments: ReadonlyArray<string>;
    readonly cwd: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
}

export type ConstrainedLocalCliExecution = (
    options: ConstrainedLocalCliExecutionOptions,
) => Promise<string>;

export type LocalClaudeCodeExecutionOptions =
    ConstrainedLocalCliExecutionOptions;
export type LocalClaudeCodeExecution = ConstrainedLocalCliExecution;

const terminate = (pid: number | undefined, signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    if (process.platform === 'win32') {
        const taskkill = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        taskkill.once('error', () => {
            try {
                process.kill(pid, signal);
            } catch {
                // The direct child may already have exited.
            }
        });
        return;
    }
    try {
        process.kill(-pid, signal);
        return;
    } catch {
        // The process group may have exited between the check and signal.
    }
    try {
        process.kill(pid, signal);
    } catch {
        // The direct child may already have exited.
    }
};

/**
 * Host-process boundary for the constrained adapter. Exported for hermetic
 * process-limit tests; callers should normally use localClaudeCodeInferenceRunner.
 */
export const constrainedLocalCliExecution =
    (providerName: string): ConstrainedLocalCliExecution =>
    ({
        executable,
        arguments: args,
        cwd,
        environment,
        signal,
        timeoutMs,
        maxOutputBytes,
    }) =>
        new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new Error(`${providerName} request cancelled.`));
                return;
            }
            let settled = false;
            let closed = false;
            let outputBytes = 0;
            const chunks: Buffer[] = [];
            let forceKill: NodeJS.Timeout | undefined;
            let timeout: NodeJS.Timeout | undefined;
            const cleanup = () => {
                if (timeout !== undefined) clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
            };
            const fail = (message: string) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(message));
            };
            const child = spawn(executable, [...args], {
                cwd,
                env: environment,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            const stop = () => {
                terminate(child.pid, 'SIGTERM');
                if (forceKill === undefined)
                    forceKill = setTimeout(() => {
                        if (!closed) terminate(child.pid, 'SIGKILL');
                    }, 1_000).unref();
            };
            timeout = setTimeout(() => {
                stop();
                fail(`${providerName} request timed out.`);
            }, timeoutMs);
            const abort = () => {
                stop();
                fail(`${providerName} request cancelled.`);
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            const capture = (chunk: Buffer, includeInResult: boolean) => {
                outputBytes += chunk.length;
                if (outputBytes > maxOutputBytes) {
                    stop();
                    fail(`${providerName} response exceeded the output limit.`);
                    return;
                }
                if (includeInResult) chunks.push(chunk);
            };
            child.stdout.on('data', (chunk: Buffer) => capture(chunk, true));
            child.stderr.on('data', (chunk: Buffer) => capture(chunk, false));
            child.on('error', () =>
                fail(`${providerName} could not be started.`),
            );
            child.on('close', code => {
                closed = true;
                if (forceKill !== undefined) clearTimeout(forceKill);
                cleanup();
                if (settled) return;
                if (code !== 0) {
                    fail(
                        `${providerName} did not complete the constrained request.`,
                    );
                    return;
                }
                settled = true;
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
        });

export const executeClaudeCode = constrainedLocalCliExecution('Claude Code');

export interface LocalClaudeCodeInferenceRunnerOptions {
    readonly profile: InferenceProfile;
    readonly secrets: InferenceSecretResolver;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    /** Test seam; production uses a direct, constrained process spawn. */
    readonly execute?: LocalClaudeCodeExecution;
}

/**
 * Builds a no-tool, one-shot Claude Code runner. It runs from an empty host
 * temporary directory with a reduced environment and does not expose any
 * repository path, cwd, shell, MCP server, session, or user configuration.
 */
export const localClaudeCodeInferenceRunner = ({
    profile,
    secrets,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    execute = executeClaudeCode,
}: LocalClaudeCodeInferenceRunnerOptions): InferenceStructuredOutputRunner => {
    requireClaudeProfile(profile);
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 120_000
    )
        throw new Error(
            'Claude Code timeout must be an integer between 1 and 120000 ms.',
        );
    if (
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1 ||
        maxOutputBytes > 4_000_000
    )
        throw new Error(
            'Claude Code output limit must be an integer between 1 and 4000000 bytes.',
        );
    const credential = requireSecret(secrets, profile.secretReference!);
    const executable = profile.executable!;
    const model = profile.modelId!;
    return {
        run: async input => {
            if (signal?.aborted)
                throw new Error('Claude Code request cancelled.');
            const cwd = await mkdtemp(join(tmpdir(), 'cbranch-wi-claude-'));
            try {
                const result = await execute({
                    executable,
                    arguments: [
                        '--bare',
                        '--safe-mode',
                        '--disable-slash-commands',
                        '--no-chrome',
                        '--print',
                        '--output-format',
                        'json',
                        '--json-schema',
                        constrainedStructuredOutputSchema,
                        '--tools',
                        '',
                        '--strict-mcp-config',
                        '--mcp-config',
                        EMPTY_MCP_CONFIGURATION,
                        '--no-session-persistence',
                        '--permission-mode',
                        'dontAsk',
                        '--max-turns',
                        '1',
                        '--model',
                        model,
                        prompt(input),
                    ],
                    cwd,
                    environment: {
                        PATH: process.env.PATH ?? '',
                        HOME: cwd,
                        TMPDIR: cwd,
                        LANG: process.env.LANG ?? 'C.UTF-8',
                        ANTHROPIC_API_KEY: credential,
                        DISABLE_AUTOUPDATER: '1',
                        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
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
