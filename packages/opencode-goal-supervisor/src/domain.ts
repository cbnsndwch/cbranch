import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

export const goalStates = [
    'draft',
    'ready',
    'executing',
    'paused',
    'needs-replan',
    'awaiting-decision',
    'blocked',
    'unknown-outcome',
    'achieved',
    'cancelled',
] as const;

export const GoalStateSchema = z.enum(goalStates);
export type GoalState = z.infer<typeof GoalStateSchema>;

export const workUnitStates = [
    'queued',
    'running',
    'verifying',
    'accepted',
    'failed',
    'cancelled',
    'unknown-outcome',
] as const;

export const WorkUnitStateSchema = z.enum(workUnitStates);
export type WorkUnitState = z.infer<typeof WorkUnitStateSchema>;

export const attemptStates = [
    'leased',
    'dispatched',
    'running',
    'verifying',
    'succeeded',
    'failed',
    'expired',
    'cancelled',
    'unknown-outcome',
] as const;

export const AttemptStateSchema = z.enum(attemptStates);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

export type JsonPrimitive = string | number | boolean | null;
export type DeepReadonly<T> = T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
export type JsonValue =
    | JsonPrimitive
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number().finite(),
        z.boolean(),
        z.null(),
        z.array(JsonValueSchema),
        z.record(z.string(), JsonValueSchema),
    ]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
    z.string(),
    JsonValueSchema,
);

export const DomainIdSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
        'IDs must be compact and may not contain whitespace.',
    );

export const LeaseTokenSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._~:+/=-]*$/,
        'Lease tokens must be compact and may not contain whitespace.',
    );

export const Sha256DigestSchema = z
    .string()
    .regex(
        /^sha256:[a-f0-9]{64}$/,
        "Expected a lowercase SHA-256 digest prefixed with 'sha256:'.",
    );
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

export const CompactReferenceSchema = z
    .string()
    .min(1)
    .max(512)
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._~:/@+#?=&%-]*$/,
        'References must be compact and may not contain whitespace.',
    );
export type CompactReference = z.infer<typeof CompactReferenceSchema>;

const IsoDateTimeSchema = z.iso.datetime({ offset: true });
const NonEmptyTextSchema = z.string().trim().min(1);
const isSingleLinePrintable = (value: string): boolean =>
    Array.from(value).every(character => {
        const code = character.codePointAt(0)!;
        return (
            code >= 0x20 &&
            (code < 0x7f || code > 0x9f) &&
            code !== 0x2028 &&
            code !== 0x2029
        );
    });
const hasNoNulOrNewline = (value: string): boolean =>
    Array.from(value).every(character => {
        const code = character.charCodeAt(0);
        return code !== 0 && code !== 10 && code !== 13;
    });
const ConciseSummarySchema = z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(isSingleLinePrintable, 'A summary must be a single line.');
const SafeArgumentSchema = z
    .string()
    .max(2_048)
    .refine(hasNoNulOrNewline, 'Arguments may not contain NUL or newlines.');

export const GoalSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        workspace: z.string().trim().min(1).max(4_096),
        objective: NonEmptyTextSchema.max(20_000),
        state: GoalStateSchema,
        version: z.number().int().nonnegative(),
        activePlanId: DomainIdSchema.optional(),
        activePlanRevision: z.number().int().positive().optional(),
        createdAt: IsoDateTimeSchema,
        updatedAt: IsoDateTimeSchema,
    })
    .strict();

/** Storage-facing form remains compatible with records written before tagging. */
export type Goal = {
    readonly schemaVersion?: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly workspace: string;
    readonly objective: string;
    readonly state: GoalState;
    readonly version: number;
    readonly activePlanId?: string;
    readonly activePlanRevision?: number;
    readonly createdAt: string;
    readonly updatedAt: string;
};
export type ParsedGoal = DeepReadonly<z.output<typeof GoalSchema>>;

export const DocumentRevisionSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        documentId: DomainIdSchema,
        documentType: z.enum(['plan', 'plan-proposal', 'decision', 'other']),
        revision: z.number().int().positive(),
        parentRevisionId: DomainIdSchema.optional(),
        contentDigest: Sha256DigestSchema,
        content: JsonValueSchema,
        authoredBy: DomainIdSchema,
        createdAt: IsoDateTimeSchema,
    })
    .strict();
export type DocumentRevision = DeepReadonly<
    z.infer<typeof DocumentRevisionSchema>
>;

export const VerificationRequirementSchema = z
    .object({
        id: DomainIdSchema,
        type: z.literal('command'),
        executable: z
            .string()
            .min(1)
            .max(256)
            .regex(
                /^(?:[A-Za-z0-9./])[A-Za-z0-9._/+:-]*$/,
                'Executable must be a program path or name, not a shell command.',
            ),
        args: z.array(SafeArgumentSchema).max(128),
        timeoutMs: z
            .number()
            .int()
            .positive()
            .max(30 * 60_000),
        outputCapBytes: z
            .number()
            .int()
            .positive()
            .max(8 * 1_024 * 1_024),
        expectedExitCode: z.number().int().min(0).max(255).default(0),
        required: z.boolean().default(true),
    })
    .strict();
export type VerificationRequirement = DeepReadonly<
    z.infer<typeof VerificationRequirementSchema>
>;

export const PlanUnitSchema = z
    .object({
        id: DomainIdSchema,
        title: NonEmptyTextSchema.max(200),
        instructions: NonEmptyTextSchema.max(20_000),
        dependencyIds: z.array(DomainIdSchema).max(256),
        acceptanceCriteria: z
            .array(NonEmptyTextSchema.max(2_000))
            .min(1)
            .max(256),
        verificationRequirements: z
            .array(VerificationRequirementSchema)
            .max(128),
        required: z.boolean().default(true),
        destructive: z.boolean().default(false),
    })
    .strict();
export type PlanUnit = DeepReadonly<z.infer<typeof PlanUnitSchema>>;

export const PlanSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        revision: z.number().int().positive(),
        parentPlanId: DomainIdSchema.optional(),
        contentDigest: Sha256DigestSchema,
        objective: NonEmptyTextSchema.max(20_000),
        units: z.array(PlanUnitSchema).min(1).max(1_024),
        finalVerificationRequirements: z
            .array(VerificationRequirementSchema)
            .max(128),
        authoredBy: DomainIdSchema,
        createdAt: IsoDateTimeSchema,
    })
    .strict();
export type Plan = DeepReadonly<z.infer<typeof PlanSchema>>;
export type PlanDocument = Plan;

export const PlanProposalSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        revision: z.number().int().positive(),
        supersedesProposalId: DomainIdSchema.optional(),
        plan: PlanSchema,
        summary: ConciseSummarySchema,
        proposedBy: DomainIdSchema,
        createdAt: IsoDateTimeSchema,
    })
    .strict()
    .superRefine((proposal, context) => {
        if (proposal.plan.goalId !== proposal.goalId) {
            context.addIssue({
                code: 'custom',
                path: ['plan', 'goalId'],
                message:
                    "The proposed plan must belong to the proposal's goal.",
            });
        }
    });
export type PlanProposal = DeepReadonly<z.infer<typeof PlanProposalSchema>>;

export const DependencySchema = z
    .object({
        unitId: DomainIdSchema,
        dependsOnUnitId: DomainIdSchema,
    })
    .strict()
    .refine(dependency => dependency.unitId !== dependency.dependsOnUnitId, {
        message: 'A work unit cannot depend on itself.',
        path: ['dependsOnUnitId'],
    });
export type Dependency = Readonly<z.infer<typeof DependencySchema>>;

export const WorkUnitSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        planUnitId: DomainIdSchema.optional(),
        kind: z.string().trim().min(1).max(128),
        input: JsonObjectSchema,
        state: WorkUnitStateSchema,
        dependencyIds: z.array(DomainIdSchema).max(256).default([]),
        required: z.boolean().default(true),
        activeAttemptId: DomainIdSchema.optional(),
        nextAttemptNumber: z.number().int().positive(),
        createdAt: IsoDateTimeSchema.optional(),
        updatedAt: IsoDateTimeSchema.optional(),
    })
    .strict();
export type ParsedWorkUnit = Readonly<z.output<typeof WorkUnitSchema>>;

/** Persistence-facing form accepted by the current store adapter. */
export type WorkUnit = {
    readonly schemaVersion?: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly goalId: string;
    readonly planUnitId?: string;
    readonly kind: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly state: WorkUnitState;
    readonly dependencyIds?: readonly string[];
    readonly required?: boolean;
    readonly activeAttemptId?: string;
    readonly nextAttemptNumber: number;
    readonly createdAt?: string;
    readonly updatedAt?: string;
};

export const WorkLeaseSchema = z
    .object({
        token: LeaseTokenSchema,
        owner: DomainIdSchema,
        acquiredAt: IsoDateTimeSchema,
        expiresAt: IsoDateTimeSchema,
    })
    .strict()
    .refine(
        lease => Date.parse(lease.expiresAt) > Date.parse(lease.acquiredAt),
        {
            message: 'A lease must expire after it is acquired.',
            path: ['expiresAt'],
        },
    );
export type WorkLease = Readonly<z.infer<typeof WorkLeaseSchema>>;

export const WorkAttemptSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        workUnitId: DomainIdSchema,
        number: z.number().int().positive(),
        state: AttemptStateSchema.default('leased'),
        leaseToken: LeaseTokenSchema,
        leaseOwner: DomainIdSchema,
        leaseAcquiredAt: IsoDateTimeSchema.optional(),
        leaseExpiresAt: IsoDateTimeSchema,
        createdAt: IsoDateTimeSchema.optional(),
        startedAt: IsoDateTimeSchema.optional(),
        completedAt: IsoDateTimeSchema.optional(),
    })
    .strict();
export type WorkAttempt = {
    readonly schemaVersion?: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly workUnitId: string;
    readonly number: number;
    readonly state?: AttemptState;
    readonly leaseToken: string;
    readonly leaseOwner: string;
    readonly leaseAcquiredAt?: string;
    readonly leaseExpiresAt: string;
    readonly createdAt?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
};
export type ParsedWorkAttempt = Readonly<z.output<typeof WorkAttemptSchema>>;

export const EvidenceReferenceSchema = z
    .object({
        ref: CompactReferenceSchema,
        digest: Sha256DigestSchema,
    })
    .strict();
export type EvidenceReference = Readonly<
    z.infer<typeof EvidenceReferenceSchema>
>;

export const EvidenceSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        workUnitId: DomainIdSchema.optional(),
        attemptId: DomainIdSchema.optional(),
        kind: z.enum([
            'artifact',
            'transcript',
            'log',
            'verification',
            'observation',
            'other',
        ]),
        ref: CompactReferenceSchema,
        digest: Sha256DigestSchema,
        mediaType: z.string().trim().min(1).max(128),
        sizeBytes: z.number().int().nonnegative(),
        summary: ConciseSummarySchema.optional(),
        createdAt: IsoDateTimeSchema,
    })
    .strict();
export type Evidence = Readonly<z.infer<typeof EvidenceSchema>>;

export const VerificationMetricSchema = z
    .object({
        value: z.number().finite(),
        unit: z.string().trim().min(1).max(64).optional(),
    })
    .strict();

export const VerificationImprovementSchema = z
    .object({
        absolute: z.number().finite(),
        percent: z.number().finite().optional(),
    })
    .strict();

export const VerificationResultSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        workUnitId: DomainIdSchema.optional(),
        attemptId: DomainIdSchema,
        requirementId: DomainIdSchema,
        status: z.enum(['passed', 'failed', 'inconclusive', 'error']),
        summary: ConciseSummarySchema,
        exitCode: z.number().int().min(0).max(255).optional(),
        baseline: VerificationMetricSchema.optional(),
        observed: VerificationMetricSchema.optional(),
        improvement: VerificationImprovementSchema.optional(),
        evidenceRefs: z.array(EvidenceReferenceSchema).max(64),
        startedAt: IsoDateTimeSchema,
        completedAt: IsoDateTimeSchema,
    })
    .strict()
    .superRefine((result, context) => {
        if (result.improvement && (!result.baseline || !result.observed)) {
            context.addIssue({
                code: 'custom',
                path: ['improvement'],
                message:
                    'Improvement requires both baseline and observed values.',
            });
        }
        if (
            result.baseline?.unit !== undefined &&
            result.observed?.unit !== undefined &&
            result.baseline.unit !== result.observed.unit
        ) {
            context.addIssue({
                code: 'custom',
                path: ['observed', 'unit'],
                message: 'Baseline and observed values must use the same unit.',
            });
        }
    });
export type VerificationResult = Readonly<
    z.infer<typeof VerificationResultSchema>
>;

export const ApprovalScopeSchema = z.discriminatedUnion('type', [
    z
        .object({
            type: z.literal('plan'),
            planId: DomainIdSchema,
            revision: z.number().int().positive(),
        })
        .strict(),
    z
        .object({
            type: z.literal('goal-action'),
            action: z.enum([
                'unattended-start',
                'resume',
                'blocked-resume',
                'recover-unknown-outcome',
                'raise-budget',
            ]),
        })
        .strict(),
    z
        .object({
            type: z.literal('work-unit'),
            workUnitId: DomainIdSchema,
        })
        .strict(),
    z
        .object({
            type: z.literal('permission'),
            sessionId: DomainIdSchema,
            permissionId: DomainIdSchema,
            permissionType: z.string().trim().min(1).max(128),
        })
        .strict(),
]);
export type ApprovalScope = Readonly<z.infer<typeof ApprovalScopeSchema>>;

export const ApprovalTokenSchema = z
    .string()
    .min(32)
    .max(512)
    .regex(/^[A-Za-z0-9._~+-]+$/, 'Approval tokens must be URL-safe.');
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

export const GoalBudgetSchema = z
    .object({
        maxAttempts: z.number().int().positive().max(10_000),
        maxWallClockMs: z
            .number()
            .int()
            .positive()
            .max(365 * 24 * 60 * 60_000),
        maxVerificationMs: z
            .number()
            .int()
            .positive()
            .max(365 * 24 * 60 * 60_000),
        maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict();
export type GoalBudget = Readonly<z.infer<typeof GoalBudgetSchema>>;

export const GoalBudgetUsageSchema = z
    .object({
        attempts: z.number().int().nonnegative(),
        wallClockMs: z.number().int().nonnegative(),
        verificationMs: z.number().int().nonnegative(),
        tokens: z.number().int().nonnegative(),
    })
    .strict();
export type GoalBudgetUsage = Readonly<z.infer<typeof GoalBudgetUsageSchema>>;

export const ApprovalSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        scope: ApprovalScopeSchema,
        decision: z.enum(['approved', 'rejected']),
        decidedBy: DomainIdSchema,
        reason: ConciseSummarySchema,
        tokenHash: Sha256DigestSchema,
        createdAt: IsoDateTimeSchema,
        expiresAt: IsoDateTimeSchema.optional(),
        consumedAt: IsoDateTimeSchema.optional(),
    })
    .strict();
export type Approval = Readonly<z.infer<typeof ApprovalSchema>>;

export const issueClasses = [
    'credentials',
    'permission',
    'dependency',
    'budget',
    'contradictory-criteria',
    'external-ambiguity',
    'verification',
    'other',
] as const;

export const IssueClassificationSchema = z.enum(issueClasses);
export type IssueClassification = z.infer<typeof IssueClassificationSchema>;

export const ObservationSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        goalId: DomainIdSchema,
        source: z.enum([
            'agent',
            'verifier',
            'supervisor',
            'operator',
            'system',
        ]),
        kind: z.enum([
            'status',
            'progress',
            'evidence',
            'failure',
            'decision',
            'external',
        ]),
        observedAt: IsoDateTimeSchema,
        summary: ConciseSummarySchema,
        workUnitId: DomainIdSchema.optional(),
        attemptId: DomainIdSchema.optional(),
        issueClassification: IssueClassificationSchema.optional(),
        deduplicationKey: CompactReferenceSchema.optional(),
        data: JsonObjectSchema,
    })
    .strict();
export type Observation = Readonly<z.infer<typeof ObservationSchema>>;

export const agentOutcomeStatuses = [
    'completed',
    'failed',
    'blocked',
    'needs-replan',
    'unknown-outcome',
] as const;

export const AgentOutcomeStatusSchema = z.enum(agentOutcomeStatuses);

export const AgentOutcomeSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        attemptId: DomainIdSchema,
        leaseToken: LeaseTokenSchema,
        status: AgentOutcomeStatusSchema,
        summary: ConciseSummarySchema,
        evidenceRefs: z.array(EvidenceReferenceSchema).max(64),
        verificationRefs: z.array(CompactReferenceSchema).max(64),
        transcriptRef: CompactReferenceSchema.optional(),
        artifactRefs: z.array(CompactReferenceSchema).max(64).optional(),
        failureFingerprint: CompactReferenceSchema.optional(),
        materialChangeDigest: Sha256DigestSchema.optional(),
        issueClassification: IssueClassificationSchema.optional(),
    })
    .strict()
    .superRefine((outcome, context) => {
        if (
            outcome.status === 'completed' &&
            outcome.evidenceRefs.length === 0
        ) {
            context.addIssue({
                code: 'custom',
                path: ['evidenceRefs'],
                message:
                    'A completed outcome requires at least one evidence reference.',
            });
        }
    });
export type AgentOutcome = Readonly<z.infer<typeof AgentOutcomeSchema>>;

/** Applies issue-precedence policy before verification or successful settlement. */
export const normalizeAgentOutcomeForPolicy = (
    outcome: AgentOutcome,
): AgentOutcome => {
    if (outcome.status !== 'completed') return outcome;
    const status =
        outcome.issueClassification === 'external-ambiguity'
            ? 'unknown-outcome'
            : outcome.issueClassification === 'credentials' ||
                outcome.issueClassification === 'permission' ||
                outcome.issueClassification === 'dependency' ||
                outcome.issueClassification === 'budget' ||
                outcome.issueClassification === 'contradictory-criteria'
              ? 'failed'
              : 'completed';
    return status === outcome.status
        ? outcome
        : AgentOutcomeSchema.parse({ ...outcome, status });
};

export const OutboxCommandSchema = z
    .object({
        schemaVersion: SchemaVersionSchema,
        id: DomainIdSchema,
        type: z.literal('dispatch-attempt'),
        goalId: DomainIdSchema,
        workUnitId: DomainIdSchema,
        attemptId: DomainIdSchema,
        leaseToken: LeaseTokenSchema,
        idempotencyKey: CompactReferenceSchema,
        payload: JsonObjectSchema,
        createdAt: IsoDateTimeSchema,
    })
    .strict();
export type OutboxCommand = Readonly<z.infer<typeof OutboxCommandSchema>>;

export const OutboxMessageSchema = z
    .object({
        schemaVersion: SchemaVersionSchema.default(SCHEMA_VERSION),
        id: DomainIdSchema,
        attemptId: DomainIdSchema,
        idempotencyKey: CompactReferenceSchema,
        payload: JsonObjectSchema,
        leaseToken: LeaseTokenSchema.optional(),
    })
    .strict();

/** Storage record shape; the outbox command inside payload is separately parsed. */
export type OutboxMessage = {
    readonly schemaVersion?: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly attemptId: string;
    readonly idempotencyKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly leaseToken?: string;
};

const commandEnvelope = {
    schemaVersion: SchemaVersionSchema,
    commandId: DomainIdSchema,
    issuedAt: IsoDateTimeSchema,
    actorId: DomainIdSchema,
};

export const SupervisorCommandSchema = z.discriminatedUnion('type', [
    z
        .object({
            ...commandEnvelope,
            type: z.literal('create'),
            workspace: z.string().trim().min(1).max(4_096),
            objective: NonEmptyTextSchema.max(20_000),
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('propose-plan'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            proposal: PlanProposalSchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('approve-plan'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            proposalId: DomainIdSchema,
            approval: ApprovalSchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('start'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            approvalToken: ApprovalTokenSchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('pause'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            reason: ConciseSummarySchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('resume'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            approvalId: DomainIdSchema,
            approvalToken: ApprovalTokenSchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('cancel'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            reason: ConciseSummarySchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('approve'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            approval: ApprovalSchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('report-outcome'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            outcome: AgentOutcomeSchema,
        })
        .strict(),
    z
        .object({
            ...commandEnvelope,
            type: z.literal('recover'),
            goalId: DomainIdSchema,
            expectedGoalVersion: z.number().int().nonnegative(),
            targetState: z.enum([
                'ready',
                'executing',
                'paused',
                'needs-replan',
                'awaiting-decision',
                'blocked',
                'cancelled',
            ]),
            decisionApprovalId: DomainIdSchema,
            reason: ConciseSummarySchema,
        })
        .strict(),
]);
export type SupervisorCommand = Readonly<
    z.infer<typeof SupervisorCommandSchema>
>;

const domainEventFields = {
    schemaVersion: SchemaVersionSchema,
    id: DomainIdSchema,
    goalId: DomainIdSchema,
    type: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z][a-z0-9.-]*$/),
    payload: JsonObjectSchema,
    createdAt: IsoDateTimeSchema,
    commandId: DomainIdSchema.optional(),
    causationId: DomainIdSchema.optional(),
    correlationId: DomainIdSchema.optional(),
};

/** Event identity and causation replace any assumption of global sequencing. */
export const DomainEventSchema = z.object(domainEventFields).strict();
export type DomainEvent = Readonly<z.infer<typeof DomainEventSchema>>;

export const GoalEventSchema = z
    .object({
        ...domainEventFields,
        schemaVersion: SchemaVersionSchema.default(SCHEMA_VERSION),
    })
    .strict();

/** Storage-facing event form accepted from the current append-only adapter. */
export type GoalEvent = {
    readonly schemaVersion?: typeof SCHEMA_VERSION;
    readonly id: string;
    readonly goalId: string;
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly commandId?: string;
    readonly causationId?: string;
    readonly correlationId?: string;
};

export const goalActions = [
    'plan-ready',
    'start',
    'pause',
    'resume',
    'cancel',
    'replan',
    'decision',
    'block',
    'unknown-outcome',
    'achieve',
    'fail',
    'recover',
] as const;

export const GoalActionSchema = z.enum(goalActions);
export type GoalAction = z.infer<typeof GoalActionSchema>;

export const resumableGoalStates = ['ready', 'executing'] as const;
export type ResumableGoalState = (typeof resumableGoalStates)[number];

export const recoveryGoalStates = [
    'ready',
    'executing',
    'paused',
    'needs-replan',
    'awaiting-decision',
    'blocked',
    'cancelled',
] as const;
export type RecoveryGoalState = (typeof recoveryGoalStates)[number];

export type GoalTransitionContext = {
    readonly hasApprovedPlan?: boolean;
    readonly hasApprovedRevisedPlan?: boolean;
    readonly hasUnattendedStartApproval?: boolean;
    readonly hasResumeApproval?: boolean;
    readonly hasBlockedResumeApproval?: boolean;
    readonly hasDecisionApproval?: boolean;
    readonly hasExplicitDecision?: boolean;
    readonly allRequiredUnitsAccepted?: boolean;
    readonly hasSuccessfulFinalVerification?: boolean;
    readonly resumeTarget?: ResumableGoalState;
    readonly recoveryTarget?: RecoveryGoalState;
};

export type GoalTransitionDecision =
    | { readonly ok: true; readonly state: GoalState }
    | { readonly ok: false; readonly reason: string };

const accepted = (state: GoalState): GoalTransitionDecision => ({
    ok: true,
    state,
});

const rejected = (reason: string): GoalTransitionDecision => ({
    ok: false,
    reason,
});

const resumeTarget = (context: GoalTransitionContext): ResumableGoalState =>
    context.resumeTarget ?? 'executing';

export const decideGoalTransition = (
    state: GoalState,
    action: GoalAction,
    context: GoalTransitionContext = {},
): GoalTransitionDecision => {
    if (state === 'achieved' || state === 'cancelled') {
        return rejected(`Terminal goal state '${state}' is fenced.`);
    }

    if (state === 'unknown-outcome') {
        if (action !== 'recover') {
            return rejected(
                'An unknown outcome is recoverable only through an explicit decision.',
            );
        }
        if (!context.hasExplicitDecision) {
            return rejected('Recovery requires an explicit decision approval.');
        }
        if (!context.recoveryTarget) {
            return rejected('Recovery requires an explicit target state.');
        }
        return accepted(context.recoveryTarget);
    }

    if (action === 'recover') {
        return rejected('Recover is only legal from unknown-outcome.');
    }

    if (state === 'draft') {
        if (action === 'plan-ready') {
            return context.hasApprovedPlan
                ? accepted('ready')
                : rejected('A ready goal requires an approved plan.');
        }
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'replan') return accepted('needs-replan');
        if (action === 'decision') return accepted('awaiting-decision');
        if (action === 'block') return accepted('blocked');
        return rejected(`Action '${action}' is not legal from draft.`);
    }

    if (state === 'ready') {
        if (action === 'start') {
            if (!context.hasApprovedPlan) {
                return rejected('Starting requires an approved plan.');
            }
            if (!context.hasUnattendedStartApproval) {
                return rejected('Starting requires unattended-start approval.');
            }
            return accepted('executing');
        }
        if (action === 'pause') return accepted('paused');
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'replan') return accepted('needs-replan');
        if (action === 'decision') return accepted('awaiting-decision');
        if (action === 'block' || action === 'fail') {
            return accepted('blocked');
        }
        if (action === 'unknown-outcome') return accepted('unknown-outcome');
        return rejected(`Action '${action}' is not legal from ready.`);
    }

    if (state === 'executing') {
        if (action === 'pause') return accepted('paused');
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'replan') return accepted('needs-replan');
        if (action === 'decision') return accepted('awaiting-decision');
        if (action === 'block' || action === 'fail') {
            return accepted('blocked');
        }
        if (action === 'unknown-outcome') return accepted('unknown-outcome');
        if (action === 'achieve') {
            if (!context.allRequiredUnitsAccepted) {
                return rejected(
                    'Achievement requires all required units to be accepted.',
                );
            }
            if (!context.hasSuccessfulFinalVerification) {
                return rejected(
                    'Achievement requires successful final verification.',
                );
            }
            return accepted('achieved');
        }
        return rejected(`Action '${action}' is not legal from executing.`);
    }

    if (state === 'paused') {
        if (action === 'resume') {
            return context.hasResumeApproval
                ? accepted(resumeTarget(context))
                : rejected('Resuming a paused goal requires approval.');
        }
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'replan') return accepted('needs-replan');
        if (action === 'decision') return accepted('awaiting-decision');
        if (action === 'block' || action === 'fail') {
            return accepted('blocked');
        }
        if (action === 'unknown-outcome') return accepted('unknown-outcome');
        return rejected(`Action '${action}' is not legal from paused.`);
    }

    if (state === 'needs-replan') {
        if (action === 'plan-ready') {
            return context.hasApprovedRevisedPlan
                ? accepted('ready')
                : rejected(
                      'Returning to ready requires an approved revised plan.',
                  );
        }
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'decision') return accepted('awaiting-decision');
        if (action === 'block' || action === 'fail') {
            return accepted('blocked');
        }
        if (action === 'unknown-outcome') return accepted('unknown-outcome');
        return rejected(`Action '${action}' is not legal from needs-replan.`);
    }

    if (state === 'awaiting-decision') {
        if (action === 'resume') {
            return context.hasDecisionApproval
                ? accepted(resumeTarget(context))
                : rejected('Resuming requires an approved decision.');
        }
        if (action === 'pause') return accepted('paused');
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'replan') return accepted('needs-replan');
        if (action === 'block' || action === 'fail') {
            return accepted('blocked');
        }
        if (action === 'unknown-outcome') return accepted('unknown-outcome');
        return rejected(
            `Action '${action}' is not legal from awaiting-decision.`,
        );
    }

    if (state === 'blocked') {
        if (action === 'resume') {
            return context.hasBlockedResumeApproval
                ? accepted(resumeTarget(context))
                : rejected('Resuming a blocked goal requires approval.');
        }
        if (action === 'cancel') return accepted('cancelled');
        if (action === 'replan') return accepted('needs-replan');
        if (action === 'decision') return accepted('awaiting-decision');
        if (action === 'unknown-outcome') return accepted('unknown-outcome');
        return rejected(`Action '${action}' is not legal from blocked.`);
    }

    return rejected(`Unknown goal state '${String(state)}'.`);
};

export const terminalGoalStates: ReadonlySet<GoalState> = new Set([
    'achieved',
    'cancelled',
]);

const permissiveTransitionContext: GoalTransitionContext = {
    hasApprovedPlan: true,
    hasApprovedRevisedPlan: true,
    hasUnattendedStartApproval: true,
    hasResumeApproval: true,
    hasBlockedResumeApproval: true,
    hasDecisionApproval: true,
    hasExplicitDecision: true,
    allRequiredUnitsAccepted: true,
    hasSuccessfulFinalVerification: true,
};

/** State-only compatibility check; policy guards remain in decideGoalTransition. */
export const canTransition = (from: GoalState, to: GoalState): boolean => {
    const resumeTargets: readonly ResumableGoalState[] = ['ready', 'executing'];
    const recoveryTargets: readonly RecoveryGoalState[] = recoveryGoalStates;

    for (const action of goalActions) {
        for (const target of resumeTargets) {
            const decision = decideGoalTransition(from, action, {
                ...permissiveTransitionContext,
                resumeTarget: target,
                recoveryTarget: recoveryTargets.includes(
                    to as RecoveryGoalState,
                )
                    ? (to as RecoveryGoalState)
                    : undefined,
            });
            if (decision.ok && decision.state === to) return true;
        }
    }
    return false;
};

export const planValidationIssueCodes = [
    'duplicate-unit-id',
    'unknown-dependency',
    'self-dependency',
    'dependency-cycle',
    'empty-acceptance-criteria',
    'duplicate-verification-id',
    'contradictory-criteria',
] as const;
export type PlanValidationIssueCode = (typeof planValidationIssueCodes)[number];

export type PlanValidationIssue = {
    readonly code: PlanValidationIssueCode;
    readonly message: string;
    readonly unitId?: string;
    readonly dependencyId?: string;
    readonly verificationId?: string;
};

export type PlanGraphDocument = {
    readonly units: readonly {
        readonly id: string;
        readonly dependencyIds?: readonly string[];
        readonly acceptanceCriteria?: readonly string[];
        readonly verificationRequirements?: readonly { readonly id: string }[];
    }[];
    readonly finalVerificationRequirements?: readonly {
        readonly id: string;
    }[];
};

const criterionSubject = (
    criterion: string,
): { readonly kind: 'must' | 'must-not'; readonly subject: string } | null => {
    const normalized = criterion.trim().toLowerCase().replace(/\s+/g, ' ');
    const mustNot = /^must not (.+)$/.exec(normalized);
    if (mustNot?.[1]) return { kind: 'must-not', subject: mustNot[1] };
    const must = /^must (.+)$/.exec(normalized);
    return must?.[1] ? { kind: 'must', subject: must[1] } : null;
};

export const validateAcyclicPlan = (
    plan: PlanGraphDocument,
): readonly PlanValidationIssue[] => {
    const issues: PlanValidationIssue[] = [];
    const unitById = new Map<string, PlanGraphDocument['units'][number]>();

    for (const unit of plan.units) {
        if (unitById.has(unit.id)) {
            issues.push({
                code: 'duplicate-unit-id',
                unitId: unit.id,
                message: `Plan unit ID '${unit.id}' is duplicated.`,
            });
        } else {
            unitById.set(unit.id, unit);
        }

        if (
            !unit.acceptanceCriteria?.length ||
            unit.acceptanceCriteria.some(
                criterion => criterion.trim().length === 0,
            )
        ) {
            issues.push({
                code: 'empty-acceptance-criteria',
                unitId: unit.id,
                message: `Plan unit '${unit.id}' must have nonempty acceptance criteria.`,
            });
        }

        const required = new Set<string>();
        const forbidden = new Set<string>();
        for (const criterion of unit.acceptanceCriteria ?? []) {
            const parsed = criterionSubject(criterion);
            if (!parsed) continue;
            (parsed.kind === 'must' ? required : forbidden).add(parsed.subject);
        }
        for (const subject of required) {
            if (forbidden.has(subject)) {
                issues.push({
                    code: 'contradictory-criteria',
                    unitId: unit.id,
                    message: `Plan unit '${unit.id}' both requires and forbids '${subject}'.`,
                });
            }
        }
    }

    for (const unit of plan.units) {
        for (const dependencyId of unit.dependencyIds ?? []) {
            if (dependencyId === unit.id) {
                issues.push({
                    code: 'self-dependency',
                    unitId: unit.id,
                    dependencyId,
                    message: `Plan unit '${unit.id}' depends on itself.`,
                });
            } else if (!unitById.has(dependencyId)) {
                issues.push({
                    code: 'unknown-dependency',
                    unitId: unit.id,
                    dependencyId,
                    message: `Plan unit '${unit.id}' depends on unknown unit '${dependencyId}'.`,
                });
            }
        }
    }

    const verificationIds = new Set<string>();
    const checkVerificationId = (id: string, unitId?: string): void => {
        if (verificationIds.has(id)) {
            issues.push({
                code: 'duplicate-verification-id',
                unitId,
                verificationId: id,
                message: `Verification requirement ID '${id}' is duplicated.`,
            });
        } else {
            verificationIds.add(id);
        }
    };
    for (const unit of plan.units) {
        for (const requirement of unit.verificationRequirements ?? []) {
            checkVerificationId(requirement.id, unit.id);
        }
    }
    for (const requirement of plan.finalVerificationRequirements ?? []) {
        checkVerificationId(requirement.id);
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const stack: string[] = [];
    const reportedCycles = new Set<string>();

    const visit = (unitId: string): void => {
        if (visited.has(unitId)) return;
        visiting.add(unitId);
        stack.push(unitId);

        const unit = unitById.get(unitId);
        for (const dependencyId of unit?.dependencyIds ?? []) {
            if (dependencyId === unitId || !unitById.has(dependencyId))
                continue;
            if (visiting.has(dependencyId)) {
                const cycleStart = stack.indexOf(dependencyId);
                const cycle = [...stack.slice(cycleStart), dependencyId];
                const cycleKey = [...new Set(cycle)].toSorted().join('\u0000');
                if (!reportedCycles.has(cycleKey)) {
                    reportedCycles.add(cycleKey);
                    issues.push({
                        code: 'dependency-cycle',
                        unitId,
                        dependencyId,
                        message: `Plan dependencies contain a cycle: ${cycle.join(' -> ')}.`,
                    });
                }
            } else {
                visit(dependencyId);
            }
        }

        stack.pop();
        visiting.delete(unitId);
        visited.add(unitId);
    };

    for (const unitId of unitById.keys()) visit(unitId);
    return issues;
};
