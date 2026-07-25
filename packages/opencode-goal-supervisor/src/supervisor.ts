import { createHash } from 'node:crypto';

import {
    AgentOutcomeSchema,
    CompactReferenceSchema,
    OutboxCommandSchema,
    normalizeAgentOutcomeForPolicy,
    type AgentOutcome,
    type IssueClassification,
    type JsonObject,
    type OutboxCommand,
    type VerificationRequirement,
    type WorkAttempt,
} from './domain.js';
import {
    type ClaimedOutboxMessage,
    type DurableVerificationBaseline,
    type GoalStore,
    type SessionReference,
} from './store.js';
import {
    runVerification,
    type VerificationInput,
    type VerificationResult as ProcessVerificationResult,
    type VerificationStatus,
} from './verification.js';

export type SessionProbeStatus = 'absent' | 'active' | 'completed' | 'unknown';

export interface SessionDispatchInput {
    readonly idempotencyKey: string;
    readonly command: OutboxCommand;
    readonly workspace: string;
    readonly signal?: AbortSignal;
}

export interface SessionDispatchResult {
    readonly externalRef: string;
}

export interface SessionProbeInput {
    readonly idempotencyKey: string;
    readonly command: OutboxCommand;
    readonly workspace: string;
    readonly signal?: AbortSignal;
}

export type SessionProbeResult =
    | {
          readonly status: 'absent' | 'unknown';
          readonly externalRef?: string;
      }
    | {
          readonly status: 'active' | 'completed';
          readonly externalRef: string;
      };

export interface SessionOutcomeInput {
    readonly externalRef: string;
    readonly attemptId: string;
    readonly leaseToken: string;
    readonly workspace: string;
    readonly signal?: AbortSignal;
}

export type SessionOutcomeRead =
    | { readonly status: 'active' }
    | { readonly status: 'unknown'; readonly reason?: string }
    | { readonly status: 'terminal-unknown'; readonly reason: string }
    | {
          readonly status: 'completed';
          readonly outcome: AgentOutcome;
          readonly transcriptRef?: string;
      };

export interface SessionAbortInput {
    readonly externalRef: string;
    readonly reason: string;
    readonly workspace: string;
    readonly signal?: AbortSignal;
}

export interface SessionAbortResult {
    readonly aborted: boolean;
}

export interface SessionHealthResult {
    readonly healthy: boolean;
    readonly detail?: string;
}

export interface SessionObservation {
    readonly externalRef: string;
    readonly observedAt?: string;
    readonly kind:
        | 'status'
        | 'progress'
        | 'evidence'
        | 'failure'
        | 'decision'
        | 'external';
    readonly summary: string;
    readonly deduplicationKey: string;
    readonly issueClassification?: IssueClassification;
    readonly data: JsonObject;
}

export interface SessionObserveInput {
    readonly externalRefs: () => readonly string[];
    readonly signal: AbortSignal;
    readonly maxRetryAttempts?: number;
    readonly maxRetryDelayMs?: number;
}

/** Boundary between durable supervision and an external agent session system. */
export interface GoalSessionAdapter {
    readonly dispatch: (
        input: SessionDispatchInput,
    ) => Promise<SessionDispatchResult>;
    readonly probe: (input: SessionProbeInput) => Promise<SessionProbeResult>;
    readonly readOutcome: (
        input: SessionOutcomeInput,
    ) => Promise<SessionOutcomeRead>;
    readonly abort: (input: SessionAbortInput) => Promise<SessionAbortResult>;
    readonly health: (signal?: AbortSignal) => Promise<SessionHealthResult>;
    readonly observe?: (
        input: SessionObserveInput,
    ) => AsyncIterable<SessionObservation>;
}

/** An adapter may use this only when it knows no external side effect occurred. */
export class BeforeExternalSideEffectError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'BeforeExternalSideEffectError';
    }
}

export interface SupervisorError {
    readonly operation:
        | 'dispatch'
        | 'probe'
        | 'reconcile'
        | 'verification'
        | 'cancellation';
    readonly id: string;
    readonly message: string;
}

export interface DispatchBatchResult {
    readonly claimed: number;
    readonly probed: number;
    readonly absent: number;
    readonly active: number;
    readonly completed: number;
    readonly unknown: number;
    readonly dispatched: number;
    readonly delivered: number;
    readonly failed: number;
    readonly errors: readonly SupervisorError[];
}

export interface ReconciliationBatchResult {
    readonly inspected: number;
    readonly active: number;
    readonly completed: number;
    readonly unknown: number;
    readonly renewed: number;
    readonly outcomesReported: number;
    readonly verificationsRun: number;
    readonly finalVerificationsRun: number;
    readonly goalsFinalized: number;
    readonly failed: number;
    readonly errors: readonly SupervisorError[];
}

export interface CancellationBatchResult {
    readonly pending: number;
    readonly aborted: number;
    readonly acknowledged: number;
    readonly failed: number;
    readonly errors: readonly SupervisorError[];
}

export interface GoalSupervisorOptions {
    readonly dispatcherLeaseMs?: number;
    readonly attemptLeaseMs?: number;
    readonly dispatchConcurrency?: number;
    readonly reconciliationConcurrency?: number;
    readonly verificationRunner?: VerificationRunner;
}

export type VerificationRunner = (
    workspaceRoot: string,
    input: VerificationInput,
) => Promise<ProcessVerificationResult>;

const DEFAULT_DISPATCHER_LEASE_MS = 60_000;
const DEFAULT_ATTEMPT_LEASE_MS = 5 * 60_000;
const MAX_CONCURRENCY = 1_000;
const VERIFICATION_STATUS_RANK: Readonly<Record<VerificationStatus, number>> = {
    'spawn-error': 0,
    cancelled: 0,
    'timed-out': 1,
    'output-limit': 1,
    failed: 2,
    passed: 3,
};
const VERIFICATION_STATUS_UNIT = 'verification-status-rank';

const boundedPositiveInteger = (
    value: number | undefined,
    fallback: number,
    label: string,
    maximum = 24 * 60 * 60_000,
): number => {
    const resolved = value ?? fallback;
    if (
        !Number.isSafeInteger(resolved) ||
        resolved <= 0 ||
        resolved > maximum
    ) {
        throw new RangeError(
            `${label} must be an integer from 1 through ${maximum}.`,
        );
    }
    return resolved;
};

const redactError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return Array.from(message)
        .filter(character => {
            const code = character.charCodeAt(0);
            return code >= 0x20 && code !== 0x7f;
        })
        .join('')
        .replace(
            /\b(authorization|token|password|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi,
            '$1=[REDACTED]',
        )
        .slice(0, 500);
};

const compactOutput = (result: ProcessVerificationResult): string =>
    [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 4_096);

const verificationStatus = (
    status: ProcessVerificationResult['status'],
): 'passed' | 'failed' | 'inconclusive' | 'error' => {
    if (status === 'passed') return 'passed';
    if (status === 'failed') return 'failed';
    if (status === 'timed-out' || status === 'output-limit') {
        return 'inconclusive';
    }
    return 'error';
};

const verificationSummary = (
    requirement: VerificationRequirement,
    result: ProcessVerificationResult,
): string =>
    `Verification ${requirement.id} ${result.status}`
        .replace(/[\r\n\u007f]/g, ' ')
        .slice(0, 500);

const verificationEvidence = (
    attemptId: string,
    requirementId: string,
    outputDigest: string,
) => ({
    ref: `verification:${attemptId}:${requirementId}:${outputDigest.slice(0, 16)}`,
    digest: `sha256:${outputDigest}` as const,
});

const mapConcurrent = async <Item>(
    items: readonly Item[],
    concurrency: number,
    run: (item: Item) => Promise<void>,
): Promise<void> => {
    let index = 0;
    const worker = async (): Promise<void> => {
        while (index < items.length) {
            const item = items[index++];
            // oxlint-disable-next-line eslint/no-await-in-loop
            if (item !== undefined) await run(item);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, worker),
    );
};

const commandFor = (message: ClaimedOutboxMessage): OutboxCommand => {
    const command = OutboxCommandSchema.parse(message.payload);
    if (
        command.id !== message.id ||
        command.attemptId !== message.attemptId ||
        command.idempotencyKey !== message.idempotencyKey
    ) {
        throw new Error(
            'Claimed outbox command does not match its durable envelope.',
        );
    }
    return command;
};

const resultRecord = (
    operation: SupervisorError['operation'],
    id: string,
    error: unknown,
): SupervisorError => ({ operation, id, message: redactError(error) });

type ExistingVerification = {
    readonly id: string;
    readonly status: 'passed' | 'failed' | 'inconclusive' | 'error';
};

/** Coordinates delivery, reconciliation, verification, and cancellation. */
export class GoalSupervisor {
    readonly #dispatcherLeaseMs: number;
    readonly #attemptLeaseMs: number;
    readonly #dispatchConcurrency: number;
    readonly #reconciliationConcurrency: number;
    readonly #verificationRunner: VerificationRunner;
    readonly #reconciling = new Set<string>();
    readonly #finalizing = new Set<string>();

    constructor(
        private readonly store: GoalStore,
        private readonly adapter: GoalSessionAdapter,
        options: GoalSupervisorOptions = {},
    ) {
        this.#dispatcherLeaseMs = boundedPositiveInteger(
            options.dispatcherLeaseMs,
            DEFAULT_DISPATCHER_LEASE_MS,
            'dispatcherLeaseMs',
        );
        this.#attemptLeaseMs = boundedPositiveInteger(
            options.attemptLeaseMs,
            DEFAULT_ATTEMPT_LEASE_MS,
            'attemptLeaseMs',
        );
        this.#dispatchConcurrency = boundedPositiveInteger(
            options.dispatchConcurrency,
            1,
            'dispatchConcurrency',
            MAX_CONCURRENCY,
        );
        this.#reconciliationConcurrency = boundedPositiveInteger(
            options.reconciliationConcurrency,
            1,
            'reconciliationConcurrency',
            MAX_CONCURRENCY,
        );
        this.#verificationRunner =
            options.verificationRunner ?? runVerification;
    }

    async #withAttemptHeartbeat<Value>(
        attempt: WorkAttempt,
        operation: () => Promise<Value>,
    ): Promise<Value> {
        const renew = (): void => {
            this.store.renewAttempt(
                attempt.id,
                attempt.leaseToken,
                attempt.leaseOwner,
                this.#attemptLeaseMs,
            );
        };
        renew();
        const intervalMs = Math.max(
            1,
            Math.min(30_000, Math.floor(this.#attemptLeaseMs / 3)),
        );
        let heartbeatError: unknown;
        const heartbeat = setInterval(() => {
            try {
                renew();
            } catch (error) {
                heartbeatError ??= error;
                clearInterval(heartbeat);
            }
        }, intervalMs);
        heartbeat.unref();
        try {
            const value = await operation();
            if (heartbeatError !== undefined) throw heartbeatError;
            renew();
            return value;
        } finally {
            clearInterval(heartbeat);
        }
    }

    async dispatchPending(
        limit = 10,
        signal?: AbortSignal,
    ): Promise<DispatchBatchResult> {
        const messages = this.store.claimOutbox(limit, this.#dispatcherLeaseMs);
        const mutable = {
            claimed: messages.length,
            probed: 0,
            absent: 0,
            active: 0,
            completed: 0,
            unknown: 0,
            dispatched: 0,
            delivered: 0,
            failed: 0,
            errors: [] as SupervisorError[],
        };

        await mapConcurrent(
            messages,
            this.#dispatchConcurrency,
            async message => {
                let command: OutboxCommand;
                try {
                    command = commandFor(message);
                } catch (error) {
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('dispatch', message.id, error),
                    );
                    this.#recordDispatchFailure(
                        message,
                        error,
                        false,
                        mutable.errors,
                    );
                    return;
                }

                const status = this.store.status(command.goalId);
                if (status.goal.state !== 'executing') {
                    const error = new Error('Goal is no longer executing.');
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('dispatch', message.id, error),
                    );
                    this.#recordDispatchFailure(
                        message,
                        error,
                        false,
                        mutable.errors,
                    );
                    return;
                }

                if (message.needsProbe) {
                    mutable.probed++;
                    let probe: SessionProbeResult;
                    try {
                        if (typeof this.adapter.probe !== 'function') {
                            throw new Error(
                                'Session adapter does not implement probe.',
                            );
                        }
                        probe = await this.adapter.probe({
                            idempotencyKey: message.idempotencyKey,
                            command,
                            workspace: status.workspace,
                            signal,
                        });
                    } catch (error) {
                        mutable.unknown++;
                        mutable.failed++;
                        mutable.errors.push(
                            resultRecord('probe', message.id, error),
                        );
                        this.#recordProbeUnknown(message, mutable.errors);
                        return;
                    }

                    if (
                        !['absent', 'active', 'completed', 'unknown'].includes(
                            probe.status,
                        )
                    ) {
                        const error = new Error(
                            'Session adapter returned an invalid probe status.',
                        );
                        mutable.unknown++;
                        mutable.failed++;
                        mutable.errors.push(
                            resultRecord('probe', message.id, error),
                        );
                        this.#recordProbeUnknown(message, mutable.errors);
                        return;
                    }
                    if (
                        (probe.status === 'active' ||
                            probe.status === 'completed') &&
                        !CompactReferenceSchema.safeParse(probe.externalRef)
                            .success
                    ) {
                        const error = new Error(
                            'An active or completed probe requires a compact external reference.',
                        );
                        mutable.unknown++;
                        mutable.failed++;
                        mutable.errors.push(
                            resultRecord('probe', message.id, error),
                        );
                        this.#recordProbeUnknown(message, mutable.errors);
                        return;
                    }
                    try {
                        this.store.recordProbeResult(
                            message.id,
                            message.leaseToken,
                            probe,
                        );
                    } catch (error) {
                        mutable.unknown++;
                        mutable.failed++;
                        mutable.errors.push(
                            resultRecord('probe', message.id, error),
                        );
                        this.#recordProbeUnknown(message, mutable.errors);
                        return;
                    }
                    mutable[probe.status]++;
                    if (probe.status !== 'absent') mutable.delivered++;
                    return;
                }

                let lateReferencePersisted = false;
                try {
                    this.store.markDispatchStarted(
                        message.id,
                        message.leaseToken,
                    );
                    mutable.dispatched++;
                    const dispatched = await this.adapter.dispatch({
                        idempotencyKey: message.idempotencyKey,
                        command,
                        workspace: status.workspace,
                        signal,
                    });
                    CompactReferenceSchema.parse(dispatched.externalRef);
                    try {
                        this.store.markOutboxDelivered(
                            message.id,
                            message.leaseToken,
                            dispatched.externalRef,
                        );
                    } catch (error) {
                        this.store.recordLateDispatchReference(
                            command.attemptId,
                            dispatched.externalRef,
                        );
                        lateReferencePersisted = true;
                        throw error;
                    }
                    mutable.delivered++;
                } catch (error) {
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('dispatch', message.id, error),
                    );
                    if (!lateReferencePersisted) {
                        this.#recordDispatchFailure(
                            message,
                            error,
                            !(error instanceof BeforeExternalSideEffectError),
                            mutable.errors,
                        );
                    }
                }
            },
        );

        return mutable;
    }

    #recordDispatchFailure(
        message: ClaimedOutboxMessage,
        error: unknown,
        ambiguous: boolean,
        errors: SupervisorError[],
    ): void {
        try {
            this.store.recordDispatchFailure(
                message.id,
                message.leaseToken,
                error,
                ambiguous,
            );
        } catch (persistenceError) {
            errors.push(resultRecord('dispatch', message.id, persistenceError));
        }
    }

    #recordProbeUnknown(
        message: ClaimedOutboxMessage,
        errors: SupervisorError[],
    ): void {
        try {
            this.store.recordProbeResult(
                message.id,
                message.leaseToken,
                'unknown',
            );
        } catch (error) {
            errors.push(resultRecord('probe', message.id, error));
        }
    }

    async reconcileActive(
        limit = 100,
        signal?: AbortSignal,
    ): Promise<ReconciliationBatchResult> {
        boundedPositiveInteger(limit, 100, 'reconciliation limit', 1_000);
        const references = this.store.listSessionReferences();
        const referenceByAttempt = new Map<string, SessionReference>();
        for (const reference of references) {
            referenceByAttempt.set(reference.attemptId, reference);
        }
        const attempts = this.store.listActiveAttempts().slice(0, limit);
        const mutable = {
            inspected: 0,
            active: 0,
            completed: 0,
            unknown: 0,
            renewed: 0,
            outcomesReported: 0,
            verificationsRun: 0,
            finalVerificationsRun: 0,
            goalsFinalized: 0,
            failed: 0,
            errors: [] as SupervisorError[],
        };

        await mapConcurrent(
            attempts,
            this.#reconciliationConcurrency,
            async attempt => {
                if (this.#reconciling.has(attempt.id)) return;
                const reference = referenceByAttempt.get(attempt.id);
                if (!reference) return;
                this.#reconciling.add(attempt.id);
                mutable.inspected++;
                try {
                    await this.#reconcileAttempt(
                        attempt,
                        reference,
                        mutable,
                        signal,
                    );
                } catch (error) {
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('reconcile', attempt.id, error),
                    );
                    this.#recordReconciliationFailure(reference, error);
                } finally {
                    this.#reconciling.delete(attempt.id);
                }
            },
        );

        const goalIds = new Set(references.map(reference => reference.goalId));
        for (const goalId of goalIds) {
            try {
                // Finalization mutates one durable goal at a time.
                // oxlint-disable-next-line eslint/no-await-in-loop
                const final = await this.#verifyAndFinalizeGoal(goalId, signal);
                mutable.finalVerificationsRun += final.verifications;
                mutable.goalsFinalized += final.finalized ? 1 : 0;
            } catch (error) {
                mutable.failed++;
                mutable.errors.push(
                    resultRecord('verification', goalId, error),
                );
            }
        }
        return mutable;
    }

    async #reconcileAttempt(
        attempt: WorkAttempt,
        reference: SessionReference,
        result: {
            active: number;
            completed: number;
            unknown: number;
            renewed: number;
            outcomesReported: number;
            verificationsRun: number;
            failed: number;
            errors: SupervisorError[];
        },
        signal?: AbortSignal,
    ): Promise<void> {
        const workUnit = this.store.getWorkUnit(attempt.workUnitId);
        if (!workUnit) return;
        const goal = this.store.status(workUnit.goalId);
        if (goal.goal.state !== 'executing') return;

        let read: SessionOutcomeRead;
        try {
            read = await this.#withAttemptHeartbeat(attempt, () =>
                this.adapter.readOutcome({
                    externalRef: reference.externalRef,
                    attemptId: attempt.id,
                    leaseToken: attempt.leaseToken,
                    workspace: goal.workspace,
                    signal,
                }),
            );
        } catch (error) {
            result.failed++;
            result.errors.push(resultRecord('reconcile', attempt.id, error));
            this.#recordReconciliationFailure(reference, error);
            this.#renewAmbiguousAttempt(attempt, result);
            return;
        }

        if (read.status === 'active') {
            result.active++;
            try {
                this.store.renewAttempt(
                    attempt.id,
                    attempt.leaseToken,
                    attempt.leaseOwner,
                    this.#attemptLeaseMs,
                );
                result.renewed++;
            } catch (error) {
                result.failed++;
                result.errors.push(
                    resultRecord('reconcile', attempt.id, error),
                );
            }
            return;
        }
        if (read.status === 'unknown') {
            result.unknown++;
            this.#recordReconciliationFailure(
                reference,
                read.reason ?? 'External session outcome is inconclusive.',
            );
            this.#renewAmbiguousAttempt(attempt, result);
            return;
        }

        let outcome: AgentOutcome;
        if (read.status === 'terminal-unknown') {
            result.unknown++;
            const reason =
                redactError(read.reason) ||
                'External session ended without a valid outcome.';
            this.#recordReconciliationFailure(reference, reason);
            outcome = AgentOutcomeSchema.parse({
                schemaVersion: 1,
                attemptId: attempt.id,
                leaseToken: attempt.leaseToken,
                status: 'unknown-outcome',
                summary: reason,
                evidenceRefs: [],
                verificationRefs: [],
                issueClassification: 'external-ambiguity',
            });
        } else {
            result.completed++;
            const parsed = AgentOutcomeSchema.safeParse({
                ...read.outcome,
                transcriptRef: read.transcriptRef,
            });
            if (
                !parsed.success ||
                parsed.data.attemptId !== attempt.id ||
                parsed.data.leaseToken !== attempt.leaseToken
            ) {
                const error = new Error(
                    'Adapter returned a terminal outcome that does not match the active attempt lease.',
                );
                result.unknown++;
                this.#recordReconciliationFailure(reference, error);
                outcome = AgentOutcomeSchema.parse({
                    schemaVersion: 1,
                    attemptId: attempt.id,
                    leaseToken: attempt.leaseToken,
                    status: 'unknown-outcome',
                    summary: error.message,
                    evidenceRefs: [],
                    verificationRefs: [],
                    issueClassification: 'external-ambiguity',
                });
            } else {
                outcome = normalizeAgentOutcomeForPolicy(parsed.data);
            }
        }
        if (outcome.status === 'completed') {
            const verification = await this.#verifyAttempt(
                goal.workspace,
                workUnit.input,
                attempt,
                outcome,
                signal,
            );
            result.verificationsRun += verification.ran;
            outcome = verification.outcome;
        }
        try {
            this.store.reportOutcome(outcome);
            result.outcomesReported++;
        } catch (error) {
            result.failed++;
            result.errors.push(resultRecord('reconcile', attempt.id, error));
            this.#recordReconciliationFailure(reference, error);
        }
    }

    #renewAmbiguousAttempt(
        attempt: WorkAttempt,
        result: {
            renewed: number;
            failed: number;
            errors: SupervisorError[];
        },
    ): void {
        try {
            this.store.renewAttempt(
                attempt.id,
                attempt.leaseToken,
                attempt.leaseOwner,
                this.#attemptLeaseMs,
            );
            result.renewed++;
        } catch (error) {
            result.failed++;
            result.errors.push(resultRecord('reconcile', attempt.id, error));
        }
    }

    #recordReconciliationFailure(
        reference: SessionReference,
        error: unknown,
    ): void {
        const message =
            redactError(error) || 'External session reconciliation failed.';
        const digest = createHash('sha256').update(message).digest('hex');
        try {
            this.store.recordObservation(reference.goalId, {
                source: 'supervisor',
                kind: 'failure',
                observedAt: new Date().toISOString(),
                summary: message,
                workUnitId: reference.workUnitId,
                attemptId: reference.attemptId,
                issueClassification: 'external-ambiguity',
                deduplicationKey: `reconcile:${reference.attemptId}:${digest}`,
                data: { externalRef: reference.externalRef },
            });
        } catch {
            // The structured batch error remains visible if the attempt was concurrently fenced.
        }
    }

    #existingAttemptVerifications(
        goalId: string,
        attemptId: string,
    ): ReadonlyMap<string, ExistingVerification> {
        const found = new Map<string, ExistingVerification>();
        for (const event of this.store.events(goalId)) {
            if (
                event.type !== 'verification.recorded' ||
                event.payload.attemptId !== attemptId ||
                typeof event.payload.requirementId !== 'string' ||
                typeof event.payload.verificationResultId !== 'string' ||
                !['passed', 'failed', 'inconclusive', 'error'].includes(
                    String(event.payload.status),
                )
            ) {
                continue;
            }
            found.set(event.payload.requirementId, {
                id: event.payload.verificationResultId,
                status: event.payload.status as ExistingVerification['status'],
            });
        }
        return found;
    }

    async #verifyAttempt(
        workspace: string,
        input: Readonly<Record<string, unknown>>,
        attempt: WorkAttempt,
        outcome: AgentOutcome,
        signal?: AbortSignal,
    ): Promise<{ readonly outcome: AgentOutcome; readonly ran: number }> {
        const requirements = this.store.getAttemptVerificationRequirements(
            attempt.id,
        );
        const existing = this.#existingAttemptVerifications(
            this.store.getWorkUnit(attempt.workUnitId)!.goalId,
            attempt.id,
        );
        const verificationRefs = new Set(outcome.verificationRefs);
        const failedRequired: string[] = [];
        let ran = 0;

        for (const requirement of requirements) {
            const previous = existing.get(requirement.id);
            if (previous) {
                verificationRefs.add(previous.id);
                if (requirement.required && previous.status !== 'passed') {
                    failedRequired.push(requirement.id);
                }
                continue;
            }
            const baseline = this.store.getVerificationBaseline(
                attempt.id,
                requirement.id,
            );
            // Requirements are persisted in declaration order for deterministic evidence.
            // oxlint-disable-next-line eslint/no-await-in-loop
            const processResult = await this.#runRequirement(
                workspace,
                typeof input.cwd === 'string' ? input.cwd : '.',
                attempt.id,
                requirement,
                signal,
                attempt,
                baseline,
            );
            ran++;
            const status = verificationStatus(processResult.status);
            const evidence = verificationEvidence(
                attempt.id,
                requirement.id,
                processResult.outputDigest,
            );
            const stored = this.store.recordVerificationResult(attempt.id, {
                requirementId: requirement.id,
                status,
                summary: verificationSummary(requirement, processResult),
                exitCode:
                    processResult.exitCode !== null &&
                    processResult.exitCode >= 0 &&
                    processResult.exitCode <= 255
                        ? processResult.exitCode
                        : undefined,
                baseline: processResult.baseline
                    ? {
                          value: VERIFICATION_STATUS_RANK[
                              processResult.baseline.status
                          ],
                          unit: VERIFICATION_STATUS_UNIT,
                      }
                    : undefined,
                observed: {
                    value: VERIFICATION_STATUS_RANK[processResult.status],
                    unit: VERIFICATION_STATUS_UNIT,
                },
                improvement: processResult.baseline
                    ? {
                          absolute:
                              VERIFICATION_STATUS_RANK[processResult.status] -
                              VERIFICATION_STATUS_RANK[
                                  processResult.baseline.status
                              ],
                      }
                    : undefined,
                evidenceRefs: [evidence],
                startedAt: processResult.startedAt,
                completedAt: processResult.finishedAt,
                outputDigest: `sha256:${processResult.outputDigest}`,
                output: compactOutput(processResult),
                runtimeStatus: processResult.status,
            });
            verificationRefs.add(stored.id);
            if (requirement.required && status !== 'passed') {
                failedRequired.push(requirement.id);
            }
        }

        if (failedRequired.length === 0) {
            return {
                ran,
                outcome: AgentOutcomeSchema.parse({
                    ...outcome,
                    verificationRefs: [...verificationRefs],
                }),
            };
        }
        const summary = `Required verification failed: ${failedRequired.join(', ')}`;
        return {
            ran,
            outcome: AgentOutcomeSchema.parse({
                ...outcome,
                status: 'failed',
                summary: summary.slice(0, 500),
                verificationRefs: [...verificationRefs],
                issueClassification: 'verification',
                failureFingerprint:
                    `verification:${failedRequired.join(':')}`.slice(0, 512),
            }),
        };
    }

    async #runRequirement(
        workspace: string,
        cwd: string,
        attemptId: string,
        requirement: VerificationRequirement,
        signal?: AbortSignal,
        attempt?: WorkAttempt,
        baseline?: DurableVerificationBaseline,
    ): Promise<ProcessVerificationResult> {
        const execute = async (): Promise<ProcessVerificationResult> => {
            try {
                return await this.#verificationRunner(workspace, {
                    id: `${attemptId}:${requirement.id}`,
                    label: requirement.id,
                    command: requirement.executable,
                    args: requirement.args,
                    cwd,
                    timeoutMs: requirement.timeoutMs,
                    maxOutputBytes: requirement.outputCapBytes,
                    expectedExitCodes: [requirement.expectedExitCode],
                    baseline,
                    signal,
                });
            } catch (error) {
                const now = new Date().toISOString();
                const message =
                    redactError(error) || 'Verification could not be started.';
                return {
                    id: `${attemptId}:${requirement.id}`,
                    label: requirement.id,
                    status: 'spawn-error',
                    exitCode: null,
                    signal: null,
                    startedAt: now,
                    finishedAt: now,
                    durationMs: 0,
                    stdout: '',
                    stderr: message,
                    outputDigest: createHash('sha256')
                        .update(JSON.stringify({ stdout: '', stderr: message }))
                        .digest('hex'),
                    baseline,
                    improvement:
                        baseline &&
                        VERIFICATION_STATUS_RANK['spawn-error'] <
                            VERIFICATION_STATUS_RANK[baseline.status]
                            ? 'regressed'
                            : baseline
                              ? 'unchanged'
                              : 'not-applicable',
                };
            }
        };
        return attempt
            ? await this.#withAttemptHeartbeat(attempt, execute)
            : await execute();
    }

    #currentFinalVerifications(
        goalId: string,
        activePlanId: string,
    ): ReadonlyMap<string, ExistingVerification> {
        const events = this.store.events(goalId);
        const found = new Map<string, ExistingVerification>();
        for (const event of events) {
            if (
                event.type !== 'verification.final-recorded' ||
                event.payload.planId !== activePlanId ||
                typeof event.payload.requirementId !== 'string' ||
                typeof event.payload.verificationResultId !== 'string' ||
                !['passed', 'failed', 'inconclusive', 'error'].includes(
                    String(event.payload.status),
                )
            ) {
                continue;
            }
            found.set(event.payload.requirementId, {
                id: event.payload.verificationResultId,
                status: event.payload.status as ExistingVerification['status'],
            });
        }
        return found;
    }

    async #verifyAndFinalizeGoal(
        goalId: string,
        signal?: AbortSignal,
    ): Promise<{
        readonly verifications: number;
        readonly finalized: boolean;
    }> {
        if (this.#finalizing.has(goalId)) {
            return { verifications: 0, finalized: false };
        }
        const status = this.store.status(goalId);
        if (status.goal.state !== 'executing' || !status.goal.activePlanId) {
            return { verifications: 0, finalized: false };
        }
        const units = this.store.listWorkUnits(goalId, true);
        if (units.some(unit => unit.required && unit.state !== 'accepted')) {
            return { verifications: 0, finalized: false };
        }

        this.#finalizing.add(goalId);
        try {
            const requirements =
                this.store.getFinalVerificationRequirements(goalId);
            const existing = this.#currentFinalVerifications(
                goalId,
                status.goal.activePlanId,
            );
            let ran = 0;
            for (const requirement of requirements) {
                if (existing.has(requirement.id)) continue;
                // Final requirements are durably recorded in declaration order.
                // oxlint-disable-next-line eslint/no-await-in-loop
                const processResult = await this.#runRequirement(
                    status.workspace,
                    '.',
                    `final:${status.goal.activePlanId}`,
                    requirement,
                    signal,
                );
                ran++;
                this.store.recordFinalVerificationResult(
                    goalId,
                    status.goal.activePlanId,
                    {
                        requirementId: requirement.id,
                        status: verificationStatus(processResult.status),
                        summary: verificationSummary(
                            requirement,
                            processResult,
                        ),
                        evidenceRefs: [
                            verificationEvidence(
                                `final:${status.goal.activePlanId}`,
                                requirement.id,
                                processResult.outputDigest,
                            ),
                        ],
                        outputDigest: `sha256:${processResult.outputDigest}`,
                        output: compactOutput(processResult),
                        startedAt: processResult.startedAt,
                        completedAt: processResult.finishedAt,
                    },
                );
            }

            const current = this.#currentFinalVerifications(
                goalId,
                status.goal.activePlanId,
            );
            const allRequiredPassed = requirements
                .filter(requirement => requirement.required)
                .every(
                    requirement =>
                        current.get(requirement.id)?.status === 'passed',
                );
            if (!allRequiredPassed)
                return { verifications: ran, finalized: false };
            this.store.finalizeGoal(goalId);
            return { verifications: ran, finalized: true };
        } finally {
            this.#finalizing.delete(goalId);
        }
    }

    async processCancellations(
        limit = 100,
        signal?: AbortSignal,
    ): Promise<CancellationBatchResult> {
        boundedPositiveInteger(limit, 100, 'cancellation limit', 1_000);
        const pending = this.store
            .listCancellationRequests()
            .filter(request => request.state === 'pending')
            .slice(0, limit);
        const mutable = {
            pending: pending.length,
            aborted: 0,
            acknowledged: 0,
            failed: 0,
            errors: [] as SupervisorError[],
        };
        const references = this.store.listSessionReferences();

        for (const request of pending) {
            let externalRef =
                request.externalRef ??
                references.find(
                    reference => reference.attemptId === request.attemptId,
                )?.externalRef;
            if (!externalRef) {
                const command = this.store.getDispatchCommand(
                    request.attemptId,
                );
                if (!command) {
                    const error = new Error(
                        'The durable dispatch command is unavailable; cancellation remains pending.',
                    );
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('cancellation', request.id, error),
                    );
                    this.#keepCancellationPending(
                        request.id,
                        error,
                        mutable.errors,
                    );
                    continue;
                }
                let probe: SessionProbeResult;
                try {
                    // Probe the durable key rather than treating a missing ref as no side effect.
                    // oxlint-disable-next-line eslint/no-await-in-loop
                    probe = await this.adapter.probe({
                        idempotencyKey: command.idempotencyKey,
                        command,
                        workspace: this.store.status(request.goalId).workspace,
                        signal,
                    });
                } catch (error) {
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('cancellation', request.id, error),
                    );
                    this.#keepCancellationPending(
                        request.id,
                        error,
                        mutable.errors,
                    );
                    continue;
                }
                if (probe.status === 'absent') {
                    try {
                        this.store.acknowledgeCancellationRequest(
                            request.id,
                            true,
                        );
                        mutable.acknowledged++;
                    } catch (error) {
                        mutable.failed++;
                        mutable.errors.push(
                            resultRecord('cancellation', request.id, error),
                        );
                    }
                    continue;
                }
                if (probe.status === 'unknown') {
                    const error = new Error(
                        'Cancellation probe remained externally inconclusive.',
                    );
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('cancellation', request.id, error),
                    );
                    this.#keepCancellationPending(
                        request.id,
                        error,
                        mutable.errors,
                    );
                    continue;
                }
                const parsedReference = CompactReferenceSchema.safeParse(
                    probe.externalRef,
                );
                if (!parsedReference.success) {
                    const error = new Error(
                        'Cancellation probe returned an invalid external reference.',
                    );
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('cancellation', request.id, error),
                    );
                    this.#keepCancellationPending(
                        request.id,
                        error,
                        mutable.errors,
                    );
                    continue;
                }
                try {
                    this.store.persistCancellationExternalReference(
                        request.id,
                        parsedReference.data,
                    );
                    externalRef = parsedReference.data;
                } catch (error) {
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('cancellation', request.id, error),
                    );
                    this.#keepCancellationPending(
                        request.id,
                        error,
                        mutable.errors,
                    );
                    continue;
                }
            } else if (!request.externalRef) {
                try {
                    this.store.persistCancellationExternalReference(
                        request.id,
                        externalRef,
                    );
                } catch (error) {
                    mutable.failed++;
                    mutable.errors.push(
                        resultRecord('cancellation', request.id, error),
                    );
                    this.#keepCancellationPending(
                        request.id,
                        error,
                        mutable.errors,
                    );
                    continue;
                }
            }
            try {
                // Acknowledging each durable inbox row before advancing avoids replay races.
                // oxlint-disable-next-line eslint/no-await-in-loop
                const result = await this.adapter.abort({
                    externalRef,
                    reason: request.reason,
                    workspace: this.store.status(request.goalId).workspace,
                    signal,
                });
                if (result.aborted) {
                    this.store.acknowledgeCancellationRequest(request.id, true);
                    mutable.aborted++;
                    mutable.acknowledged++;
                } else {
                    mutable.failed++;
                    this.#keepCancellationPending(
                        request.id,
                        'External abort was not acknowledged.',
                        mutable.errors,
                    );
                }
            } catch (error) {
                mutable.failed++;
                mutable.errors.push(
                    resultRecord('cancellation', request.id, error),
                );
                this.#keepCancellationPending(
                    request.id,
                    error,
                    mutable.errors,
                );
            }
        }
        return mutable;
    }

    #keepCancellationPending(
        requestId: string,
        error: unknown,
        errors: SupervisorError[],
    ): void {
        try {
            this.store.recordCancellationPending(requestId, error);
        } catch (persistenceError) {
            errors.push(
                resultRecord('cancellation', requestId, persistenceError),
            );
        }
    }

    async observeAdapter(signal: AbortSignal): Promise<void> {
        if (!this.adapter.observe) return;
        const observations = this.adapter.observe({
            externalRefs: () =>
                this.store
                    .listSessionReferences()
                    .map(reference => reference.externalRef),
            signal,
            maxRetryAttempts: 5,
            maxRetryDelayMs: 30_000,
        });
        for await (const observation of observations) {
            const reference = this.store
                .listSessionReferences()
                .find(
                    candidate =>
                        candidate.externalRef === observation.externalRef,
                );
            if (!reference) continue;
            const parsedObservedAt = observation.observedAt
                ? new Date(observation.observedAt)
                : new Date();
            const observedAt = Number.isNaN(parsedObservedAt.getTime())
                ? new Date().toISOString()
                : parsedObservedAt.toISOString();
            const summary = observation.summary
                .replace(/[\r\n\u007f]/g, ' ')
                .trim()
                .slice(0, 500);
            const parsedDeduplicationKey = CompactReferenceSchema.safeParse(
                observation.deduplicationKey,
            );
            const deduplicationKey = parsedDeduplicationKey.success
                ? parsedDeduplicationKey.data
                : `adapter-observation:${createHash('sha256')
                      .update(observation.deduplicationKey)
                      .digest('hex')}`;
            this.store.recordObservation(reference.goalId, {
                source: 'agent',
                kind: observation.kind,
                observedAt,
                summary: summary || 'External session observation.',
                workUnitId: reference.workUnitId,
                attemptId: reference.attemptId,
                issueClassification: observation.issueClassification,
                deduplicationKey,
                data: observation.data,
            });
        }
    }

    async health(signal?: AbortSignal): Promise<SessionHealthResult> {
        return this.adapter.health(signal);
    }
}
