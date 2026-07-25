import { randomUUID } from 'node:crypto';
import {
    closeSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Effect, Semaphore, type Scope } from 'effect';

import { DomainIdSchema } from './domain.js';
import { GoalStore } from './store.js';
import {
    GoalSupervisor,
    type GoalSessionAdapter,
    type GoalSupervisorOptions,
} from './supervisor.js';

export interface GoalDaemonOptions extends GoalSupervisorOptions {
    readonly workspace: string;
    readonly adapter: GoalSessionAdapter;
    readonly store?: GoalStore;
    readonly storeFactory?: () => GoalStore;
    readonly databasePath?: string;
    readonly lockPath?: string;
    readonly owner?: string;
    readonly dispatchIntervalMs?: number;
    readonly reconciliationIntervalMs?: number;
    readonly cancellationIntervalMs?: number;
    readonly observationRestartIntervalMs?: number;
    readonly shutdownTimeoutMs?: number;
    readonly dispatchBatchSize?: number;
    readonly reconciliationBatchSize?: number;
    readonly cancellationBatchSize?: number;
    readonly globalConcurrency?: number;
    readonly workspaceConcurrency?: number;
    readonly signal?: AbortSignal;
    readonly onError?: (error: Error) => void;
}

export interface RunGoalDaemonOptions extends GoalDaemonOptions {
    readonly handleSignals?: boolean;
}

type ValidatedDaemonOptions = GoalDaemonOptions & {
    readonly workspace: string;
    readonly lockPath: string;
    readonly owner: string;
    readonly dispatchIntervalMs: number;
    readonly reconciliationIntervalMs: number;
    readonly cancellationIntervalMs: number;
    readonly observationRestartIntervalMs: number;
    readonly shutdownTimeoutMs: number;
    readonly dispatchBatchSize: number;
    readonly reconciliationBatchSize: number;
    readonly cancellationBatchSize: number;
    readonly globalConcurrency: number;
    readonly workspaceConcurrency: number;
    readonly attemptLeaseMs: number;
};

type WorkspaceLockOwner = {
    readonly pid: number;
    readonly token: string;
    readonly workspace: string;
    readonly createdAt: string;
};

const INCOMPLETE_LOCK_FRESHNESS_MS = 5_000;

export const workspaceLockRecoveryPath = (path: string): string =>
    `${resolve(path)}.recovery`;

export interface WorkspaceLock {
    readonly path: string;
    readonly owner: WorkspaceLockOwner;
    readonly release: () => void;
}

export class WorkspaceLockedError extends Error {
    constructor(path: string, pid?: number) {
        super(
            pid === undefined
                ? `Workspace daemon lock is held at ${path}.`
                : `Workspace daemon lock is held by PID ${pid} at ${path}.`,
        );
        this.name = 'WorkspaceLockedError';
    }
}

export class GoalDaemonError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'GoalDaemonError';
    }
}

const errorCode = (error: unknown): string | undefined =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
        ? error.code
        : undefined;

const processIsAlive = (pid: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
};

const parseLockOwner = (text: string): WorkspaceLockOwner | undefined => {
    try {
        const value = JSON.parse(text) as Partial<WorkspaceLockOwner>;
        if (
            !Number.isSafeInteger(value.pid) ||
            Number(value.pid) <= 0 ||
            typeof value.token !== 'string' ||
            !value.token ||
            typeof value.workspace !== 'string' ||
            !value.workspace ||
            typeof value.createdAt !== 'string' ||
            Number.isNaN(Date.parse(value.createdAt))
        ) {
            return undefined;
        }
        return value as WorkspaceLockOwner;
    } catch {
        return undefined;
    }
};

const removeLockIfUnchanged = (path: string, expected: string): boolean => {
    let before;
    try {
        before = statSync(path);
        if (readFileSync(path, 'utf8') !== expected) return false;
        const after = statSync(path);
        if (before.dev !== after.dev || before.ino !== after.ino) return false;
        unlinkSync(path);
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
};

const publishLockOwner = (
    path: string,
    owner: WorkspaceLockOwner,
    serialized: string,
): void => {
    const candidatePath = `${path}.${owner.token}.candidate`;
    let file: number | undefined;
    try {
        file = openSync(candidatePath, 'wx', 0o600);
        writeFileSync(file, serialized, { encoding: 'utf8' });
        closeSync(file);
        file = undefined;
        // A hard link publishes only the fully written inode and fails if a
        // competing owner already published the lock path.
        linkSync(candidatePath, path);
    } finally {
        if (file !== undefined) closeSync(file);
        try {
            unlinkSync(candidatePath);
        } catch {
            // A uniquely named abandoned candidate never owns the lock path.
        }
    }
};

const workspaceLock = (
    path: string,
    owner: WorkspaceLockOwner,
): WorkspaceLock => {
    let released = false;
    return {
        path,
        owner,
        release: () => {
            if (released) return;
            released = true;
            try {
                const current = readFileSync(path, 'utf8');
                const currentOwner = parseLockOwner(current);
                if (currentOwner?.token !== owner.token) return;
                removeLockIfUnchanged(path, current);
            } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error;
            }
        },
    };
};

const recoveryInProgress = (path: string): boolean => {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
};

/** Acquire an owner-token lock and remove only the same token on release. */
export const acquireWorkspaceLock = (
    path: string,
    workspace: string,
    pid = process.pid,
): WorkspaceLock => {
    const absolutePath = resolve(path);
    const absoluteWorkspace = resolve(workspace);
    const recoveryPath = workspaceLockRecoveryPath(absolutePath);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 3; attempt++) {
        const owner: WorkspaceLockOwner = {
            pid,
            token: randomUUID(),
            workspace: absoluteWorkspace,
            createdAt: new Date().toISOString(),
        };
        const serialized = `${JSON.stringify(owner)}\n`;
        if (recoveryInProgress(recoveryPath)) {
            throw new WorkspaceLockedError(absolutePath);
        }
        try {
            publishLockOwner(absolutePath, owner, serialized);
            return workspaceLock(absolutePath, owner);
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            let recoveryFile: number | undefined;
            try {
                recoveryFile = openSync(recoveryPath, 'wx', 0o600);
            } catch (recoveryError) {
                if (errorCode(recoveryError) === 'EEXIST') {
                    throw new WorkspaceLockedError(absolutePath);
                }
                throw recoveryError;
            }
            try {
                let existingText: string;
                try {
                    existingText = readFileSync(absolutePath, 'utf8');
                } catch (readError) {
                    if (errorCode(readError) === 'ENOENT') {
                        publishLockOwner(absolutePath, owner, serialized);
                        return workspaceLock(absolutePath, owner);
                    }
                    throw readError;
                }
                const existing = parseLockOwner(existingText);
                if (existing && processIsAlive(existing.pid)) {
                    throw new WorkspaceLockedError(absolutePath, existing.pid);
                }
                if (!existing) {
                    let modifiedAt: number;
                    try {
                        modifiedAt = statSync(absolutePath).mtimeMs;
                    } catch (statError) {
                        if (errorCode(statError) === 'ENOENT') continue;
                        throw statError;
                    }
                    if (
                        Date.now() - modifiedAt <
                        INCOMPLETE_LOCK_FRESHNESS_MS
                    ) {
                        throw new WorkspaceLockedError(absolutePath);
                    }
                }
                if (!removeLockIfUnchanged(absolutePath, existingText)) {
                    continue;
                }
                try {
                    publishLockOwner(absolutePath, owner, serialized);
                    return workspaceLock(absolutePath, owner);
                } catch (publishError) {
                    if (errorCode(publishError) !== 'EEXIST') {
                        throw publishError;
                    }
                }
            } finally {
                if (recoveryFile !== undefined) closeSync(recoveryFile);
                try {
                    unlinkSync(recoveryPath);
                } catch {
                    // A leftover guard makes doctor fail closed for inspection.
                }
            }
        }
    }
    throw new WorkspaceLockedError(resolve(path));
};

const integerOption = (
    value: number | undefined,
    fallback: number,
    name: string,
    maximum = 24 * 60 * 60_000,
): number => {
    const resolved = value ?? fallback;
    if (
        !Number.isSafeInteger(resolved) ||
        resolved <= 0 ||
        resolved > maximum
    ) {
        throw new RangeError(
            `${name} must be an integer from 1 through ${maximum}.`,
        );
    }
    return resolved;
};

const validateOptions = (
    options: GoalDaemonOptions,
): ValidatedDaemonOptions => {
    if (!options.workspace.trim()) {
        throw new TypeError('workspace must be nonempty.');
    }
    const workspace = resolve(options.workspace);
    const owner = DomainIdSchema.parse(
        options.owner ?? `daemon-${process.pid}`,
    );
    const globalConcurrency = integerOption(
        options.globalConcurrency,
        4,
        'globalConcurrency',
        1_000,
    );
    const workspaceConcurrency = integerOption(
        options.workspaceConcurrency,
        2,
        'workspaceConcurrency',
        1_000,
    );
    if (workspaceConcurrency > globalConcurrency) {
        throw new RangeError(
            'workspaceConcurrency may not exceed globalConcurrency.',
        );
    }
    return {
        ...options,
        workspace,
        lockPath: resolve(
            options.lockPath ??
                join(workspace, '.opencode', 'goal-supervisor', 'daemon.lock'),
        ),
        owner,
        dispatchIntervalMs: integerOption(
            options.dispatchIntervalMs,
            1_000,
            'dispatchIntervalMs',
        ),
        reconciliationIntervalMs: integerOption(
            options.reconciliationIntervalMs,
            1_000,
            'reconciliationIntervalMs',
        ),
        cancellationIntervalMs: integerOption(
            options.cancellationIntervalMs,
            500,
            'cancellationIntervalMs',
        ),
        observationRestartIntervalMs: integerOption(
            options.observationRestartIntervalMs,
            1_000,
            'observationRestartIntervalMs',
        ),
        shutdownTimeoutMs: integerOption(
            options.shutdownTimeoutMs,
            30_000,
            'shutdownTimeoutMs',
        ),
        dispatchBatchSize: integerOption(
            options.dispatchBatchSize,
            10,
            'dispatchBatchSize',
            1_000,
        ),
        reconciliationBatchSize: integerOption(
            options.reconciliationBatchSize,
            100,
            'reconciliationBatchSize',
            1_000,
        ),
        cancellationBatchSize: integerOption(
            options.cancellationBatchSize,
            100,
            'cancellationBatchSize',
            1_000,
        ),
        globalConcurrency,
        workspaceConcurrency,
        attemptLeaseMs: integerOption(
            options.attemptLeaseMs,
            5 * 60_000,
            'attemptLeaseMs',
        ),
    };
};

const openStore = (options: ValidatedDaemonOptions): GoalStore =>
    options.store ??
    options.storeFactory?.() ??
    new GoalStore(
        resolve(
            options.databasePath ??
                join(
                    options.workspace,
                    '.opencode',
                    'goal-supervisor',
                    'goal.db',
                ),
        ),
    );

const reportError = (options: ValidatedDaemonOptions, error: unknown): void => {
    const reported =
        error instanceof Error
            ? error
            : new GoalDaemonError('Daemon tick failed.', { cause: error });
    options.onError?.(reported);
};

const tickEffect = (
    options: ValidatedDaemonOptions,
    tick: (signal: AbortSignal) => Promise<unknown>,
) =>
    Effect.catch(
        Effect.tryPromise({
            try: tick,
            catch: error =>
                error instanceof Error
                    ? error
                    : new GoalDaemonError('Daemon tick failed.', {
                          cause: error,
                      }),
        }),
        error => Effect.sync(() => reportError(options, error)),
    );

const loopEffect = (
    options: ValidatedDaemonOptions,
    intervalMs: number,
    tick: (signal: AbortSignal) => Promise<unknown>,
) =>
    Effect.forever(
        Effect.andThen(tickEffect(options, tick), Effect.sleep(intervalMs)),
    );

const workspaceActiveCount = (store: GoalStore, workspace: string): number =>
    store.listActiveAttempts().filter(attempt => {
        const unit = store.getWorkUnit(attempt.workUnitId);
        return unit && store.status(unit.goalId).workspace === workspace;
    }).length;

const claimAvailableWork = (
    store: GoalStore,
    options: ValidatedDaemonOptions,
): number => {
    const active = store.listActiveAttempts().length;
    const workspaceActive = workspaceActiveCount(store, options.workspace);
    const available = Math.max(
        0,
        Math.min(
            options.globalConcurrency - active,
            options.workspaceConcurrency - workspaceActive,
            options.dispatchBatchSize,
        ),
    );
    let claimed = 0;
    for (let index = 0; index < available; index++) {
        const attempt = store.claimNextWork(
            options.owner,
            options.attemptLeaseMs,
            options.workspace,
        );
        if (!attempt) break;
        claimed++;
    }
    return claimed;
};

const waitForShutdown = (signal: AbortSignal | undefined) => {
    if (!signal) return Effect.never;
    return Effect.callback<void>(resume => {
        const complete = (): void => resume(Effect.void);
        if (signal.aborted) {
            complete();
            return;
        }
        signal.addEventListener('abort', complete, { once: true });
        return Effect.sync(() => signal.removeEventListener('abort', complete));
    });
};

const anyAbortSignal = (signals: readonly AbortSignal[]): AbortSignal => {
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any([...signals]);
    }
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const clear = (): void => {
        for (const [signal, listener] of listeners) {
            signal.removeEventListener('abort', listener);
        }
        listeners.clear();
    };
    for (const signal of signals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            clear();
            break;
        }
        const listener = (): void => {
            controller.abort(signal.reason);
            clear();
        };
        listeners.set(signal, listener);
        signal.addEventListener('abort', listener, { once: true });
    }
    return controller.signal;
};

const completeBeforeAbort = async (
    operation: Promise<unknown>,
    signal: AbortSignal,
): Promise<boolean> => {
    const observed = operation.then(
        () => ({ type: 'completed' as const }),
        error => ({ type: 'failed' as const, error }),
    );
    if (signal.aborted) return false;
    let removeAbortListener: (() => void) | undefined;
    const aborted = new Promise<{ readonly type: 'aborted' }>(resolveAbort => {
        const onAbort = (): void => resolveAbort({ type: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () =>
            signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onAbort();
    });
    try {
        const settled = await Promise.race([observed, aborted]);
        if (settled.type === 'failed') throw settled.error;
        return settled.type === 'completed';
    } finally {
        removeAbortListener?.();
    }
};

const enforceTimeout = async <Value>(
    operation: Promise<Value>,
    timeoutMs: number,
): Promise<Value> => {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new GoalDaemonError('Shutdown timed out.')),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
};

/** Scoped daemon body. Callers own the surrounding Effect Scope. */
export const goalDaemon = (
    input: GoalDaemonOptions,
): Effect.Effect<void, GoalDaemonError, Scope.Scope> =>
    Effect.gen(function* () {
        const options = yield* Effect.try({
            try: () => validateOptions(input),
            catch: error =>
                new GoalDaemonError('Invalid goal daemon configuration.', {
                    cause: error,
                }),
        });
        const lock = yield* Effect.acquireRelease(
            Effect.try({
                try: () =>
                    acquireWorkspaceLock(options.lockPath, options.workspace),
                catch: error =>
                    new GoalDaemonError(
                        'Could not acquire the workspace daemon lock.',
                        {
                            cause: error,
                        },
                    ),
            }),
            acquired => Effect.sync(() => acquired.release()),
        );
        void lock;
        const store = yield* Effect.acquireRelease(
            Effect.try({
                try: () => openStore(options),
                catch: error =>
                    new GoalDaemonError('Could not open the goal store.', {
                        cause: error,
                    }),
            }),
            opened =>
                Effect.sync(() => {
                    try {
                        opened.recoverExpiredOutboxLeases();
                        opened.checkpoint('PASSIVE');
                    } catch (error) {
                        reportError(options, error);
                    } finally {
                        try {
                            opened.close();
                        } catch (error) {
                            reportError(options, error);
                        }
                    }
                }),
        );
        const controller = yield* Effect.acquireRelease(
            Effect.sync(() => new AbortController()),
            acquired =>
                Effect.sync(() => acquired.abort('daemon scope closed')),
        );
        const supervisor = new GoalSupervisor(store, options.adapter, options);

        yield* Effect.addFinalizer(() =>
            Effect.catch(
                Effect.tryPromise({
                    try: () => {
                        const shutdownSignal = AbortSignal.timeout(
                            options.shutdownTimeoutMs,
                        );
                        return enforceTimeout(
                            supervisor.processCancellations(
                                options.cancellationBatchSize,
                                shutdownSignal,
                            ),
                            options.shutdownTimeoutMs,
                        );
                    },
                    catch: error =>
                        error instanceof Error
                            ? error
                            : new GoalDaemonError(
                                  'Shutdown cancellation failed.',
                                  {
                                      cause: error,
                                  },
                              ),
                }),
                error => Effect.sync(() => reportError(options, error)),
            ).pipe(Effect.asVoid),
        );

        const startupCompleted = yield* Effect.tryPromise({
            try: async effectSignal => {
                const startupSignal = anyAbortSignal([
                    effectSignal,
                    controller.signal,
                    ...(options.signal ? [options.signal] : []),
                ]);
                if (startupSignal.aborted) return false;
                return await completeBeforeAbort(
                    (async () => {
                        store.startupReconcile();
                        await supervisor.processCancellations(
                            options.cancellationBatchSize,
                            startupSignal,
                        );
                        await supervisor.reconcileActive(
                            options.reconciliationBatchSize,
                            startupSignal,
                        );
                    })(),
                    startupSignal,
                );
            },
            catch: error =>
                new GoalDaemonError('Startup reconciliation failed.', {
                    cause: error,
                }),
        });
        if (!startupCompleted) return;

        const globalPermits = yield* Semaphore.make(options.globalConcurrency);
        const workspacePermits = yield* Semaphore.make(
            options.workspaceConcurrency,
        );
        const withPermits = <A, E>(effect: Effect.Effect<A, E>) =>
            globalPermits.withPermit(workspacePermits.withPermit(effect));

        const permittedLoop = (
            intervalMs: number,
            tick: (signal: AbortSignal) => Promise<unknown>,
        ) =>
            Effect.forever(
                Effect.andThen(
                    withPermits(tickEffect(options, tick)),
                    Effect.sleep(intervalMs),
                ),
            );
        const dispatchLoop = permittedLoop(
            options.dispatchIntervalMs,
            async signal => {
                store.startupReconcile();
                claimAvailableWork(store, options);
                return await supervisor.dispatchPending(
                    options.dispatchBatchSize,
                    signal,
                );
            },
        );
        const reconciliationLoop = permittedLoop(
            options.reconciliationIntervalMs,
            signal =>
                supervisor.reconcileActive(
                    options.reconciliationBatchSize,
                    signal,
                ),
        );
        const cancellationLoop = permittedLoop(
            options.cancellationIntervalMs,
            signal =>
                supervisor.processCancellations(
                    options.cancellationBatchSize,
                    signal,
                ),
        );
        const observationLoop = loopEffect(
            options,
            options.observationRestartIntervalMs,
            () => supervisor.observeAdapter(controller.signal),
        );

        yield* Effect.forkScoped(dispatchLoop, {
            startImmediately: true,
        });
        yield* Effect.forkScoped(reconciliationLoop, {
            startImmediately: true,
        });
        yield* Effect.forkScoped(cancellationLoop, {
            startImmediately: true,
        });
        yield* Effect.forkScoped(observationLoop, { startImmediately: true });
        yield* waitForShutdown(options.signal);
    });

/** Promise entrypoint with optional process-signal handling and full finalization. */
export const runGoalDaemon = async (
    options: RunGoalDaemonOptions,
): Promise<void> => {
    const processController = new AbortController();
    const handleSignals = options.handleSignals ?? true;
    const stop = (): void => processController.abort('process signal');
    const forwardAbort = (): void =>
        processController.abort(options.signal?.reason);
    if (handleSignals) {
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    }
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    try {
        await Effect.runPromise(
            Effect.scoped(
                goalDaemon({
                    ...options,
                    signal: processController.signal,
                }),
            ),
        );
    } finally {
        options.signal?.removeEventListener('abort', forwardAbort);
        if (handleSignals) {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
        }
    }
};
