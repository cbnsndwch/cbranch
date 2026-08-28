import { readFile } from 'node:fs/promises';

import {
    InferenceEnrichmentRequest,
    InferenceProfile,
} from '@cbranch/inference';
import { describe, expect, test, vi } from 'vitest';

import { environmentInferenceSecretResolver } from './openai-compatible-inference';
import {
    localOpenCodeInferenceRunner,
    type LocalOpenCodeExecution,
} from './local-opencode-inference';

const profile = InferenceProfile.parse({
    id: 'opencode-local',
    label: 'Constrained OpenCode',
    provider: 'opencode',
    enabled: true,
    capabilities: ['generation'],
    executable: '/usr/local/bin/opencode',
    modelId: 'openai/gpt-5.6',
    secretReference: { kind: 'environment', name: 'OPENAI_API_KEY' },
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
    schemaVersion: 1,
    inferredEdges: [
        {
            from: 'component:api',
            to: 'contract:users',
            kind: 'exposes',
            confidence: 0.8,
            evidenceIds: ['component:api'],
            rationale: 'The selected deterministic component exposes users.',
        },
    ],
});

describe('localOpenCodeInferenceRunner', () => {
    test('uses a no-tool one-shot process contract with only a reduced environment', async () => {
        const execute = vi.fn<LocalOpenCodeExecution>(async options => {
            const config = JSON.parse(
                await readFile(`${options.cwd}/opencode.json`, 'utf8'),
            ) as {
                readonly permission?: Record<string, string>;
                readonly agent?: Record<
                    string,
                    { readonly permission?: Record<string, string> }
                >;
            };
            expect(config.permission?.['*']).toBe('deny');
            expect(config.agent?.['cbranch-inference']?.permission?.['*']).toBe(
                'deny',
            );
            return successfulOutput;
        });
        const runner = localOpenCodeInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                OPENAI_API_KEY: 'test-secret',
            }),
            execute,
        });

        await expect(runner.run({ request })).resolves.toMatchObject({
            schemaVersion: 1,
            inferredEdges: [
                expect.objectContaining({ evidenceIds: ['component:api'] }),
            ],
        });
        expect(execute).toHaveBeenCalledWith(
            expect.objectContaining({
                executable: '/usr/local/bin/opencode',
                arguments: expect.arrayContaining([
                    '--pure',
                    'run',
                    '--agent',
                    'cbranch-inference',
                    '--model',
                    '--dir',
                ]),
                environment: {
                    PATH: expect.any(String),
                    HOME: expect.any(String),
                    XDG_CONFIG_HOME: expect.any(String),
                    XDG_DATA_HOME: expect.any(String),
                    XDG_CACHE_HOME: expect.any(String),
                    TMPDIR: expect.any(String),
                    LANG: expect.any(String),
                    OPENCODE_API_KEY: 'test-secret',
                    OPENAI_API_KEY: 'test-secret',
                    NO_COLOR: '1',
                },
            }),
        );
        const call = execute.mock.calls[0]?.[0];
        if (call === undefined) throw new Error('Expected OpenCode execution.');
        expect(call.arguments.join(' ')).not.toContain('test-secret');
        expect(call.cwd).toBe(call.environment.HOME);
        expect(call.cwd).toBe(call.environment.XDG_CONFIG_HOME);
        expect(call.cwd).toBe(call.environment.XDG_DATA_HOME);
        expect(call.cwd).toBe(call.environment.XDG_CACHE_HOME);
        expect(call.cwd).toBe(call.environment.TMPDIR);
    });

    test('does not spawn after host cancellation and never accepts another provider', async () => {
        const controller = new AbortController();
        controller.abort();
        const execute = vi.fn<LocalOpenCodeExecution>(
            async _options => successfulOutput,
        );
        const runner = localOpenCodeInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                OPENAI_API_KEY: 'test-secret',
            }),
            signal: controller.signal,
            execute,
        });

        await expect(runner.run({ request })).rejects.toThrow('cancelled');
        expect(execute).not.toHaveBeenCalled();
        expect(() =>
            localOpenCodeInferenceRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    provider: 'codex',
                    executable: '/usr/local/bin/codex',
                }),
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('only supports OpenCode');
    });

    test('fails closed when the CLI result is malformed or the credential is absent', async () => {
        const execute = vi.fn<LocalOpenCodeExecution>(
            async _options => 'not json',
        );
        const runner = localOpenCodeInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                OPENAI_API_KEY: 'test-secret',
            }),
            execute,
        });

        await expect(runner.run({ request })).rejects.toThrow(
            'invalid structured output',
        );
        expect(() =>
            localOpenCodeInferenceRunner({
                profile,
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('credential is unavailable');
    });
});
