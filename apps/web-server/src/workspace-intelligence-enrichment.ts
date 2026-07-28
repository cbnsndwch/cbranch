// Host-level orchestration for optional enrichment. It deliberately receives
// narrow graph/profile/attempt ports, so it cannot obtain repository paths,
// raw source, credential values, or a filesystem capability.

import type { EngagementId } from '@cbranch/rpc-contract';
import {
    normalizeEnrichmentWithOneRepair,
    type InferenceNormalizationResult,
    type InferenceProfile,
    type InferenceSelectedEvidence,
    type InferenceStructuredOutputRunner,
} from '@cbranch/inference';
import type {
    WorkspaceIntelligenceEnrichmentAttempt,
    WorkspaceIntelligenceEnrichmentStore,
} from '@cbranch/workspace-intelligence';

const PROMPT_SCHEMA_VERSION = 'workspace-intelligence.enrichment@1';

type EnrichmentFailure = NonNullable<
    WorkspaceIntelligenceEnrichmentAttempt['failure']
>;

type EnrichmentResult =
    | InferenceNormalizationResult
    | { readonly ok: false; readonly failure: EnrichmentFailure };

const cancelledFailure = (): EnrichmentFailure => ({
    code: 'cancelled',
    message: 'Enrichment cancelled.',
    repairAttempted: false,
});

const providerFailure = (
    error: unknown,
    repairAttempted: boolean,
): EnrichmentFailure => ({
    code: 'providerFailure',
    message: error instanceof Error ? error.message : String(error),
    repairAttempted,
});

const profileForEnrichment = (
    profiles: ReadonlyArray<InferenceProfile>,
    profileId: string | undefined,
): InferenceProfile => {
    if (profileId === undefined)
        throw new Error(
            'Enrichment is disabled until this workspace selects a generation profile.',
        );
    const profile = profiles.find(candidate => candidate.id === profileId);
    if (profile === undefined)
        throw new Error('The selected enrichment profile no longer exists.');
    if (!profile.enabled)
        throw new Error('The selected enrichment profile is disabled.');
    if (!profile.capabilities.includes('generation'))
        throw new Error(
            'The selected enrichment profile does not support generation.',
        );
    if (
        profile.provider !== 'openai-compatible' &&
        profile.provider !== 'claude-code' &&
        profile.provider !== 'codex' &&
        profile.provider !== 'opencode'
    )
        throw new Error(
            'This local generation profile is configuration-only until a non-agent constrained adapter is available.',
        );
    return profile;
};

export interface WorkspaceIntelligenceEnrichmentRunnerOptions {
    readonly engagementId: EngagementId;
    readonly runId: string;
    readonly requestedProfileId?: string;
    readonly requestedEvidenceLimit?: number;
    readonly runs: {
        readonly get: (
            engagementId: EngagementId,
            runId: string,
        ) => Promise<{ readonly isValid: boolean }>;
    };
    readonly evidence: {
        readonly inferenceEvidence: (
            engagementId: EngagementId,
            runId: string,
            limit?: number,
        ) => Promise<ReadonlyArray<InferenceSelectedEvidence>>;
    };
    readonly attempts: Pick<
        WorkspaceIntelligenceEnrichmentStore,
        'writeAttempt' | 'readAttempt'
    >;
    readonly profiles: () => Promise<ReadonlyArray<InferenceProfile>>;
    readonly defaults: () => Promise<{
        readonly generationProfileId?: string;
    }>;
    readonly runnerForProfile: (
        profile: InferenceProfile,
        signal: AbortSignal | undefined,
    ) => InferenceStructuredOutputRunner;
    readonly now: () => number;
    readonly nextAttemptId: () => string;
    /** A host-owned operation signal, never a browser-controlled provider input. */
    readonly signal?: AbortSignal;
}

/**
 * Executes exactly one immutable enrichment attempt. Provider output is accepted
 * only through the reusable one-repair normalizer; a provider error becomes a
 * failed child and never invalidates the deterministic run.
 */
export const runWorkspaceIntelligenceEnrichment = async ({
    engagementId,
    runId,
    requestedProfileId,
    requestedEvidenceLimit,
    runs,
    evidence: evidencePort,
    attempts,
    profiles: loadProfiles,
    defaults: loadDefaults,
    runnerForProfile,
    now,
    nextAttemptId,
    signal,
}: WorkspaceIntelligenceEnrichmentRunnerOptions): Promise<WorkspaceIntelligenceEnrichmentAttempt> => {
    const run = await runs.get(engagementId, runId);
    if (!run.isValid)
        throw new Error(
            'Only a valid finalized deterministic run can be enriched.',
        );
    const [profiles, defaults] = await Promise.all([
        loadProfiles(),
        loadDefaults(),
    ]);
    const profile = profileForEnrichment(
        profiles,
        requestedProfileId ?? defaults.generationProfileId,
    );
    const evidence = await evidencePort.inferenceEvidence(
        engagementId,
        runId,
        requestedEvidenceLimit,
    );
    if (evidence.length === 0)
        throw new Error(
            'The deterministic run has no bounded graph evidence available for enrichment.',
        );

    const createdAt = now();
    const request = {
        profileId: profile.id,
        model: profile.modelId ?? profile.provider,
        evidence: [...evidence],
        promptSchemaVersion: PROMPT_SCHEMA_VERSION,
    };
    let result: EnrichmentResult;
    if (signal?.aborted) result = { ok: false, failure: cancelledFailure() };
    else
        try {
            result = await normalizeEnrichmentWithOneRepair(
                runnerForProfile(profile, signal),
                request,
            );
            if (signal?.aborted)
                result = { ok: false, failure: cancelledFailure() };
        } catch (error) {
            result = signal?.aborted
                ? { ok: false, failure: cancelledFailure() }
                : { ok: false, failure: providerFailure(error, false) };
        }
    const completedAt = now();
    const attempt: WorkspaceIntelligenceEnrichmentAttempt = result.ok
        ? {
              id: nextAttemptId(),
              runId,
              profileId: profile.id,
              modelId: request.model,
              promptSchemaVersion: PROMPT_SCHEMA_VERSION,
              createdAt,
              completedAt,
              evidenceIds: evidence.map(item => item.id),
              state: 'completed',
              repairAttempted: result.repairAttempted,
              inferredEdges: result.value.inferredEdges.map(edge => ({
                  ...edge,
                  confidenceTier: 'low',
              })),
              ...(result.value.summary === undefined
                  ? {}
                  : { summary: result.value.summary }),
              ...(result.value.usage === undefined
                  ? {}
                  : { usage: result.value.usage }),
              durationMs:
                  result.value.timing?.durationMs ?? completedAt - createdAt,
          }
        : {
              id: nextAttemptId(),
              runId,
              profileId: profile.id,
              modelId: request.model,
              promptSchemaVersion: PROMPT_SCHEMA_VERSION,
              createdAt,
              completedAt,
              evidenceIds: evidence.map(item => item.id),
              state:
                  result.failure.code === 'cancelled' ? 'cancelled' : 'failed',
              repairAttempted: result.failure.repairAttempted,
              inferredEdges: [],
              durationMs: completedAt - createdAt,
              failure: result.failure,
          };
    await attempts.writeAttempt(engagementId, attempt);
    const stored = await attempts.readAttempt(engagementId, runId, attempt.id);
    if (stored === undefined)
        throw new Error('The immutable enrichment attempt was not persisted.');
    return stored;
};
