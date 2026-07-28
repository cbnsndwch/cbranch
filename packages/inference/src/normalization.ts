import { z } from 'zod';

/**
 * The normalized, provider-neutral shape expected from a TanStack AI
 * structured-output adapter. It contains only selected evidence IDs, never
 * repository paths, raw prompts, or raw provider responses.
 */
export const InferenceEnrichmentEnvelope = z.object({
    schemaVersion: z.literal(1),
    inferredEdges: z.array(
        z.object({
            from: z.string().min(1),
            to: z.string().min(1),
            kind: z.string().min(1),
            confidence: z.number().min(0).max(1),
            evidenceIds: z.array(z.string().min(1)).min(1),
            rationale: z.string().min(1).max(4_000),
        }),
    ),
    summary: z.string().min(1).max(12_000).optional(),
    usage: z
        .object({
            inputTokens: z.number().int().nonnegative().optional(),
            outputTokens: z.number().int().nonnegative().optional(),
        })
        .optional(),
    timing: z
        .object({
            durationMs: z.number().finite().nonnegative(),
        })
        .optional(),
});
export type InferenceEnrichmentEnvelope = z.infer<
    typeof InferenceEnrichmentEnvelope
>;

/** The only source material an inference runner is allowed to receive. */
export const InferenceSelectedEvidence = z.object({
    id: z.string().min(1),
    content: z.string().min(1).max(12_000),
});
export type InferenceSelectedEvidence = z.infer<
    typeof InferenceSelectedEvidence
>;

export const InferenceEnrichmentRequest = z.object({
    profileId: z.string().min(1),
    model: z.string().min(1),
    evidence: z.array(InferenceSelectedEvidence).min(1).max(200),
    promptSchemaVersion: z.string().min(1),
});
export type InferenceEnrichmentRequest = z.infer<
    typeof InferenceEnrichmentRequest
>;

export const InferenceEnrichmentFailure = z.object({
    code: z.enum(['invalidStructuredOutput', 'providerFailure']),
    message: z.string().min(1),
    repairAttempted: z.boolean(),
});
export type InferenceEnrichmentFailure = z.infer<
    typeof InferenceEnrichmentFailure
>;

export interface InferenceStructuredOutputRunner {
    /**
     * The adapter owns provider IO. cbranch passes only selected evidence and
     * validation diagnostics; this package never provides a repository cwd,
     * filesystem capability, shell tool, or raw secret.
     */
    readonly run: (input: {
        readonly request: InferenceEnrichmentRequest;
        readonly repair?: {
            readonly invalidOutput: unknown;
            readonly validationErrors: ReadonlyArray<string>;
        };
    }) => Promise<unknown>;
}

export type InferenceNormalizationResult =
    | {
          readonly ok: true;
          readonly value: InferenceEnrichmentEnvelope;
          readonly repairAttempted: boolean;
      }
    | {
          readonly ok: false;
          readonly failure: InferenceEnrichmentFailure;
      };

const validationErrors = (error: z.ZodError): ReadonlyArray<string> =>
    error.issues.map(
        issue =>
            `${issue.path.length === 0 ? '$' : issue.path.join('.')}: ${issue.message}`,
    );

type EnrichmentValidation =
    | { readonly ok: true; readonly value: InferenceEnrichmentEnvelope }
    | { readonly ok: false; readonly errors: ReadonlyArray<string> };

const validateEnrichment = (
    value: unknown,
    allowedEvidenceIds: ReadonlySet<string>,
): EnrichmentValidation => {
    const parsed = InferenceEnrichmentEnvelope.safeParse(value);
    if (!parsed.success)
        return { ok: false, errors: validationErrors(parsed.error) };

    const invalidEvidence = parsed.data.inferredEdges.flatMap((edge, index) =>
        edge.evidenceIds
            .filter(evidenceId => !allowedEvidenceIds.has(evidenceId))
            .map(
                evidenceId =>
                    `inferredEdges.${index}.evidenceIds: ${evidenceId} was not selected evidence.`,
            ),
    );
    if (invalidEvidence.length > 0)
        return { ok: false, errors: invalidEvidence };
    return { ok: true, value: parsed.data };
};

/**
 * Validates provider output and performs exactly one repair attempt. Invalid
 * partial edges never escape this function; callers persist only `ok` values.
 */
export const normalizeEnrichmentWithOneRepair = async (
    runner: InferenceStructuredOutputRunner,
    request: InferenceEnrichmentRequest,
): Promise<InferenceNormalizationResult> => {
    const allowedEvidenceIds = new Set(
        request.evidence.map(evidence => evidence.id),
    );
    let output: unknown;
    try {
        output = await runner.run({ request });
    } catch (reason) {
        return {
            ok: false,
            failure: {
                code: 'providerFailure',
                message:
                    reason instanceof Error ? reason.message : String(reason),
                repairAttempted: false,
            },
        };
    }
    const initial = validateEnrichment(output, allowedEvidenceIds);
    if (initial.ok)
        return { ok: true, value: initial.value, repairAttempted: false };
    try {
        output = await runner.run({
            request,
            repair: {
                invalidOutput: output,
                validationErrors: initial.errors,
            },
        });
    } catch (reason) {
        return {
            ok: false,
            failure: {
                code: 'providerFailure',
                message:
                    reason instanceof Error ? reason.message : String(reason),
                repairAttempted: true,
            },
        };
    }
    const repaired = validateEnrichment(output, allowedEvidenceIds);
    if (repaired.ok)
        return { ok: true, value: repaired.value, repairAttempted: true };
    return {
        ok: false,
        failure: {
            code: 'invalidStructuredOutput',
            message: repaired.errors.join('; '),
            repairAttempted: true,
        },
    };
};
