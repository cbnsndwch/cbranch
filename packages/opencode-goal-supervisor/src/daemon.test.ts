import {
    access,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
    acquireWorkspaceLock,
    runGoalDaemon,
    workspaceLockRecoveryPath,
    WorkspaceLockedError,
} from './daemon.js';
import { GoalStore, type PlanInput } from './store.js';
import {
    BeforeExternalSideEffectError,
    GoalSupervisor,
    type GoalSessionAdapter,
} from './supervisor.js';

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
    const workspace = await mkdtemp(join(tmpdir(), 'goal-daemon-'));
    directories.push(workspace);
    return workspace;
};

const openStore = (workspace: string): GoalStore => {
    const store = new GoalStore(join(workspace, 'goal.db'));
    stores.push(store);
    return store;
};

const fakeAdapter = (
    overrides: Partial<GoalSessionAdapter> = {},
): GoalSessionAdapter => ({
    async dispatch(input) {
        return { externalRef: `opencode-session:${input.command.attemptId}` };
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

const startParallelGoal = (
    store: GoalStore,
    workspace: string,
    unitCount: number,
): void => {
    const goal = store.create(workspace, 'Run parallel units');
    const units: PlanInput['units'] = Array.from(
        { length: unitCount },
        (_, index) => ({
            id: `unit-${index}`,
            title: `Unit ${index}`,
            instructions: 'Complete the unit.',
            dependencyIds: [],
            acceptanceCriteria: ['Must complete'],
        }),
    );
    const plan = store.proposePlan(goal.id, {
        authoredBy: 'planner',
        units,
        finalVerificationRequirements: [],
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
};

describe('workspace daemon lock', () => {
    test('rejects a second live owner and releases the original lock', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        const first = acquireWorkspaceLock(path, workspace);

        expect(() => acquireWorkspaceLock(path, workspace)).toThrow(
            WorkspaceLockedError,
        );
        first.release();
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('replaces a stale PID but never deletes another owner token', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        await writeFile(
            path,
            `${JSON.stringify({
                pid: 2_147_483_647,
                token: 'stale-token',
                workspace,
                createdAt: '2026-01-01T00:00:00.000Z',
            })}\n`,
            { mode: 0o600 },
        );
        const lock = acquireWorkspaceLock(path, workspace);
        expect(JSON.parse(await readFile(path, 'utf8')).token).toBe(
            lock.owner.token,
        );
        await writeFile(
            path,
            `${JSON.stringify({
                ...lock.owner,
                token: 'replacement-token',
            })}\n`,
        );

        lock.release();
        expect(JSON.parse(await readFile(path, 'utf8')).token).toBe(
            'replacement-token',
        );
    });

    test('treats a fresh incomplete lock as held but replaces a stale one', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        await writeFile(path, '', { mode: 0o600 });

        expect(() => acquireWorkspaceLock(path, workspace)).toThrow(
            WorkspaceLockedError,
        );
        expect(await readFile(path, 'utf8')).toBe('');

        const stale = new Date(Date.now() - 10_000);
        await utimes(path, stale, stale);
        const lock = acquireWorkspaceLock(path, workspace);
        expect(JSON.parse(await readFile(path, 'utf8')).token).toBe(
            lock.owner.token,
        );
        lock.release();
    });

    test('serializes stale-lock replacement with a recovery guard', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        const staleOwner = `${JSON.stringify({
            pid: 2_147_483_647,
            token: 'stale-token',
            workspace,
            createdAt: '2026-01-01T00:00:00.000Z',
        })}\n`;
        await writeFile(path, staleOwner, { mode: 0o600 });
        const recoveryPath = workspaceLockRecoveryPath(path);
        await writeFile(recoveryPath, 'recovery in progress', { mode: 0o600 });

        expect(() => acquireWorkspaceLock(path, workspace)).toThrow(
            WorkspaceLockedError,
        );
        expect(await readFile(path, 'utf8')).toBe(staleOwner);
        await rm(recoveryPath);

        const lock = acquireWorkspaceLock(path, workspace);
        expect(JSON.parse(await readFile(path, 'utf8')).token).toBe(
            lock.owner.token,
        );
        lock.release();
    });
});

describe('Effect goal daemon', () => {
    test('runs startup, interrupts loops, checkpoints, closes, and unlocks', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const lockPath = join(workspace, 'daemon.lock');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('test shutdown'), 20);

        await runGoalDaemon({
            workspace,
            store,
            adapter: fakeAdapter(),
            lockPath,
            signal: controller.signal,
            handleSignals: false,
            dispatchIntervalMs: 2,
            reconciliationIntervalMs: 2,
            cancellationIntervalMs: 2,
            observationRestartIntervalMs: 2,
            globalConcurrency: 2,
            workspaceConcurrency: 1,
        });
        clearTimeout(timeout);

        expect(() => store.list(workspace)).toThrow();
        await expect(access(lockPath)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    test('fails startup while another process owns the workspace lock', async () => {
        const workspace = await workspaceFor();
        const lockPath = join(workspace, 'daemon.lock');
        const lock = acquireWorkspaceLock(lockPath, workspace);
        const store = openStore(workspace);

        await expect(
            runGoalDaemon({
                workspace,
                store,
                adapter: fakeAdapter(),
                lockPath,
                handleSignals: false,
            }),
        ).rejects.toThrow('Could not acquire the workspace daemon lock');
        expect(store.list(workspace)).toEqual([]);
        lock.release();
    });

    test('bounds work claims and dispatch concurrency per workspace', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        startParallelGoal(store, workspace, 4);
        const controller = new AbortController();
        let calls = 0;
        let active = 0;
        let maximum = 0;

        await runGoalDaemon({
            workspace,
            store,
            adapter: fakeAdapter({
                async dispatch(input) {
                    calls++;
                    active++;
                    maximum = Math.max(maximum, active);
                    await new Promise(resolve => setTimeout(resolve, 5));
                    active--;
                    if (calls === 2) controller.abort('enough work observed');
                    return {
                        externalRef: `opencode-session:${input.command.attemptId}`,
                    };
                },
            }),
            signal: controller.signal,
            handleSignals: false,
            dispatchIntervalMs: 1,
            reconciliationIntervalMs: 2,
            cancellationIntervalMs: 2,
            observationRestartIntervalMs: 2,
            dispatchBatchSize: 10,
            dispatchConcurrency: 2,
            globalConcurrency: 2,
            workspaceConcurrency: 2,
        });

        expect(calls).toBe(2);
        expect(maximum).toBeLessThanOrEqual(2);
    });

    test('processes durable cancellation during startup before scheduling', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        startParallelGoal(store, workspace, 1);
        const attempt = store.claimNextWork('worker', 60_000)!;
        await new GoalSupervisor(store, fakeAdapter()).dispatchPending(1);
        const unit = store.getWorkUnit(attempt.workUnitId)!;
        store.cancelGoal(unit.goalId, 'Stop before daemon startup');
        const controller = new AbortController();
        let aborts = 0;

        await runGoalDaemon({
            workspace,
            store,
            adapter: fakeAdapter({
                async abort() {
                    aborts++;
                    controller.abort('cancellation observed');
                    return { aborted: true };
                },
            }),
            signal: controller.signal,
            handleSignals: false,
            dispatchIntervalMs: 1,
            reconciliationIntervalMs: 1,
            cancellationIntervalMs: 1,
            observationRestartIntervalMs: 1,
            globalConcurrency: 1,
            workspaceConcurrency: 1,
        });

        expect(aborts).toBe(1);
    });

    test('recovers a newly expired no-reference attempt while remaining live', async () => {
        let now = Date.parse('2026-01-01T00:00:00.000Z');
        const workspace = await workspaceFor();
        const store = new GoalStore(join(workspace, 'goal.db'), {
            clock: () => new Date(now),
        });
        stores.push(store);
        startParallelGoal(store, workspace, 1);
        const attempt = store.claimNextWork('worker', 20)!;
        let dispatchEntered!: () => void;
        const entered = new Promise<void>(resolve => {
            dispatchEntered = resolve;
        });
        const controller = new AbortController();
        const running = runGoalDaemon({
            workspace,
            store,
            adapter: fakeAdapter({
                async dispatch() {
                    dispatchEntered();
                    throw new BeforeExternalSideEffectError('not sent');
                },
            }),
            signal: controller.signal,
            handleSignals: false,
            attemptLeaseMs: 20,
            dispatchIntervalMs: 2,
            reconciliationIntervalMs: 2,
            cancellationIntervalMs: 2,
            observationRestartIntervalMs: 2,
            globalConcurrency: 1,
            workspaceConcurrency: 1,
        });
        await entered;
        await new Promise(resolve => setTimeout(resolve, 20));
        now += 21;
        const deadline = Date.now() + 1_000;
        while (store.getAttempt(attempt.id)?.state !== 'expired') {
            if (Date.now() >= deadline) {
                throw new Error(
                    'Live daemon did not recover the expired attempt.',
                );
            }
            // oxlint-disable-next-line eslint/no-await-in-loop
            await new Promise(resolve => setTimeout(resolve, 5));
        }

        expect(store.getAttempt(attempt.id)?.state).toBe('expired');
        expect(
            store.get(store.getWorkUnit(attempt.workUnitId)!.goalId)?.state,
        ).toBe('executing');
        controller.abort('recovery observed');
        await running;
    });

    test('bounds startup and shutdown when cancellation ignores abort signals', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        startParallelGoal(store, workspace, 1);
        const attempt = store.claimNextWork('worker', 60_000)!;
        await new GoalSupervisor(store, fakeAdapter()).dispatchPending(1);
        store.cancelGoal(
            store.getWorkUnit(attempt.workUnitId)!.goalId,
            'Stop before startup',
        );
        const controller = new AbortController();
        let abortEntered!: () => void;
        const entered = new Promise<void>(resolve => {
            abortEntered = resolve;
        });
        const lateRejects: ((error: Error) => void)[] = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown): void => {
            unhandled.push(error);
        };
        process.on('unhandledRejection', onUnhandled);
        const running = runGoalDaemon({
            workspace,
            store,
            adapter: fakeAdapter({
                async abort() {
                    abortEntered();
                    return await new Promise<never>((_resolve, reject) => {
                        lateRejects.push(reject);
                    });
                },
            }),
            signal: controller.signal,
            handleSignals: false,
            shutdownTimeoutMs: 30,
            onError: () => {},
        });
        await entered;
        controller.abort('caller shutdown');

        try {
            await expect(
                Promise.race([
                    running,
                    new Promise<never>((_resolve, reject) =>
                        setTimeout(
                            () => reject(new Error('daemon shutdown hung')),
                            500,
                        ),
                    ),
                ]),
            ).resolves.toBeUndefined();
            for (const reject of lateRejects) {
                reject(new Error('late adapter rejection'));
            }
            await new Promise(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            process.removeListener('unhandledRejection', onUnhandled);
        }
    });
});
