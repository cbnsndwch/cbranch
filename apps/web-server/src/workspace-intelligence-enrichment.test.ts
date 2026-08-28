import { EngagementId } from '@cbranch/rpc-contract';
import { InferenceProfile } from '@cbranch/inference';
import type { WorkspaceIntelligenceEnrichmentAttempt } from '@cbranch/workspace-intelligence';
import { describe, expect, test, vi } from 'vitest';

import {
    runWorkspaceIntelligenceEnrichment,
    type WorkspaceIntelligenceEnrichmentRunnerOptions,
} from './workspace-intelligence-enrichment';

const engagementId = EngagementId.make('workspace-a');
const profile = InferenceProfile.parse({
    id: 'hosted-default',
    label: 'Hosted default',
    provider: 'openai-compatible',
    enabled: true,
    capabilities: ['generation'],
    endpoint: 'https://inference.example.test/v1',
    modelId: 'example-model',
    secretReference: { kind: 'environment', name: 'EXAMPLE_API_KEY' },
});

const setup = (
    runner: () => { readonly run: (input: unknown) => Promise<unknown> },
    defaults: WorkspaceIntelligenceEnrichmentRunnerOptions['defaults'] = async () => ({
        generationProfileId: profile.id,
    }),
): {
    readonly stored: () => WorkspaceIntelligenceEnrichmentAttempt | undefined;
    readonly options: WorkspaceIntelligenceEnrichmentRunnerOptions;
} => {
    let stored: WorkspaceIntelligenceEnrichmentAttempt | undefined;
    let time = 10;
    const options: WorkspaceIntelligenceEnrichmentRunnerOptions = {
        engagementId,
        runId: 'run-a',
        runs: {
            get: async () => ({ isValid: true }),
        },
        evidence: {
            inferenceEvidence: async () => [
                {
                    id: 'component:api',
                    content: 'A deterministic API component.',
                },
            ],
        },
        attempts: {
            writeAttempt: async (
                _engagementId: typeof engagementId,
                attempt: WorkspaceIntelligenceEnrichmentAttempt,
            ) => {
                stored = attempt;
            },
            readAttempt: async (
                _engagementId: typeof engagementId,
                _runId: string,
                attemptId: string,
            ) => (stored?.id === attemptId ? stored : undefined),
        },
        profiles: async () => [profile],
        defaults,
        runnerForProfile: () => runner(),
        now: () => time++,
        nextAttemptId: () => 'attempt-1',
    };
    return { stored: () => stored, options };
};

describe('runWorkspaceIntelligenceEnrichment', () => {
    test('repairs invalid output once and persists only the normalized attempt', async () => {
        const run = vi
            .fn()
            .mockResolvedValueOnce({
                schemaVersion: 1,
                inferredEdges: [
                    {
                        from: 'component:api',
                        to: 'contract:users',
                        kind: 'exposes',
                        confidence: 0.83,
                        evidenceIds: ['not-selected'],
                        rationale: 'This citation was not selected.',
                    },
                ],
            })
            .mockResolvedValueOnce({
                schemaVersion: 1,
                inferredEdges: [
                    {
                        from: 'component:api',
                        to: 'contract:users',
                        kind: 'exposes',
                        confidence: 0.83,
                        evidenceIds: ['component:api'],
                        rationale: 'The selected API component exposes users.',
                    },
                ],
                summary: 'Optional inferred architecture.',
            });
        const { options, stored } = setup(() => ({ run }));

        const result = await runWorkspaceIntelligenceEnrichment(options);

        expect(run).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            id: 'attempt-1',
            state: 'completed',
            repairAttempted: true,
            evidenceIds: ['component:api'],
        });
        expect(stored()).toEqual(result);
        expect(result.inferredEdges[0]).toMatchObject({
            confidence: 0.83,
            confidenceTier: 'low',
        });
    });

    test('records a provider setup failure without invalidating the deterministic run', async () => {
        const { options, stored } = setup(() => {
            throw new Error('Named credential unavailable.');
        });

        const result = await runWorkspaceIntelligenceEnrichment(options);

        expect(result).toMatchObject({
            state: 'failed',
            inferredEdges: [],
            failure: {
                code: 'providerFailure',
                message: 'Named credential unavailable.',
            },
        });
        expect(stored()).toEqual(result);
    });

    test('retains a cancelled attempt without accepting provider output', async () => {
        let release: () => void = () => undefined;
        const reachedRunner = new Promise<void>(resolve => {
            release = resolve;
        });
        let finishRunner: () => void = () => undefined;
        const runnerFinished = new Promise<void>(resolve => {
            finishRunner = resolve;
        });
        const controller = new AbortController();
        const run = vi.fn(async () => {
            release();
            await runnerFinished;
            return { schemaVersion: 1, inferredEdges: [] };
        });
        const { options, stored } = setup(() => ({ run }));

        const pending = runWorkspaceIntelligenceEnrichment({
            ...options,
            signal: controller.signal,
        });
        await reachedRunner;
        controller.abort();
        finishRunner();

        await expect(pending).resolves.toMatchObject({
            state: 'cancelled',
            inferredEdges: [],
            failure: {
                code: 'cancelled',
                message: 'Enrichment cancelled.',
            },
        });
        expect(run).toHaveBeenCalledOnce();
        expect(stored()).toMatchObject({ state: 'cancelled' });
    });

    test('does not create an attempt when the workspace leaves enrichment disabled', async () => {
        const { options, stored } = setup(
            () => ({
                run: async () => ({ schemaVersion: 1, inferredEdges: [] }),
            }),
            async () => ({}),
        );

        await expect(
            runWorkspaceIntelligenceEnrichment(options),
        ).rejects.toThrow('Enrichment is disabled');
        expect(stored()).toBeUndefined();
    });

    test('admits a constrained OpenCode profile through the selected runner', async () => {
        const run = vi.fn(async () => ({
            schemaVersion: 1,
            inferredEdges: [],
        }));
        const runnerForProfile = vi.fn(() => ({ run }));
        const { options, stored } = setup(() => ({ run }));
        const openCodeProfile = InferenceProfile.parse({
            id: 'local-opencode',
            label: 'Local OpenCode',
            provider: 'opencode',
            enabled: true,
            capabilities: ['generation'],
            executable: '/usr/local/bin/opencode',
            modelId: 'openai/gpt-5.6',
            secretReference: {
                kind: 'environment',
                name: 'OPENAI_API_KEY',
            },
        });

        const result = await runWorkspaceIntelligenceEnrichment({
            ...options,
            profiles: async () => [openCodeProfile],
            defaults: async () => ({ generationProfileId: openCodeProfile.id }),
            runnerForProfile,
        });

        expect(runnerForProfile).toHaveBeenCalledWith(
            openCodeProfile,
            undefined,
        );
        expect(run).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            profileId: openCodeProfile.id,
            state: 'completed',
        });
        expect(stored()).toEqual(result);
    });

    test('admits a constrained Codex profile through the selected runner', async () => {
        const run = vi.fn(async () => ({
            schemaVersion: 1,
            inferredEdges: [],
        }));
        const runnerForProfile = vi.fn(() => ({ run }));
        const { options, stored } = setup(() => ({ run }));
        const codexProfile = InferenceProfile.parse({
            id: 'local-codex',
            label: 'Local Codex',
            provider: 'codex',
            enabled: true,
            capabilities: ['generation'],
            executable: '/usr/local/bin/codex',
            modelId: 'gpt-5.6',
            secretReference: {
                kind: 'environment',
                name: 'CODEX_TEST_KEY',
            },
        });

        const result = await runWorkspaceIntelligenceEnrichment({
            ...options,
            profiles: async () => [codexProfile],
            defaults: async () => ({ generationProfileId: codexProfile.id }),
            runnerForProfile,
        });

        expect(runnerForProfile).toHaveBeenCalledWith(codexProfile, undefined);
        expect(run).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            profileId: codexProfile.id,
            state: 'completed',
        });
        expect(stored()).toEqual(result);
    });
});
