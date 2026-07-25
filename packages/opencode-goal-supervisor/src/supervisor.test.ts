import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { SCHEMA_VERSION, type AgentOutcome } from './domain.js';
import { GoalStore, type PlanInput } from './store.js';
import {
    BeforeExternalSideEffectError,
    GoalSupervisor,
    type GoalSessionAdapter,
    type SessionOutcomeRead,
} from './supervisor.js';
import type { VerificationResult } from './verification.js';

const directories: string[] = [];
const stores: GoalStore[] = [];

afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const workspaceFor = async (): Promise<string> => {
    const workspace = await mkdtemp(join(tmpdir(), 'goal-supervisor-runtime-'));
    directories.push(workspace);
    return workspace;
};

const openStore = (workspace: string, clock?: () => Date): GoalStore => {
    const store = new GoalStore(join(workspace, 'goal.db'), { clock });
    stores.push(store);
    return store;
};

const commandRequirement = (id: string, required = true) => ({
    id,
    type: 'command' as const,
    executable: 'node',
    args: ['--version'],
    timeoutMs: 10_000,
    outputCapBytes: 8_192,
    required,
});

const startGoal = (
    store: GoalStore,
    workspace: string,
    options: {
        readonly units?: PlanInput['units'];
        readonly finalVerificationRequirements?: PlanInput['finalVerificationRequirements'];
    } = {},
) => {
    const goal = store.create(workspace, 'Complete supervised work');
    const plan = store.proposePlan(goal.id, {
        authoredBy: 'planner',
        units: options.units ?? [
            {
                id: 'unit',
                title: 'Unit',
                instructions: 'Complete the unit.',
                dependencyIds: [],
                acceptanceCriteria: ['Must complete the unit'],
            },
        ],
        finalVerificationRequirements:
            options.finalVerificationRequirements ?? [],
    });
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

const fakeAdapter = (
    overrides: Partial<GoalSessionAdapter> = {},
): GoalSessionAdapter => ({
    async dispatch() {
        return { externalRef: 'opencode-session:session' };
    },
    async probe() {
        return { status: 'absent' };
    },
    async readOutcome() {
        return { status: 'active' };
    },
    async abort() {
        return { aborted: true };
    },
    async health() {
        return { healthy: true };
    },
    ...overrides,
});

const processVerification = (
    status: VerificationResult['status'] = 'passed',
): VerificationResult => ({
    id: 'verification',
    label: 'verification',
    status,
    exitCode: status === 'passed' ? 0 : 1,
    signal: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    stdout: status,
    stderr: '',
    outputDigest: 'a'.repeat(64),
    improvement: 'not-applicable',
});

const completedOutcome = (
    attemptId: string,
    leaseToken: string,
): AgentOutcome => ({
    schemaVersion: SCHEMA_VERSION,
    attemptId,
    leaseToken,
    status: 'completed',
    summary: 'Work completed.',
    evidenceRefs: [
        { ref: 'artifact:result', digest: `sha256:${'b'.repeat(64)}` },
    ],
    verificationRefs: [],
});

describe('GoalSupervisor dispatch', () => {
    test('delivers only a claimed command and records the external reference', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        const attempt = store.claimNextWork('worker', 60_000)!;
        const calls: string[] = [];
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch(input) {
                    calls.push(input.command.attemptId);
                    return { externalRef: 'opencode-session:created' };
                },
            }),
        );

        const result = await supervisor.dispatchPending(10);

        expect(result).toMatchObject({
            claimed: 1,
            dispatched: 1,
            delivered: 1,
            failed: 0,
        });
        expect(calls).toEqual([attempt.id]);
        expect(store.listSessionReferences(goal.id)[0]).toMatchObject({
            attemptId: attempt.id,
            externalRef: 'opencode-session:created',
        });
    });

    test('distinguishes explicit pre-side-effect errors from ambiguous crashes', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        const workspace = await workspaceFor();
        const store = openStore(workspace, () => new Date(now));
        startGoal(store, workspace);
        store.claimNextWork('worker', 60_000);
        const before = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch() {
                    throw new BeforeExternalSideEffectError(
                        'request was not sent',
                    );
                },
            }),
            { dispatcherLeaseMs: 1_000 },
        );

        expect(await before.dispatchPending(1)).toMatchObject({ failed: 1 });
        now += 1_001;
        const retry = store.claimOutbox(1, 1_000)[0]!;
        expect(retry.needsProbe).toBe(false);
        store.recordDispatchFailure(
            retry.id,
            retry.leaseToken,
            'release',
            false,
        );

        now += 2_001;
        const after = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch() {
                    throw new Error('connection reset');
                },
            }),
            { dispatcherLeaseMs: 1_000 },
        );
        expect(await after.dispatchPending(1)).toMatchObject({ failed: 1 });
        const ambiguous = store.claimOutbox(1, 1_000)[0]!;
        expect(ambiguous.needsProbe).toBe(true);
    });

    test.each(['absent', 'active', 'completed', 'unknown'] as const)(
        'records an expired-delivery %s probe without blind dispatch',
        async probeStatus => {
            const workspace = await workspaceFor();
            const store = openStore(workspace);
            const goal = startGoal(store, workspace);
            store.claimNextWork('worker', 60_000);
            const ambiguous = new GoalSupervisor(
                store,
                fakeAdapter({
                    async dispatch() {
                        throw new Error('ambiguous transport failure');
                    },
                }),
            );
            await ambiguous.dispatchPending(1);
            let dispatches = 0;
            const probing = new GoalSupervisor(
                store,
                fakeAdapter({
                    async probe() {
                        if (probeStatus === 'absent') {
                            return { status: 'absent' };
                        }
                        return {
                            status: probeStatus,
                            externalRef: 'opencode-session:existing',
                        };
                    },
                    async dispatch() {
                        dispatches++;
                        return { externalRef: 'opencode-session:new' };
                    },
                }),
            );

            const result = await probing.dispatchPending(1);

            expect(result.probed).toBe(1);
            expect(result[probeStatus]).toBe(1);
            expect(dispatches).toBe(0);
            if (probeStatus === 'unknown') {
                expect(store.get(goal.id)?.state).toBe('unknown-outcome');
            }
        },
    );

    test('treats a throwing probe as unknown outcome', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        store.claimNextWork('worker', 60_000);
        await new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch() {
                    throw new Error('ambiguous');
                },
            }),
        ).dispatchPending(1);

        const result = await new GoalSupervisor(
            store,
            fakeAdapter({
                async probe() {
                    throw new Error('probe unavailable');
                },
            }),
        ).dispatchPending(1);

        expect(result).toMatchObject({ probed: 1, unknown: 1, failed: 1 });
        expect(store.get(goal.id)?.state).toBe('unknown-outcome');
    });

    test('probes rather than redispatching after restart at an ambiguous boundary', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        const attempt = store.claimNextWork('worker', 60_000)!;
        let externalDispatches = 0;
        await new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch() {
                    externalDispatches++;
                    throw new Error('connection closed after request write');
                },
            }),
        ).dispatchPending(1);
        store.close();

        const reopened = openStore(workspace);
        const restarted = new GoalSupervisor(
            reopened,
            fakeAdapter({
                async probe() {
                    return {
                        status: 'active',
                        externalRef: 'opencode-session:survived-restart',
                    };
                },
                async dispatch() {
                    externalDispatches++;
                    return { externalRef: 'opencode-session:duplicate' };
                },
            }),
        );

        expect(await restarted.dispatchPending(1)).toMatchObject({
            probed: 1,
            active: 1,
            dispatched: 0,
        });
        expect(externalDispatches).toBe(1);
        expect(reopened.listSessionReferences(goal.id)).toEqual([
            expect.objectContaining({
                attemptId: attempt.id,
                externalRef: 'opencode-session:survived-restart',
            }),
        ]);
    });

    test('bounds concurrent dispatch calls', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        startGoal(store, workspace, {
            units: Array.from({ length: 4 }, (_, index) => ({
                id: `unit-${index}`,
                title: `Unit ${index}`,
                instructions: 'Complete it.',
                dependencyIds: [],
                acceptanceCriteria: ['Must complete'],
            })),
        });
        for (let index = 0; index < 4; index++) {
            store.claimNextWork(`worker-${index}`, 60_000);
        }
        let active = 0;
        let maximum = 0;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch(input) {
                    active++;
                    maximum = Math.max(maximum, active);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    active--;
                    return {
                        externalRef: `opencode-session:${input.command.attemptId}`,
                    };
                },
            }),
            { dispatchConcurrency: 2 },
        );

        expect((await supervisor.dispatchPending(10)).delivered).toBe(4);
        expect(maximum).toBe(2);
    });

    test('persists a dispatch reference returned after a pause fence', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        const attempt = store.claimNextWork('worker', 60_000)!;
        let dispatchEntered!: () => void;
        const entered = new Promise<void>(resolve => {
            dispatchEntered = resolve;
        });
        let finishDispatch!: (result: { readonly externalRef: string }) => void;
        const dispatched = new Promise<{ readonly externalRef: string }>(
            resolve => {
                finishDispatch = resolve;
            },
        );
        const aborted: string[] = [];
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch() {
                    dispatchEntered();
                    return await dispatched;
                },
                async abort(input) {
                    aborted.push(input.externalRef);
                    return { aborted: true };
                },
            }),
        );

        const pendingDispatch = supervisor.dispatchPending(1);
        await entered;
        store.pauseGoal(goal.id, 'Pause across dispatch boundary');
        expect(await supervisor.processCancellations()).toMatchObject({
            acknowledged: 1,
            aborted: 0,
        });
        expect(store.listCancellationRequests(goal.id)[0]?.state).toBe(
            'acknowledged',
        );
        finishDispatch({ externalRef: 'opencode-session:late' });

        expect(await pendingDispatch).toMatchObject({ failed: 1 });
        expect(store.listCancellationRequests(goal.id)[0]).toMatchObject({
            attemptId: attempt.id,
            state: 'pending',
            externalRef: 'opencode-session:late',
        });
        expect(await supervisor.processCancellations()).toMatchObject({
            aborted: 1,
            acknowledged: 1,
        });
        expect(aborted).toEqual(['opencode-session:late']);
    });
});

describe('GoalSupervisor reconciliation', () => {
    test('renews an inconclusive referenced session instead of retrying it', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        startGoal(store, workspace);
        const attempt = store.claimNextWork('worker', 60_000)!;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return {
                        status: 'unknown',
                        reason: 'No valid final outcome yet.',
                    };
                },
            }),
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            unknown: 1,
            renewed: 1,
            outcomesReported: 0,
        });
        expect(store.getAttempt(attempt.id)?.state).toBe('running');
    });

    test('settles a terminal malformed response as external ambiguity', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        const attempt = store.claimNextWork('worker', 60_000)!;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return {
                        status: 'terminal-unknown',
                        reason: 'Assistant response ended with malformed JSON.',
                    };
                },
            }),
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            unknown: 1,
            renewed: 0,
            outcomesReported: 1,
        });
        expect(store.get(goal.id)?.state).toBe('unknown-outcome');
        expect(store.getAttempt(attempt.id)?.state).toBe('unknown-outcome');
    });

    test('settles terminal completion without evidence as unknown once', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        const attempt = store.claimNextWork('worker', 60_000)!;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return {
                        status: 'completed',
                        outcome: {
                            ...completedOutcome(attempt.id, attempt.leaseToken),
                            evidenceRefs: [],
                        },
                    };
                },
            }),
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            completed: 1,
            unknown: 1,
            outcomesReported: 1,
        });
        expect(store.get(goal.id)?.state).toBe('unknown-outcome');
        expect((await supervisor.reconcileActive()).inspected).toBe(0);
    });

    test('does not let verification overwrite external ambiguity precedence', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace, {
            units: [
                {
                    id: 'unit',
                    title: 'Unit',
                    instructions: 'Complete it.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must complete'],
                    verificationRequirements: [commandRequirement('check')],
                },
            ],
        });
        const attempt = store.claimNextWork('worker', 60_000)!;
        let verifierCalls = 0;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return {
                        status: 'completed',
                        outcome: {
                            ...completedOutcome(attempt.id, attempt.leaseToken),
                            issueClassification: 'external-ambiguity',
                        },
                    };
                },
            }),
            {
                verificationRunner: async () => {
                    verifierCalls++;
                    return processVerification('failed');
                },
            },
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            outcomesReported: 1,
            verificationsRun: 0,
        });
        expect(verifierCalls).toBe(0);
        expect(store.get(goal.id)?.state).toBe('unknown-outcome');
    });

    test('heartbeats a short attempt lease through long verification', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace, {
            units: [
                {
                    id: 'unit',
                    title: 'Unit',
                    instructions: 'Complete it.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must complete'],
                    verificationRequirements: [commandRequirement('check')],
                },
            ],
        });
        const attempt = store.claimNextWork('worker', 60_000)!;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return {
                        status: 'completed',
                        outcome: completedOutcome(
                            attempt.id,
                            attempt.leaseToken,
                        ),
                    };
                },
            }),
            {
                attemptLeaseMs: 500,
                verificationRunner: async () => {
                    await new Promise(resolve => setTimeout(resolve, 1_700));
                    return processVerification();
                },
            },
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            outcomesReported: 1,
            verificationsRun: 1,
            goalsFinalized: 1,
        });
        expect(store.get(goal.id)?.state).toBe('achieved');
    });

    test('renews active sessions and reports a verified structured outcome once', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace, {
            units: [
                {
                    id: 'unit',
                    title: 'Unit',
                    instructions: 'Complete it.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must complete'],
                    verificationRequirements: [commandRequirement('check')],
                },
            ],
            finalVerificationRequirements: [commandRequirement('final')],
        });
        const attempt = store.claimNextWork('worker', 60_000)!;
        let read: SessionOutcomeRead = { status: 'active' };
        let verifierCalls = 0;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return read;
                },
            }),
            {
                verificationRunner: async () => {
                    verifierCalls++;
                    return processVerification();
                },
            },
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            active: 1,
            renewed: 1,
        });
        read = {
            status: 'completed',
            outcome: completedOutcome(attempt.id, attempt.leaseToken),
            transcriptRef: 'opencode-transcript:session',
        };
        const settled = await supervisor.reconcileActive();

        expect(settled).toMatchObject({
            completed: 1,
            outcomesReported: 1,
            verificationsRun: 1,
            finalVerificationsRun: 1,
            goalsFinalized: 1,
        });
        expect(verifierCalls).toBe(2);
        expect(store.get(goal.id)?.state).toBe('achieved');
        expect((await supervisor.reconcileActive()).outcomesReported).toBe(0);
    });

    test('converts completion to verification-class failure', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace, {
            units: [
                {
                    id: 'unit',
                    title: 'Unit',
                    instructions: 'Complete it.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must complete'],
                    verificationRequirements: [commandRequirement('check')],
                },
            ],
        });
        const attempt = store.claimNextWork('worker', 60_000)!;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async readOutcome() {
                    return {
                        status: 'completed',
                        outcome: completedOutcome(
                            attempt.id,
                            attempt.leaseToken,
                        ),
                        transcriptRef: 'opencode-transcript:session',
                    };
                },
            }),
            { verificationRunner: async () => processVerification('failed') },
        );
        await supervisor.dispatchPending(1);

        expect(await supervisor.reconcileActive()).toMatchObject({
            outcomesReported: 1,
            verificationsRun: 1,
        });
        expect(store.getAttempt(attempt.id)?.state).toBe('failed');
        expect(store.listWorkUnits(goal.id, true)[0]?.state).toBe('queued');
        expect(
            store
                .events(goal.id)
                .find(event => event.type === 'outcome.reported')?.payload
                .issueClassification,
        ).toBe('verification');
    });

    test('passes a durable prior verification baseline into the next attempt', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace, {
            units: [
                {
                    id: 'unit',
                    title: 'Unit',
                    instructions: 'Complete it.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must complete'],
                    verificationRequirements: [commandRequirement('check')],
                },
            ],
        });
        const baselines: VerificationResult['baseline'][] = [];
        let verificationCall = 0;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch(input) {
                    return {
                        externalRef: `opencode-session:${input.command.attemptId}`,
                    };
                },
                async readOutcome(input) {
                    return {
                        status: 'completed',
                        outcome: completedOutcome(
                            input.attemptId,
                            input.leaseToken,
                        ),
                    };
                },
            }),
            {
                verificationRunner: async (_root, input) => {
                    baselines.push(input.baseline);
                    verificationCall++;
                    const result = processVerification(
                        verificationCall === 1 ? 'failed' : 'passed',
                    );
                    return {
                        ...result,
                        baseline: input.baseline,
                        improvement: input.baseline
                            ? 'improved'
                            : 'not-applicable',
                    };
                },
            },
        );
        store.claimNextWork('worker-1', 60_000);
        await supervisor.dispatchPending(1);
        await supervisor.reconcileActive();
        store.claimNextWork('worker-2', 60_000);
        await supervisor.dispatchPending(1);
        await supervisor.reconcileActive();

        expect(baselines).toEqual([
            undefined,
            {
                status: 'failed',
                exitCode: 1,
                outputDigest: 'a'.repeat(64),
            },
        ]);
        expect(store.get(goal.id)?.state).toBe('achieved');
    });

    test('aborts durable cancellation requests and does no work after pause', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        store.claimNextWork('worker', 60_000);
        let aborts = 0;
        let dispatches = 0;
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch() {
                    dispatches++;
                    return { externalRef: 'opencode-session:cancel' };
                },
                async abort() {
                    aborts++;
                    return { aborted: true };
                },
            }),
        );
        await supervisor.dispatchPending(1);
        store.pauseGoal(goal.id, 'Operator pause');

        expect(await supervisor.processCancellations()).toMatchObject({
            pending: 1,
            aborted: 1,
            acknowledged: 1,
        });
        expect((await supervisor.dispatchPending(10)).claimed).toBe(0);
        expect(dispatches).toBe(1);
        expect(aborts).toBe(1);
    });

    test('probes missing cancellation refs and keeps ambiguity pending', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        store.claimNextWork('worker', 60_000);
        const dispatch = store.claimOutbox(1, 60_000)[0]!;
        store.markDispatchStarted(dispatch.id, dispatch.leaseToken);
        store.pauseGoal(goal.id, 'Pause before reference persistence');
        let probe: 'throw' | 'unknown' | 'active' = 'throw';
        const aborted: string[] = [];
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async probe() {
                    if (probe === 'throw') {
                        throw new Error('probe transport unavailable');
                    }
                    return probe === 'unknown'
                        ? { status: 'unknown' }
                        : {
                              status: 'active',
                              externalRef: 'opencode-session:found',
                          };
                },
                async abort(input) {
                    aborted.push(input.externalRef);
                    return { aborted: true };
                },
            }),
        );

        expect(await supervisor.processCancellations()).toMatchObject({
            pending: 1,
            failed: 1,
            acknowledged: 0,
        });
        expect(store.listCancellationRequests(goal.id)[0]).toMatchObject({
            state: 'pending',
            lastError: expect.stringContaining('transport unavailable'),
        });
        probe = 'unknown';
        expect(await supervisor.processCancellations()).toMatchObject({
            pending: 1,
            failed: 1,
            acknowledged: 0,
        });
        expect(store.listCancellationRequests(goal.id)[0]).toMatchObject({
            state: 'pending',
            lastError: expect.stringContaining('inconclusive'),
        });
        probe = 'active';
        expect(await supervisor.processCancellations()).toMatchObject({
            aborted: 1,
            acknowledged: 1,
        });
        expect(aborted).toEqual(['opencode-session:found']);
    });

    test('aborts an optional residual session after achievement', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace, {
            units: [
                {
                    id: 'required',
                    title: 'Required',
                    instructions: 'Complete required work.',
                    dependencyIds: [],
                    acceptanceCriteria: ['Must complete'],
                    required: true,
                },
                {
                    id: 'optional',
                    title: 'Optional',
                    instructions: 'Complete optional work.',
                    dependencyIds: [],
                    acceptanceCriteria: ['May complete'],
                    required: false,
                },
            ],
        });
        const first = store.claimNextWork('first-worker', 60_000)!;
        const second = store.claimNextWork('second-worker', 60_000)!;
        const required =
            store.getWorkUnit(first.workUnitId)?.planUnitId === 'required'
                ? first
                : second;
        const optional = required.id === first.id ? second : first;
        const aborted: string[] = [];
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async dispatch(input) {
                    return {
                        externalRef: `opencode-session:${input.command.attemptId}`,
                    };
                },
                async readOutcome(input) {
                    return input.attemptId === required.id
                        ? {
                              status: 'completed',
                              outcome: completedOutcome(
                                  required.id,
                                  required.leaseToken,
                              ),
                          }
                        : { status: 'active' };
                },
                async abort(input) {
                    aborted.push(input.externalRef);
                    return { aborted: true };
                },
            }),
            { dispatchConcurrency: 2, reconciliationConcurrency: 2 },
        );
        await supervisor.dispatchPending(2);

        expect(await supervisor.reconcileActive()).toMatchObject({
            outcomesReported: 1,
            goalsFinalized: 1,
        });
        expect(store.get(goal.id)?.state).toBe('achieved');
        expect(store.listCancellationRequests(goal.id)).toEqual([
            expect.objectContaining({
                attemptId: optional.id,
                state: 'pending',
                externalRef: `opencode-session:${optional.id}`,
            }),
        ]);
        expect(await supervisor.processCancellations()).toMatchObject({
            aborted: 1,
            acknowledged: 1,
        });
        expect(aborted).toEqual([`opencode-session:${optional.id}`]);
    });

    test('deduplicates normalized adapter observations', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const goal = startGoal(store, workspace);
        store.claimNextWork('worker', 60_000);
        const observation = {
            externalRef: 'opencode-session:session',
            kind: 'status' as const,
            summary: 'OpenCode session emitted idle status.',
            deduplicationKey: 'opencode-event:duplicate',
            data: { schedulerAction: false },
        };
        const supervisor = new GoalSupervisor(
            store,
            fakeAdapter({
                async *observe() {
                    yield observation;
                    yield observation;
                },
            }),
        );
        await supervisor.dispatchPending(1);

        await supervisor.observeAdapter(new AbortController().signal);

        expect(
            store
                .events(goal.id)
                .filter(event => event.type === 'observation.recorded'),
        ).toHaveLength(1);
        expect(store.listActiveAttempts()).toHaveLength(1);
    });
});
