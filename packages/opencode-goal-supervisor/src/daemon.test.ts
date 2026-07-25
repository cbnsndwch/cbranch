import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
    acquireWorkspaceLock,
    runGoalDaemon,
    startGoalDaemon,
    workspaceLockRecoveryPath,
    workspaceReadinessPath,
    WorkspaceLockedError,
} from './daemon.js';
import { GoalStore, type PlanInput } from './store.js';
import {
    BeforeExternalSideEffectError,
    GoalSupervisor,
    type GoalSessionAdapter,
} from './supervisor.js';
import { inspectDaemonServiceStatus } from './systemd.js';

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
    test('stores an optional service identity without breaking legacy acquisition', async () => {
        const workspace = await workspaceFor();
        const legacyPath = join(workspace, 'legacy.lock');
        const identityPath = join(workspace, 'identity.lock');
        const serviceIdentity = `sha256:${'d'.repeat(64)}`;
        const legacy = acquireWorkspaceLock(legacyPath, workspace);
        const identified = acquireWorkspaceLock(
            identityPath,
            workspace,
            process.pid,
            serviceIdentity,
        );

        expect(
            JSON.parse(await readFile(legacyPath, 'utf8')),
        ).not.toHaveProperty('serviceIdentity');
        expect(
            JSON.parse(await readFile(identityPath, 'utf8')).serviceIdentity,
        ).toBe(serviceIdentity);
        expect(() => identified.markReady(`sha256:${'e'.repeat(64)}`)).toThrow(
            'does not match',
        );
        identified.markReady();
        expect(
            JSON.parse(await readFile(identified.readinessPath, 'utf8'))
                .serviceIdentity,
        ).toBe(serviceIdentity);

        legacy.release();
        identified.release();
    });

    test('removes its published lock when stale readiness cleanup fails', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        await mkdir(workspaceReadinessPath(path));

        expect(() => acquireWorkspaceLock(path, workspace)).toThrow();

        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('keeps markReady failures owned and releases the lock after cleanup', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        const lock = acquireWorkspaceLock(path, workspace);
        await mkdir(lock.readinessPath);

        expect(() => lock.markReady()).toThrow();
        await expect(access(path)).resolves.toBeUndefined();

        await rm(lock.readinessPath, { recursive: true });
        lock.release();
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('releases the owner lock even when readiness cleanup fails', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        const lock = acquireWorkspaceLock(path, workspace);
        lock.markReady();
        await rm(lock.readinessPath);
        await mkdir(lock.readinessPath);

        expect(() => lock.release()).toThrow();

        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('rejects a second live owner and releases the original lock', async () => {
        const workspace = await workspaceFor();
        const path = join(workspace, 'daemon.lock');
        const first = acquireWorkspaceLock(path, workspace);

        expect(() => acquireWorkspaceLock(path, workspace)).toThrow(
            WorkspaceLockedError,
        );
        first.markReady();
        expect(
            JSON.parse(await readFile(first.readinessPath, 'utf8')).token,
        ).toBe(first.owner.token);
        first.release();
        await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(
            access(workspaceReadinessPath(path)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
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
        await writeFile(
            workspaceReadinessPath(path),
            `${JSON.stringify({
                token: 'stale-token',
                readyAt: '2026-01-01T00:00:00.000Z',
            })}\n`,
            { mode: 0o600 },
        );
        const lock = acquireWorkspaceLock(path, workspace);
        expect(JSON.parse(await readFile(path, 'utf8')).token).toBe(
            lock.owner.token,
        );
        await expect(
            access(workspaceReadinessPath(path)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
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
    test('publishes readiness only after startup reconciliation completes', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        startParallelGoal(store, workspace, 1);
        const attempt = store.claimNextWork('worker', 60_000)!;
        await new GoalSupervisor(store, fakeAdapter()).dispatchPending(1);
        store.cancelGoal(
            store.getWorkUnit(attempt.workUnitId)!.goalId,
            'Hold startup cancellation',
        );
        const lockPath = join(workspace, 'daemon.lock');
        const serviceIdentity = `sha256:${'a'.repeat(64)}`;
        const controller = new AbortController();
        let entered!: () => void;
        const startupEntered = new Promise<void>(resolve => {
            entered = resolve;
        });
        let release!: () => void;
        const releaseStartup = new Promise<void>(resolve => {
            release = resolve;
        });
        let ready!: () => void;
        const readyCalled = new Promise<void>(resolve => {
            ready = resolve;
        });
        const running = runGoalDaemon({
            workspace,
            store,
            lockPath,
            handleSignals: false,
            signal: controller.signal,
            adapter: fakeAdapter({
                async abort() {
                    entered();
                    await releaseStartup;
                    return { aborted: true };
                },
            }),
            onReady: ready,
            serviceIdentity,
        });
        await startupEntered;

        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace,
                isPidAlive: () => true,
            }),
        ).resolves.toMatchObject({
            status: 'running',
            ready: false,
            serviceIdentity,
        });
        await expect(
            access(workspaceReadinessPath(lockPath)),
        ).rejects.toMatchObject({ code: 'ENOENT' });

        release();
        await readyCalled;
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace,
                isPidAlive: () => true,
            }),
        ).resolves.toMatchObject({
            status: 'running',
            ready: true,
            serviceIdentity,
        });
        controller.abort('readiness observed');
        await running;
        await expect(
            access(workspaceReadinessPath(lockPath)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('removes lock and readiness state when startup reconciliation fails', async () => {
        const workspace = await workspaceFor();
        const store = openStore(workspace);
        const lockPath = join(workspace, 'daemon.lock');
        const onReady = vi.fn();
        vi.spyOn(store, 'startupReconcile').mockImplementation(() => {
            throw new Error('startup failed');
        });

        await expect(
            runGoalDaemon({
                workspace,
                store,
                lockPath,
                handleSignals: false,
                adapter: fakeAdapter(),
                onReady,
            }),
        ).rejects.toThrow('Startup reconciliation failed');

        expect(onReady).not.toHaveBeenCalled();
        await expect(access(lockPath)).rejects.toMatchObject({
            code: 'ENOENT',
        });
        await expect(
            access(workspaceReadinessPath(lockPath)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('reports readiness only after startup and resolves lock races without ownership', async () => {
        const workspace = await workspaceFor();
        const lockPath = join(workspace, 'daemon.lock');
        let readyCalls = 0;
        const handles = await Promise.all(
            Array.from({ length: 2 }, () =>
                startGoalDaemon({
                    workspace,
                    adapter: fakeAdapter(),
                    lockPath,
                    onReady: () => readyCalls++,
                }),
            ),
        );
        const owner = handles.find(handle => handle.owned);
        const contender = handles.find(handle => !handle.owned);

        expect(owner?.state).toBe('running');
        expect(contender?.state).toBe('contended');
        expect(readyCalls).toBe(1);
        if (!owner || !contender) throw new Error('Expected one daemon owner.');

        await contender.stop();
        await expect(access(lockPath)).resolves.toBeUndefined();
        await owner.stop();
        expect(owner.state).toBe('stopped');
        await expect(access(lockPath)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

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
