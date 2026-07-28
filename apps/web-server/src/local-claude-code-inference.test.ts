import {
    InferenceEnrichmentRequest,
    InferenceProfile,
} from '@cbranch/inference';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';

import { environmentInferenceSecretResolver } from './openai-compatible-inference';
import {
    executeClaudeCode,
    localClaudeCodeInferenceRunner,
    type LocalClaudeCodeExecution,
} from './local-claude-code-inference';

const profile = InferenceProfile.parse({
    id: 'claude-local',
    label: 'Constrained Claude Code',
    provider: 'claude-code',
    enabled: true,
    capabilities: ['generation'],
    executable: '/usr/local/bin/claude',
    modelId: 'claude-sonnet-test',
    secretReference: { kind: 'environment', name: 'ANTHROPIC_TEST_KEY' },
});
const request = InferenceEnrichmentRequest.parse({
    profileId: profile.id,
    model: profile.modelId!,
    evidence: [
        {
            id: 'component:api',
            content: 'The deterministic API exposes the users contract.',
        },
    ],
    promptSchemaVersion: 'workspace-intelligence.enrichment@1',
});

const successfulOutput = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify({
        schemaVersion: 1,
        inferredEdges: [
            {
                from: 'component:api',
                to: 'contract:users',
                kind: 'exposes',
                confidence: 0.8,
                evidenceIds: ['component:api'],
                rationale:
                    'The selected deterministic component exposes users.',
            },
        ],
    }),
});

const processEnvironment = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
};

describe('localClaudeCodeInferenceRunner', () => {
    test('uses a no-tool one-shot process contract with only a reduced environment', async () => {
        const execute = vi.fn<LocalClaudeCodeExecution>(
            async _options => successfulOutput,
        );
        const runner = localClaudeCodeInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                ANTHROPIC_TEST_KEY: 'test-secret',
            }),
            execute,
        });

        await expect(runner.run({ request })).resolves.toMatchObject({
            schemaVersion: 1,
            inferredEdges: [
                expect.objectContaining({
                    evidenceIds: ['component:api'],
                }),
            ],
        });
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                executable: '/usr/local/bin/claude',
                arguments: expect.arrayContaining([
                    '--bare',
                    '--safe-mode',
                    '--disable-slash-commands',
                    '--no-chrome',
                    '--print',
                    '--output-format',
                    'json',
                    '--tools',
                    '',
                    '--strict-mcp-config',
                    '--no-session-persistence',
                    '--permission-mode',
                    'dontAsk',
                    '--max-turns',
                    '1',
                ]),
                environment: {
                    PATH: expect.any(String),
                    HOME: expect.any(String),
                    TMPDIR: expect.any(String),
                    LANG: expect.any(String),
                    ANTHROPIC_API_KEY: 'test-secret',
                    DISABLE_AUTOUPDATER: '1',
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                },
            }),
        );
        const call = execute.mock.calls[0]?.[0];
        if (call === undefined)
            throw new Error('Expected Claude Code execution.');
        expect(call.arguments).not.toEqual(
            expect.arrayContaining(['--add-dir']),
        );
        expect(call.arguments).not.toEqual(expect.arrayContaining(['--agent']));
        expect(call.arguments.join(' ')).not.toContain('test-secret');
        expect(call.cwd).toBe(call.environment.HOME);
        expect(call.cwd).toBe(call.environment.TMPDIR);
    });

    test('does not spawn after host cancellation and never exposes an agent profile', async () => {
        const controller = new AbortController();
        controller.abort();
        const execute = vi.fn<LocalClaudeCodeExecution>(
            async _options => successfulOutput,
        );
        const runner = localClaudeCodeInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                ANTHROPIC_TEST_KEY: 'test-secret',
            }),
            signal: controller.signal,
            execute,
        });

        await expect(runner.run({ request })).rejects.toThrow('cancelled');
        expect(execute).not.toHaveBeenCalled();
        expect(() =>
            localClaudeCodeInferenceRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    provider: 'codex',
                    executable: '/usr/local/bin/codex',
                }),
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('only supports Claude Code');
    });

    test('fails closed when the CLI result is malformed or the credential is absent', async () => {
        const execute = vi.fn<LocalClaudeCodeExecution>(
            async _options => '{"type":"result"}',
        );
        const runner = localClaudeCodeInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                ANTHROPIC_TEST_KEY: 'test-secret',
            }),
            execute,
        });

        await expect(runner.run({ request })).rejects.toThrow(
            'did not complete the constrained request',
        );
        expect(() =>
            localClaudeCodeInferenceRunner({
                profile,
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('credential is unavailable');
    });

    test('enforces child cancellation, timeout, and combined output limits', async () => {
        const requestWith = (
            arguments_: ReadonlyArray<string>,
            overrides: Partial<Parameters<LocalClaudeCodeExecution>[0]> = {},
        ) =>
            executeClaudeCode({
                executable: process.execPath,
                arguments: arguments_,
                cwd: tmpdir(),
                environment: processEnvironment,
                timeoutMs: 5_000,
                maxOutputBytes: 1_024,
                ...overrides,
            });

        const controller = new AbortController();
        const cancelled = requestWith(
            ['--eval', 'setInterval(() => undefined, 1_000);'],
            { signal: controller.signal },
        );
        controller.abort();
        await expect(cancelled).rejects.toThrow('cancelled');

        await expect(
            requestWith(['--eval', 'setInterval(() => undefined, 1_000);'], {
                timeoutMs: 10,
            }),
        ).rejects.toThrow('timed out');

        await expect(
            requestWith(['--eval', 'process.stderr.write("x".repeat(2_048));']),
        ).rejects.toThrow('output limit');
    });

    test.skipIf(
        process.env.CBRANCH_CLAUDE_INFERENCE_MODEL === undefined ||
            process.env.CBRANCH_CLAUDE_INFERENCE_SECRET === undefined,
    )(
        'executes generic selected evidence through an explicitly enabled Claude Code model',
        async () => {
            const modelId = process.env.CBRANCH_CLAUDE_INFERENCE_MODEL;
            const credential = process.env.CBRANCH_CLAUDE_INFERENCE_SECRET;
            if (modelId === undefined || credential === undefined)
                throw new Error(
                    'An explicit model and credential are required.',
                );
            const runner = localClaudeCodeInferenceRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    modelId,
                    executable:
                        process.env.CBRANCH_CLAUDE_INFERENCE_EXECUTABLE ??
                        profile.executable,
                    secretReference: {
                        kind: 'environment',
                        name: 'CBRANCH_CLAUDE_INFERENCE_SECRET',
                    },
                }),
                secrets: environmentInferenceSecretResolver({
                    CBRANCH_CLAUDE_INFERENCE_SECRET: credential,
                }),
                timeoutMs: 120_000,
            });

            const result = await runner.run({ request });

            expect(result).toMatchObject({ schemaVersion: 1 });
        },
        120_000,
    );
});
