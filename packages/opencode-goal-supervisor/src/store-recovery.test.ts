import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION } from './domain.js';
import { GoalStore, type GoalStoreOptions, type PlanInput } from './store.js';

const directories: string[] = [];
const stores: GoalStore[] = [];

const databasePath = async (): Promise<string> => {
    const directory = await mkdtemp(
        join(tmpdir(), 'goal-supervisor-recovery-'),
    );
    directories.push(directory);
    return join(directory, 'goal.db');
};

const open = (path: string, options?: GoalStoreOptions): GoalStore => {
    const store = new GoalStore(path, options);
    stores.push(store);
    return store;
};

afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const simplePlan = (
    overrides: Partial<PlanInput['units'][number]> = {},
): PlanInput => ({
    authoredBy: 'planner',
    units: [
        {
            id: 'unit',
            title: 'Unit',
            instructions: 'Complete the unit.',
            dependencyIds: [],
            acceptanceCriteria: ['Must complete'],
            ...overrides,
        },
    ],
    finalVerificationRequirements: [],
});

const executingGoal = (store: GoalStore, objective = 'Recover safely') => {
    const goal = store.create('/workspace', objective);
    const plan = store.proposePlan(goal.id, simplePlan());
    store.approvePlan(goal.id, plan.id, 'operator');
    const approval = store.issueApproval(
        goal.id,
        { type: 'goal-action', action: 'unattended-start' },
        'operator',
        'Start',
        60_000,
    );
    store.startGoal(goal.id, approval.token);
    return goal;
};

describe('attempt and outbox recovery', () => {
    test('claims exclusively across connections and fences expired replacement attempts', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        const options: GoalStoreOptions = { clock: () => new Date(now) };
        const path = await databasePath();
        const firstStore = open(path, options);
        const goal = executingGoal(firstStore);
        const secondStore = open(path, options);

        const first = firstStore.claimNextWork('worker-a', 1_000)!;
        expect(secondStore.claimNextWork('worker-b', 1_000)).toBeUndefined();
        expect(
            firstStore.renewAttempt(
                first.id,
                first.leaseToken,
                'worker-a',
                1_000,
            ),
        ).toMatchObject({
            id: first.id,
            number: 1,
        });
        expect(() =>
            firstStore.renewAttempt(
                first.id,
                first.leaseToken,
                'worker-b',
                1_000,
            ),
        ).toThrow('cannot be renewed');

        now += 1_001;
        expect(firstStore.recoverExpiredAttempts()).toBe(1);
        const replacement = secondStore.claimNextWork('worker-b', 60_000)!;
        expect(replacement).toMatchObject({
            number: 2,
            workUnitId: first.workUnitId,
        });
        expect(() =>
            firstStore.renewAttempt(
                first.id,
                first.leaseToken,
                'worker-a',
                1_000,
            ),
        ).toThrow('cannot be renewed');
        const delivery = secondStore.claimOutbox(10, 1_000);
        expect(delivery).toHaveLength(1);
        expect(delivery[0]?.attemptId).toBe(replacement.id);
        expect(delivery[0]?.idempotencyKey).toBe(`attempt:${replacement.id}`);
        expect(firstStore.status(goal.id).goal.state).toBe('executing');
    });

    test('retries the same delivery key and requires a probe after the call boundary', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        const path = await databasePath();
        const store = open(path, { clock: () => new Date(now) });
        executingGoal(store);
        store.claimNextWork('worker', 60_000);

        const first = store.claimOutbox(1, 1_000)[0]!;
        store.recordDispatchFailure(
            first.id,
            first.leaseToken,
            'network failed',
            false,
        );
        now += 1_001;
        const retry = store.claimOutbox(1, 1_000)[0]!;
        expect(retry.id).toBe(first.id);
        expect(retry.idempotencyKey).toBe(first.idempotencyKey);
        expect(retry.retryCount).toBe(1);
        store.markDispatchStarted(retry.id, retry.leaseToken);

        now += 1_001;
        const reclaimed = store.claimOutbox(1, 1_000)[0]!;
        expect(reclaimed.idempotencyKey).toBe(first.idempotencyKey);
        expect(reclaimed.needsProbe).toBe(true);
        expect(() =>
            store.markOutboxDelivered(
                reclaimed.id,
                reclaimed.leaseToken,
                'session://unsafe',
            ),
        ).toThrow('requires a probe');
        store.recordProbeResult(reclaimed.id, reclaimed.leaseToken, 'absent');
        const safeRetry = store.claimOutbox(1, 1_000)[0]!;
        expect(safeRetry.needsProbe).toBe(false);
        store.markDispatchStarted(safeRetry.id, safeRetry.leaseToken);
        store.markOutboxDelivered(
            safeRetry.id,
            safeRetry.leaseToken,
            'session://active',
        );
        expect(store.deliveryHistory(first.id).map(row => row.action)).toEqual(
            expect.arrayContaining([
                'claim',
                'failure',
                'release',
                'reclaim',
                'probe-absent',
                'started',
                'delivered',
            ]),
        );
    });

    test('rejects delivery after lease expiry and routes an inconclusive probe to recovery', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        const path = await databasePath();
        const store = open(path, { clock: () => new Date(now) });
        const goal = executingGoal(store);
        store.claimNextWork('worker', 60_000);
        const first = store.claimOutbox(1, 1_000)[0]!;
        store.markDispatchStarted(first.id, first.leaseToken);
        now += 1_001;
        expect(() =>
            store.markOutboxDelivered(
                first.id,
                first.leaseToken,
                'session://late',
            ),
        ).toThrow('unexpired dispatcher lease');

        const reclaimed = store.claimOutbox(1, 1_000)[0]!;
        store.recordProbeResult(reclaimed.id, reclaimed.leaseToken, 'unknown');
        expect(store.get(goal.id)?.state).toBe('unknown-outcome');
        expect(store.claimOutbox(1, 1_000)).toHaveLength(0);

        const recovery = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'recover-unknown-outcome' },
            'operator',
            'Recover',
            60_000,
        );
        expect(() =>
            store.recoverUnknownOutcome(
                goal.id,
                recovery.token,
                'executing',
                '',
            ),
        ).toThrow('explicit decision');
        expect(
            store.recoverUnknownOutcome(
                goal.id,
                recovery.token,
                'executing',
                'The external system confirms no durable completion.',
            ).state,
        ).toBe('executing');
        expect(() =>
            store.recoverUnknownOutcome(
                goal.id,
                recovery.token,
                'cancelled',
                'Reuse token',
            ),
        ).toThrow('already been used');
    });

    test('fences dispatch immediately when paused or cancelled', async () => {
        const path = await databasePath();
        const store = open(path);
        const pausedGoal = executingGoal(store, 'Pause safely');
        store.claimNextWork('worker', 60_000);
        const dispatch = store.claimOutbox(1, 60_000)[0]!;
        store.markDispatchStarted(dispatch.id, dispatch.leaseToken);
        expect(store.pauseGoal(pausedGoal.id, 'Operator pause').state).toBe(
            'paused',
        );
        expect(store.claimOutbox(10, 60_000)).toHaveLength(0);
        expect(store.listCancellationRequests(pausedGoal.id)).toHaveLength(1);
        expect(store.listWorkUnits(pausedGoal.id, true)[0]?.state).toBe(
            'queued',
        );

        const resume = store.issueApproval(
            pausedGoal.id,
            { type: 'goal-action', action: 'resume' },
            'operator',
            'Resume',
            60_000,
        );
        expect(store.resumeGoal(pausedGoal.id, resume.token).state).toBe(
            'executing',
        );
        const replacement = store.claimNextWork('worker', 60_000)!;
        expect(replacement.number).toBe(2);
        expect(store.cancelGoal(pausedGoal.id, 'Stop').state).toBe('cancelled');
        expect(store.listWorkUnits(pausedGoal.id, true)[0]?.state).toBe(
            'cancelled',
        );
        expect(store.claimOutbox(10, 60_000)).toHaveLength(0);
    });

    test('never requeues an expired attempt after an external dispatch boundary', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        const path = await databasePath();
        const store = open(path, { clock: () => new Date(now) });
        const goal = executingGoal(store);
        const attempt = store.claimNextWork('worker', 1_000)!;
        const dispatch = store.claimOutbox(1, 1_000)[0]!;
        store.markDispatchStarted(dispatch.id, dispatch.leaseToken);
        store.markOutboxDelivered(
            dispatch.id,
            dispatch.leaseToken,
            'opencode-session:ambiguous',
        );

        now += 1_001;

        expect(store.recoverExpiredAttempts()).toBe(1);
        expect(store.get(goal.id)?.state).toBe('unknown-outcome');
        expect(store.getAttempt(attempt.id)?.state).toBe('unknown-outcome');
        expect(store.listWorkUnits(goal.id, true)[0]?.state).toBe(
            'unknown-outcome',
        );
        expect(store.claimNextWork('replacement', 60_000)).toBeUndefined();
        expect(store.claimOutbox(10, 60_000)).toHaveLength(0);
    });
});

describe('viability policy', () => {
    test.each([
        ['attempts', 'max_attempts'],
        ['wall_clock_ms', 'max_wall_clock_ms'],
        ['verification_ms', 'max_verification_ms'],
        ['tokens', 'max_tokens'],
    ] as const)(
        'blocks before claiming when %s usage is exhausted',
        async (usageColumn, budgetColumn) => {
            const path = await databasePath();
            const store = open(path);
            const goal = executingGoal(store, `Exhaust ${usageColumn}`);
            const database = new Database(path);
            database
                .prepare(
                    `UPDATE goal_budget_usage
                     SET ${usageColumn} = (
                       SELECT ${budgetColumn} FROM goal_budgets
                       WHERE goal_id = ?
                     )
                     WHERE goal_id = ?`,
                )
                .run(goal.id, goal.id);
            database.close();

            expect(store.claimNextWork('worker', 60_000)).toBeUndefined();
            expect(store.get(goal.id)?.state).toBe('blocked');
            expect(store.events(goal.id).at(-1)?.type).toBe(
                'goal.budget-exhausted',
            );
        },
    );

    test('external ambiguity overrides a nominal completed outcome', async () => {
        const path = await databasePath();
        const store = open(path);
        executingGoal(store);
        const attempt = store.claimNextWork('worker', 60_000)!;

        const report = store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            status: 'completed',
            summary: 'The external completion is ambiguous.',
            evidenceRefs: [
                {
                    ref: 'artifact:ambiguous',
                    digest: `sha256:${'a'.repeat(64)}`,
                },
            ],
            verificationRefs: [],
            issueClassification: 'external-ambiguity',
        });

        expect(report.goal.state).toBe('unknown-outcome');
        expect(report.workUnit.state).toBe('unknown-outcome');
        expect(report.attempt.state).toBe('unknown-outcome');
    });

    test.each([
        ['credentials', 'awaiting-decision'],
        ['permission', 'awaiting-decision'],
        ['dependency', 'blocked'],
        ['budget', 'blocked'],
        ['contradictory-criteria', 'needs-replan'],
    ] as const)(
        'applies %s precedence to a nominal completed outcome',
        async (issue, expectedState) => {
            const path = await databasePath();
            const store = open(path);
            executingGoal(store, `Completed with ${issue}`);
            const attempt = store.claimNextWork('worker', 60_000)!;

            const report = store.reportOutcome({
                schemaVersion: SCHEMA_VERSION,
                attemptId: attempt.id,
                leaseToken: attempt.leaseToken,
                status: 'completed',
                summary: `Completion still reported ${issue}.`,
                evidenceRefs: [
                    {
                        ref: `artifact:${issue}`,
                        digest: `sha256:${'a'.repeat(64)}`,
                    },
                ],
                verificationRefs: [],
                issueClassification: issue,
            });

            expect(report.goal.state).toBe(expectedState);
            expect(report.workUnit.state).toBe('failed');
            expect(report.attempt.state).toBe('failed');
        },
    );

    test('requires blocked-resume scope before retrying blocked work', async () => {
        const path = await databasePath();
        const store = open(path);
        const goal = executingGoal(store);
        const attempt = store.claimNextWork('worker', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            status: 'blocked',
            summary: 'A dependency is unavailable.',
            evidenceRefs: [],
            verificationRefs: [],
            issueClassification: 'dependency',
        });
        const wrongScope = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'resume' },
            'operator',
            'Wrong scope',
            60_000,
        );
        expect(() => store.resumeGoal(goal.id, wrongScope.token)).toThrow(
            'wrong scope',
        );
        const approval = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'blocked-resume' },
            'operator',
            'Dependency is restored',
            60_000,
        );
        expect(store.resumeGoal(goal.id, approval.token).state).toBe(
            'executing',
        );
        expect(store.claimNextWork('worker-2', 60_000)?.number).toBe(2);
    });

    test('replans after three unchanged failure fingerprints', async () => {
        const path = await databasePath();
        const store = open(path);
        const goal = executingGoal(store);
        for (let number = 1; number <= 3; number += 1) {
            const attempt = store.claimNextWork(`worker-${number}`, 60_000)!;
            const report = store.reportOutcome({
                schemaVersion: SCHEMA_VERSION,
                attemptId: attempt.id,
                leaseToken: attempt.leaseToken,
                status: 'failed',
                summary: `Failure ${number}`,
                evidenceRefs: [],
                verificationRefs: [],
                failureFingerprint: 'failure://same',
                issueClassification: 'other',
            });
            expect(report.attempt.number).toBe(number);
        }
        expect(store.get(goal.id)?.state).toBe('needs-replan');
        expect(store.claimNextWork('worker-4', 60_000)).toBeUndefined();
    });

    test('replans after two unchanged material changes without improvement', async () => {
        const path = await databasePath();
        const store = open(path);
        const goal = executingGoal(store);
        const materialDigest = `sha256:${'f'.repeat(64)}` as const;
        for (let number = 1; number <= 2; number += 1) {
            const attempt = store.claimNextWork(`worker-${number}`, 60_000)!;
            store.reportOutcome({
                schemaVersion: SCHEMA_VERSION,
                attemptId: attempt.id,
                leaseToken: attempt.leaseToken,
                status: 'failed',
                summary: `No improvement ${number}`,
                evidenceRefs: [],
                verificationRefs: [],
                materialChangeDigest: materialDigest,
                issueClassification: 'verification',
            });
        }
        expect(store.get(goal.id)?.state).toBe('needs-replan');
    });

    test('a durable verification improvement prevents unchanged-struggle escalation', async () => {
        const path = await databasePath();
        const store = open(path);
        const goal = store.create('/workspace', 'Improve verification');
        const plan = store.proposePlan(
            goal.id,
            simplePlan({
                verificationRequirements: [
                    {
                        id: 'check',
                        type: 'command',
                        executable: 'node',
                        args: ['--version'],
                        timeoutMs: 10_000,
                        outputCapBytes: 8_192,
                        required: true,
                    },
                ],
            }),
        );
        store.approvePlan(goal.id, plan.id, 'operator');
        const approval = store.issueApproval(
            goal.id,
            { type: 'goal-action', action: 'unattended-start' },
            'operator',
            'Start',
            60_000,
        );
        store.startGoal(goal.id, approval.token);
        const materialChangeDigest = `sha256:${'f'.repeat(64)}` as const;
        const first = store.claimNextWork('worker-1', 60_000)!;
        store.recordVerificationResult(first.id, {
            requirementId: 'check',
            status: 'failed',
            summary: 'Check failed.',
            observed: { value: 2, unit: 'verification-status-rank' },
            evidenceRefs: [],
            startedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:01.000Z',
            runtimeStatus: 'failed',
            outputDigest: `sha256:${'1'.repeat(64)}`,
        });
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: first.id,
            leaseToken: first.leaseToken,
            status: 'failed',
            summary: 'First attempt failed.',
            evidenceRefs: [],
            verificationRefs: [],
            materialChangeDigest,
            issueClassification: 'verification',
        });

        const second = store.claimNextWork('worker-2', 60_000)!;
        expect(store.getVerificationBaseline(second.id, 'check')).toEqual({
            status: 'failed',
            outputDigest: '1'.repeat(64),
        });
        store.recordVerificationResult(second.id, {
            requirementId: 'check',
            status: 'passed',
            summary: 'Check improved to passing.',
            baseline: { value: 2, unit: 'verification-status-rank' },
            observed: { value: 3, unit: 'verification-status-rank' },
            improvement: { absolute: 1 },
            evidenceRefs: [],
            startedAt: '2026-01-01T00:00:02.000Z',
            completedAt: '2026-01-01T00:00:03.000Z',
            runtimeStatus: 'passed',
            outputDigest: `sha256:${'2'.repeat(64)}`,
        });
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: second.id,
            leaseToken: second.leaseToken,
            status: 'failed',
            summary: 'Another non-verification failure.',
            evidenceRefs: [],
            verificationRefs: [],
            materialChangeDigest,
            issueClassification: 'verification',
        });

        expect(store.get(goal.id)?.state).toBe('executing');
        expect(
            store.events(goal.id).at(-1)?.payload.unchangedWithoutImprovement,
        ).toBe(1);
    });

    test.each([
        ['credentials', 'awaiting-decision'],
        ['permission', 'awaiting-decision'],
        ['dependency', 'blocked'],
        ['budget', 'blocked'],
        ['external-ambiguity', 'unknown-outcome'],
    ] as const)('maps %s failures to %s', async (issue, expectedState) => {
        const path = await databasePath();
        const store = open(path);
        const goal = executingGoal(store, issue);
        const attempt = store.claimNextWork('worker', 60_000)!;
        store.reportOutcome({
            schemaVersion: SCHEMA_VERSION,
            attemptId: attempt.id,
            leaseToken: attempt.leaseToken,
            status: 'failed',
            summary: `Classified as ${issue}`,
            evidenceRefs: [],
            verificationRefs: [],
            issueClassification: issue,
        });
        expect(store.get(goal.id)?.state).toBe(expectedState);
        expect(store.claimNextWork('another-worker', 60_000)).toBeUndefined();
    });
});
