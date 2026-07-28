import { readFile } from 'node:fs/promises';

import {
    InferenceEnrichmentRequest,
    InferenceProfile,
} from '@cbranch/inference';
import { describe, expect, test, vi } from 'vitest';

import { environmentInferenceSecretResolver } from './openai-compatible-inference';
import {
    localCodexInferenceRunner,
    type LocalCodexExecution,
} from './local-codex-inference';

const profile = InferenceProfile.parse({
    id: 'codex-local',
    label: 'Constrained Codex',
    provider: 'codex',
    enabled: true,
    capabilities: ['generation'],
    executable: '/usr/local/bin/codex',
    modelId: 'gpt-5.6',
    secretReference: { kind: 'environment', name: 'CODEX_TEST_KEY' },
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

describe('localCodexInferenceRunner', () => {
    test('uses a no-tool one-shot process contract with only a reduced environment', async () => {
        const execute = vi.fn<LocalCodexExecution>(async options => {
            const schemaIndex = options.arguments.indexOf('--output-schema');
            const schemaPath = options.arguments[schemaIndex + 1];
            if (schemaPath === undefined)
                throw new Error('Expected an output schema path.');
            const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
                readonly properties?: { readonly inferredEdges?: unknown };
            };
            expect(schema.properties?.inferredEdges).toBeDefined();
            return successfulOutput;
        });
        const runner = localCodexInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                CODEX_TEST_KEY: 'test-secret',
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
                executable: '/usr/local/bin/codex',
                arguments: expect.arrayContaining([
                    'exec',
                    '--sandbox',
                    'read-only',
                    '--ask-for-approval',
                    'never',
                    '--ignore-user-config',
                    '--ignore-rules',
                    '--ephemeral',
                    '--strict-config',
                    '--skip-git-repo-check',
                    '--output-schema',
                ]),
                environment: {
                    PATH: expect.any(String),
                    HOME: expect.any(String),
                    CODEX_HOME: expect.any(String),
                    TMPDIR: expect.any(String),
                    LANG: expect.any(String),
                    CODEX_API_KEY: 'test-secret',
                    NO_COLOR: '1',
                },
            }),
        );
        const call = execute.mock.calls[0]?.[0];
        if (call === undefined) throw new Error('Expected Codex execution.');
        expect(call.arguments.slice(0, 3)).toEqual([
            '--ask-for-approval',
            'never',
            'exec',
        ]);
        expect(call.arguments).toEqual(
            expect.arrayContaining(['web_search = "disabled"']),
        );
        expect(call.arguments.join(' ')).not.toContain('test-secret');
        expect(call.cwd).toBe(call.environment.HOME);
        expect(call.cwd).toBe(call.environment.CODEX_HOME);
        expect(call.cwd).toBe(call.environment.TMPDIR);
    });

    test('does not spawn after host cancellation and never accepts another provider', async () => {
        const controller = new AbortController();
        controller.abort();
        const execute = vi.fn<LocalCodexExecution>(
            async _options => successfulOutput,
        );
        const runner = localCodexInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                CODEX_TEST_KEY: 'test-secret',
            }),
            signal: controller.signal,
            execute,
        });

        await expect(runner.run({ request })).rejects.toThrow('cancelled');
        expect(execute).not.toHaveBeenCalled();
        expect(() =>
            localCodexInferenceRunner({
                profile: InferenceProfile.parse({
                    ...profile,
                    provider: 'claude-code',
                    executable: '/usr/local/bin/claude',
                }),
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('only supports Codex');
    });

    test('fails closed when the CLI result is malformed or the credential is absent', async () => {
        const execute = vi.fn<LocalCodexExecution>(
            async _options => 'not json',
        );
        const runner = localCodexInferenceRunner({
            profile,
            secrets: environmentInferenceSecretResolver({
                CODEX_TEST_KEY: 'test-secret',
            }),
            execute,
        });

        await expect(runner.run({ request })).rejects.toThrow(
            'invalid structured output',
        );
        expect(() =>
            localCodexInferenceRunner({
                profile,
                secrets: environmentInferenceSecretResolver({}),
            }),
        ).toThrow('credential is unavailable');
    });
});
