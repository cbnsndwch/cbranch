import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { lstat, realpath } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    defaultSystemdUserDirectory,
    inspectDaemonServiceStatus,
    systemdServiceIdentity,
    writeSystemdUserService,
    type DaemonServiceStatus,
} from './systemd.js';
import {
    TUI_BRIDGE_COMMAND,
    TUI_BRIDGE_PROTOCOL,
    MAX_TUI_BRIDGE_REQUEST_BYTES,
    TuiBridgeRequestSchema,
    TuiBridgeResponseSchema,
    type TuiBridgeGoalSummary,
    type TuiBridgeLaunchResponse,
    type TuiBridgeRequest,
    type TuiBridgeSuccessResponse,
} from './tui-protocol.js';

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_PROCESS_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1_024;
const MAX_PROCESS_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LIMIT_BYTES = 2 * 1_024 * 1_024;
const PROCESS_TERMINATION_GRACE_MS = 100;
const DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LIFECYCLE_LOCK_POLL_INTERVAL_MS = 25;
const lifecycleTokenPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ProcessResult = {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
};

export type ProcessRunOptions = {
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly stdoutLimitBytes?: number;
    readonly stderrLimitBytes?: number;
};

export type ProcessRunner = (
    executable: string,
    arguments_: readonly string[],
    options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export class ProcessTerminationError extends Error {
    readonly reason: 'timeout' | 'output-limit';

    constructor(reason: 'timeout' | 'output-limit', message: string) {
        super(message);
        this.name = 'ProcessTerminationError';
        this.reason = reason;
    }
}

export const runProcessWithoutShell: ProcessRunner = async (
    executable,
    arguments_,
    options = {},
) =>
    await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
        const timeoutMs = positiveInteger(
            options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
            'timeoutMs',
            MAX_PROCESS_TIMEOUT_MS,
        );
        const stdoutLimitBytes = positiveInteger(
            options.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
            'stdoutLimitBytes',
            MAX_OUTPUT_LIMIT_BYTES,
        );
        const stderrLimitBytes = positiveInteger(
            options.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
            'stderrLimitBytes',
            MAX_OUTPUT_LIMIT_BYTES,
        );
        const stdin = options.stdin;
        if (stdin && Buffer.byteLength(stdin) > MAX_TUI_BRIDGE_REQUEST_BYTES) {
            rejectPromise(
                new Error('Process input exceeded the safety limit.'),
            );
            return;
        }
        const child = spawn(executable, [...arguments_], {
            shell: false,
            stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        const childStdout = child.stdout;
        const childStderr = child.stderr;
        if (!childStdout || !childStderr) {
            child.kill();
            rejectPromise(new Error('Process output pipes were unavailable.'));
            return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let terminationError: ProcessTerminationError | undefined;
        let escalation: NodeJS.Timeout | undefined;
        const terminate = (error: ProcessTerminationError): void => {
            if (settled || terminationError) return;
            terminationError = error;
            clearTimeout(timeout);
            child.kill('SIGTERM');
            escalation = setTimeout(() => {
                if (!settled) child.kill('SIGKILL');
            }, PROCESS_TERMINATION_GRACE_MS);
        };
        const timeout = setTimeout(
            () =>
                terminate(
                    new ProcessTerminationError(
                        'timeout',
                        'Process execution timed out.',
                    ),
                ),
            timeoutMs,
        );
        const collect = (
            target: Buffer[],
            chunk: Buffer,
            stream: 'stdout' | 'stderr',
        ): void => {
            if (terminationError) return;
            if (stream === 'stdout') stdoutBytes += chunk.length;
            else stderrBytes += chunk.length;
            const bytes = stream === 'stdout' ? stdoutBytes : stderrBytes;
            const limit =
                stream === 'stdout' ? stdoutLimitBytes : stderrLimitBytes;
            if (bytes > limit) {
                terminate(
                    new ProcessTerminationError(
                        'output-limit',
                        `Process ${stream} exceeded the safety limit.`,
                    ),
                );
                return;
            }
            target.push(chunk);
        };
        childStdout.on('data', chunk =>
            collect(stdout, Buffer.from(chunk), 'stdout'),
        );
        childStderr.on('data', chunk =>
            collect(stderr, Buffer.from(chunk), 'stderr'),
        );
        child.stdin?.once('error', error => {
            if (settled) return;
            child.kill('SIGKILL');
            terminationError ??= new ProcessTerminationError(
                'output-limit',
                `Process input failed: ${error.message}`,
            );
        });
        child.once('error', error => {
            if (settled) return;
            if (terminationError) return;
            settled = true;
            clearTimeout(timeout);
            if (escalation) clearTimeout(escalation);
            rejectPromise(error);
        });
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (escalation) clearTimeout(escalation);
            if (terminationError) {
                rejectPromise(terminationError);
                return;
            }
            resolvePromise({
                exitCode: code ?? 1,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
        child.stdin?.end(stdin);
    });

export class PersistentDaemonUnsupportedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PersistentDaemonUnsupportedError';
    }
}

export type PersistentDaemonStatus = {
    readonly status:
        | 'running'
        | 'starting'
        | 'stopped'
        | 'stale'
        | 'invalid'
        | 'unsupported';
    readonly unitName: string;
    readonly ownership?: 'managed' | 'independent';
    readonly detail: string;
};

type SystemdUnitState = {
    readonly loadState: string;
    readonly activeState: string;
    readonly subState: string;
    readonly mainPid: number;
    readonly fragmentPath: string;
    readonly unitFileState: string;
};

export type PersistentDaemonManagerDependencies = {
    readonly platform: NodeJS.Platform;
    readonly runProcess: ProcessRunner;
    readonly inspectDaemonServiceStatus: typeof inspectDaemonServiceStatus;
    readonly writeSystemdUserService: typeof writeSystemdUserService;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly realpath: typeof realpath;
    readonly lstat: typeof lstat;
    readonly pidIsAlive: (pid: number) => boolean;
    readonly nodeCandidates: readonly string[];
    readonly systemctlCandidates: readonly string[];
    readonly cliPath: string;
};

const procPidIsAlive = (pid: number): boolean => {
    try {
        lstatSync(`/proc/${pid}`);
        return true;
    } catch (error) {
        return !(
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        );
    }
};

type LifecycleLockOwner = {
    readonly pid: number;
    readonly token: string;
    readonly workspace: string;
    readonly createdAt: string;
};

const lifecycleErrorCode = (error: unknown): string | undefined =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
        ? error.code
        : undefined;

const parseLifecycleLockOwner = (value: string): LifecycleLockOwner => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('Workspace lifecycle lock is malformed.');
    }
    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
    ) {
        throw new Error('Workspace lifecycle lock is malformed.');
    }
    const owner = parsed as Record<string, unknown>;
    if (
        !Number.isSafeInteger(owner.pid) ||
        Number(owner.pid) <= 0 ||
        typeof owner.token !== 'string' ||
        !lifecycleTokenPattern.test(owner.token) ||
        typeof owner.workspace !== 'string' ||
        !isAbsolute(owner.workspace) ||
        typeof owner.createdAt !== 'string' ||
        Number.isNaN(Date.parse(owner.createdAt))
    ) {
        throw new Error('Workspace lifecycle lock is malformed.');
    }
    return {
        pid: Number(owner.pid),
        token: owner.token,
        workspace: resolve(owner.workspace),
        createdAt: owner.createdAt,
    };
};

const removeLifecycleLockIfUnchanged = (
    path: string,
    expected: string,
): boolean => {
    try {
        const before = statSync(path);
        if (readFileSync(path, 'utf8') !== expected) return false;
        const after = statSync(path);
        if (before.dev !== after.dev || before.ino !== after.ino) return false;
        unlinkSync(path);
        return true;
    } catch (error) {
        if (lifecycleErrorCode(error) === 'ENOENT') return false;
        throw error;
    }
};

const publishLifecycleLock = (
    path: string,
    owner: LifecycleLockOwner,
    serialized: string,
): void => {
    const candidate = `${path}.${owner.token}.candidate`;
    let file: number | undefined;
    try {
        file = openSync(candidate, 'wx', 0o600);
        writeFileSync(file, serialized, { encoding: 'utf8' });
        closeSync(file);
        file = undefined;
        linkSync(candidate, path);
    } finally {
        if (file !== undefined) closeSync(file);
        try {
            unlinkSync(candidate);
        } catch {
            // A uniquely named candidate never owns the lifecycle lease.
        }
    }
};

const acquireLifecycleLock = async (
    path: string,
    workspace: string,
    timeoutMs: number,
    pollIntervalMs: number,
    pidIsAlive: (pid: number) => boolean,
    sleep: (milliseconds: number) => Promise<void>,
): Promise<{ readonly release: () => void }> => {
    const lockPath = resolve(path);
    const canonicalWorkspace = resolve(workspace);
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const owner: LifecycleLockOwner = {
            pid: process.pid,
            token: randomUUID(),
            workspace: canonicalWorkspace,
            createdAt: new Date().toISOString(),
        };
        const serialized = `${JSON.stringify(owner)}\n`;
        try {
            publishLifecycleLock(lockPath, owner, serialized);
            let released = false;
            return {
                release: () => {
                    if (released) return;
                    released = true;
                    let current: string;
                    try {
                        current = readFileSync(lockPath, 'utf8');
                    } catch (error) {
                        if (lifecycleErrorCode(error) === 'ENOENT') return;
                        throw error;
                    }
                    const currentOwner = parseLifecycleLockOwner(current);
                    if (currentOwner.token !== owner.token) return;
                    removeLifecycleLockIfUnchanged(lockPath, current);
                },
            };
        } catch (error) {
            if (lifecycleErrorCode(error) !== 'EEXIST') throw error;
        }

        let existingText: string;
        try {
            const info = lstatSync(lockPath);
            if (
                !info.isFile() ||
                info.isSymbolicLink() ||
                info.size <= 0 ||
                info.size > 16_384
            ) {
                throw new Error('Workspace lifecycle lock is malformed.');
            }
            existingText = readFileSync(lockPath, 'utf8');
        } catch (error) {
            if (lifecycleErrorCode(error) === 'ENOENT') continue;
            throw error;
        }
        const existing = parseLifecycleLockOwner(existingText);
        if (existing.workspace !== canonicalWorkspace) {
            throw new Error(
                'Workspace lifecycle lock belongs to a different workspace.',
            );
        }
        if (!pidIsAlive(existing.pid)) {
            removeLifecycleLockIfUnchanged(lockPath, existingText);
            continue;
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `Timed out waiting for workspace lifecycle lock at ${lockPath}.`,
            );
        }
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(
            Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())),
        );
    }
};

export const pathProgramCandidates = (
    name: string,
    path = process.env.PATH ?? '',
): readonly string[] => {
    if (!/^[A-Za-z0-9._-]+$/u.test(name)) {
        throw new Error('Program name must be a simple file name.');
    }
    return path
        .split(delimiter)
        .filter(
            directory =>
                isAbsolute(directory) &&
                Array.from(directory).every(character => {
                    const code = character.charCodeAt(0);
                    return code > 0x1f && (code < 0x7f || code > 0x9f);
                }),
        )
        .map(directory => resolve(directory, name));
};

const defaultDependencies: PersistentDaemonManagerDependencies = {
    platform: process.platform,
    runProcess: runProcessWithoutShell,
    inspectDaemonServiceStatus,
    writeSystemdUserService,
    sleep: async milliseconds =>
        await new Promise(resolvePromise =>
            setTimeout(resolvePromise, milliseconds),
        ),
    realpath,
    lstat,
    pidIsAlive: procPidIsAlive,
    nodeCandidates: [
        process.execPath,
        ...pathProgramCandidates('node'),
        '/usr/bin/node',
        '/usr/local/bin/node',
    ],
    systemctlCandidates: [
        ...pathProgramCandidates('systemctl'),
        '/usr/bin/systemctl',
        '/bin/systemctl',
    ],
    cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)),
};

const concise = (value: string): string =>
    Array.from(value)
        .map(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500);

const positiveInteger = (
    value: number,
    label: string,
    maximum: number,
): number => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new RangeError(
            `${label} must be an integer from 1 through ${maximum}.`,
        );
    }
    return value;
};

export const workspaceSystemdUnitName = (canonicalWorkspace: string): string =>
    `cbranch-goal-supervisor-${createHash('sha256').update(canonicalWorkspace).digest('hex').slice(0, 24)}.service`;

const executableFile = async (
    path: string,
    label: string,
    dependencies: PersistentDaemonManagerDependencies,
): Promise<string> => {
    if (!isAbsolute(path))
        throw new Error(`${label} must be an absolute path.`);
    const canonical = await dependencies.realpath(path);
    const info = await dependencies.lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`${label} must be a regular file.`);
    }
    if ((info.mode & 0o111) === 0) {
        throw new Error(`${label} must be executable.`);
    }
    return canonical;
};

const regularFile = async (
    path: string,
    label: string,
    dependencies: PersistentDaemonManagerDependencies,
): Promise<string> => {
    if (!isAbsolute(path))
        throw new Error(`${label} must be an absolute path.`);
    const canonical = await dependencies.realpath(path);
    const info = await dependencies.lstat(canonical);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0) {
        throw new Error(`${label} must be a nonempty regular file.`);
    }
    return canonical;
};

export type VerifiedTuiPrograms = {
    readonly nodePath: string;
    readonly cliPath: string;
};

export type VerifyTuiProgramsOptions = {
    readonly nodePath?: string;
    readonly cliPath?: string;
    readonly dependencies?: Partial<PersistentDaemonManagerDependencies>;
};

/** Resolves the exact Node and sibling CLI files used by both bridge and unit. */
export const verifyTuiPrograms = async (
    options: VerifyTuiProgramsOptions = {},
): Promise<VerifiedTuiPrograms> => {
    const dependencies = { ...defaultDependencies, ...options.dependencies };
    const [nodePath, cliPath] = await Promise.all([
        firstVerifiedProgram(
            options.nodePath ? [options.nodePath] : dependencies.nodeCandidates,
            'Node.js executable',
            output => {
                const major = Number(/^v(\d+)\.\d+\.\d+/mu.exec(output)?.[1]);
                return Number.isSafeInteger(major) && major >= 20;
            },
            dependencies,
        ),
        regularFile(
            options.cliPath ?? dependencies.cliPath,
            'Goal supervisor cli.js',
            dependencies,
        ),
    ]);
    return { nodePath, cliPath };
};

export type TuiBridgeGoal = TuiBridgeGoalSummary;

export type TuiBridgeListResult = {
    readonly total: number;
    readonly hasExecuting: boolean;
    readonly goals: readonly TuiBridgeGoal[];
};

export type TuiBridgeLaunchResult = {
    readonly goal: TuiBridgeLaunchResponse['goal'];
};

export type TuiBridgeLaunchInput = {
    readonly workspace: string;
    readonly planPath: string;
    readonly planMarkdown: string;
    readonly actor: string;
};

export type TuiBridgeClientOptions = VerifyTuiProgramsOptions & {
    readonly timeoutMs?: number;
    readonly stdoutLimitBytes?: number;
    readonly stderrLimitBytes?: number;
};

export interface TuiBridgeClient {
    readonly verifiedPrograms: VerifiedTuiPrograms;
    readonly init: (
        workspace: string,
    ) => Promise<{ readonly workspace: string }>;
    readonly list: (workspace: string) => Promise<TuiBridgeListResult>;
    readonly launch: (
        input: TuiBridgeLaunchInput,
    ) => Promise<TuiBridgeLaunchResult>;
}

const parseBridgeResponse = (
    request: TuiBridgeRequest,
    result: ProcessResult,
): TuiBridgeSuccessResponse => {
    let json: unknown;
    try {
        json = JSON.parse(result.stdout);
    } catch {
        throw new Error(
            result.exitCode === 0
                ? 'Goal supervisor bridge returned malformed JSON.'
                : `Goal supervisor bridge exited with code ${result.exitCode}: ${concise(result.stderr || result.stdout || 'no error output')}`,
        );
    }
    const parsed = TuiBridgeResponseSchema.safeParse(json);
    if (!parsed.success) {
        throw new Error('Goal supervisor bridge returned an invalid response.');
    }
    const response = parsed.data;
    if (response.protocol !== request.protocol) {
        throw new Error('Goal supervisor bridge protocol version mismatched.');
    }
    if (!response.ok) {
        throw new Error(
            `Goal supervisor bridge failed: ${concise(response.error.message)}`,
        );
    }
    if (response.operation !== request.operation) {
        throw new Error(
            'Goal supervisor bridge response did not match its request.',
        );
    }
    if (result.exitCode !== 0) {
        throw new Error(
            `Goal supervisor bridge exited with code ${result.exitCode}.`,
        );
    }
    return response;
};

/** Creates a one-shot bridge that keeps SQLite inside short-lived Node calls. */
export const createTuiBridgeClient = async (
    options: TuiBridgeClientOptions = {},
): Promise<TuiBridgeClient> => {
    const dependencies = { ...defaultDependencies, ...options.dependencies };
    const verifiedPrograms = await verifyTuiPrograms(options);
    const processOptions: ProcessRunOptions = {
        timeoutMs: options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
        stdoutLimitBytes:
            options.stdoutLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
        stderrLimitBytes:
            options.stderrLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    };
    const request = async (
        input: TuiBridgeRequest,
    ): Promise<TuiBridgeSuccessResponse> => {
        const parsedRequest = TuiBridgeRequestSchema.parse(input);
        const result = await dependencies.runProcess(
            verifiedPrograms.nodePath,
            [verifiedPrograms.cliPath, TUI_BRIDGE_COMMAND],
            {
                ...processOptions,
                stdin: `${JSON.stringify(parsedRequest)}\n`,
            },
        );
        return parseBridgeResponse(parsedRequest, result);
    };

    return {
        verifiedPrograms,
        init: async workspace => {
            const response = await request({
                protocol: TUI_BRIDGE_PROTOCOL,
                operation: 'init',
                workspace,
            });
            if (response.operation !== 'init') {
                throw new Error(
                    'Goal supervisor bridge init response mismatched.',
                );
            }
            return { workspace: response.workspace };
        },
        list: async workspace => {
            const response = await request({
                protocol: TUI_BRIDGE_PROTOCOL,
                operation: 'list',
                workspace,
            });
            if (response.operation !== 'list') {
                throw new Error(
                    'Goal supervisor bridge list response mismatched.',
                );
            }
            return {
                total: response.total,
                hasExecuting: response.hasExecuting,
                goals: response.goals,
            };
        },
        launch: async input => {
            let response: TuiBridgeSuccessResponse;
            try {
                response = await request({
                    protocol: TUI_BRIDGE_PROTOCOL,
                    operation: 'launch',
                    ...input,
                });
            } catch (error) {
                if (error instanceof ProcessTerminationError) {
                    throw new Error(
                        'Goal launch bridge was terminated before its response was received. The goal may already be durable; retry the same confirmed plan to resolve the outcome safely.',
                        { cause: error },
                    );
                }
                throw error;
            }
            if (response.operation !== 'launch') {
                throw new Error(
                    'Goal supervisor bridge launch response mismatched.',
                );
            }
            return { goal: response.goal };
        },
    };
};

const firstVerifiedProgram = async (
    candidates: readonly string[],
    label: string,
    acceptsVersion: (output: string) => boolean,
    dependencies: PersistentDaemonManagerDependencies,
): Promise<string> => {
    const errors: string[] = [];
    for (const candidate of new Set(candidates)) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop
            const executable = await executableFile(
                candidate,
                label,
                dependencies,
            );
            // oxlint-disable-next-line eslint/no-await-in-loop
            const version = await dependencies.runProcess(executable, [
                '--version',
            ]);
            if (
                version.exitCode === 0 &&
                acceptsVersion(`${version.stdout}\n${version.stderr}`)
            ) {
                return executable;
            }
            errors.push(`${candidate}: unexpected --version output`);
        } catch (error) {
            errors.push(
                `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    throw new PersistentDaemonUnsupportedError(
        `${label} is unavailable. ${concise(errors.join('; '))}`,
    );
};

const parseUnitState = (stdout: string): SystemdUnitState => {
    const values = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/u)) {
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        values.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const pid = Number(values.get('MainPID') ?? 0);
    return {
        loadState: values.get('LoadState') ?? 'unknown',
        activeState: values.get('ActiveState') ?? 'unknown',
        subState: values.get('SubState') ?? 'unknown',
        mainPid: Number.isSafeInteger(pid) && pid > 0 ? pid : 0,
        fragmentPath: values.get('FragmentPath') ?? '',
        unitFileState: values.get('UnitFileState') ?? 'unknown',
    };
};

const unitIsActive = (unit: SystemdUnitState): boolean =>
    unit.activeState === 'active' || unit.activeState === 'activating';

const unitIsEnabled = (unit: SystemdUnitState): boolean =>
    unit.unitFileState === 'enabled' ||
    unit.unitFileState === 'enabled-runtime';

export type PersistentDaemonManagerOptions = {
    readonly workspace: string;
    readonly openCodeUrl: string;
    readonly nodePath?: string;
    readonly cliPath?: string;
    readonly systemctlPath?: string;
    readonly systemdUserDirectory?: string;
    readonly lockPath?: string;
    readonly readinessTimeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly lifecycleLockPath?: string;
    readonly lifecycleLockTimeoutMs?: number;
    readonly lifecycleLockPollIntervalMs?: number;
    readonly verifiedPrograms?: VerifiedTuiPrograms;
    readonly dependencies?: Partial<PersistentDaemonManagerDependencies>;
};

export interface PersistentDaemonManager {
    readonly workspace: string;
    readonly unitName: string;
    readonly unitPath: string;
    readonly status: () => Promise<PersistentDaemonStatus>;
    readonly ensureRunning: () => Promise<PersistentDaemonStatus>;
    readonly stop: () => Promise<PersistentDaemonStatus>;
}

export const createPersistentDaemonManager = async (
    options: PersistentDaemonManagerOptions,
): Promise<PersistentDaemonManager> => {
    const dependencies = { ...defaultDependencies, ...options.dependencies };
    const workspace = await dependencies.realpath(options.workspace);
    const workspaceInfo = await dependencies.lstat(workspace);
    if (!workspaceInfo.isDirectory()) {
        throw new Error('Goal daemon workspace must be a directory.');
    }
    const unitName = workspaceSystemdUnitName(workspace);
    const systemdUserDirectory = resolve(
        options.systemdUserDirectory ?? defaultSystemdUserDirectory(),
    );
    const unitPath = join(systemdUserDirectory, unitName);
    const lockPath = resolve(
        options.lockPath ??
            join(workspace, '.opencode', 'goal-supervisor', 'daemon.lock'),
    );
    const lifecycleLockPath = resolve(
        options.lifecycleLockPath ?? `${lockPath}.lifecycle`,
    );
    const readinessTimeoutMs = positiveInteger(
        options.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        'readinessTimeoutMs',
        60_000,
    );
    const pollIntervalMs = positiveInteger(
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        'pollIntervalMs',
        readinessTimeoutMs,
    );
    const attempts = Math.max(
        1,
        Math.ceil(readinessTimeoutMs / pollIntervalMs),
    );
    const lifecycleLockTimeoutMs = positiveInteger(
        options.lifecycleLockTimeoutMs ?? DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS,
        'lifecycleLockTimeoutMs',
        60_000,
    );
    const lifecycleLockPollIntervalMs = positiveInteger(
        options.lifecycleLockPollIntervalMs ??
            DEFAULT_LIFECYCLE_LOCK_POLL_INTERVAL_MS,
        'lifecycleLockPollIntervalMs',
        lifecycleLockTimeoutMs,
    );
    let desiredServiceIdentity = options.verifiedPrograms
        ? systemdServiceIdentity({
              executablePath: options.verifiedPrograms.nodePath,
              cliPath: options.verifiedPrograms.cliPath,
              workspace,
              openCodeUrl: options.openCodeUrl,
          })
        : undefined;
    let systemctlPromise: Promise<string> | undefined;

    const resolveSystemctl = (): Promise<string> => {
        systemctlPromise ??= firstVerifiedProgram(
            options.systemctlPath
                ? [options.systemctlPath]
                : dependencies.systemctlCandidates,
            'systemctl',
            output => /\bsystemd\s+\d+/iu.test(output),
            dependencies,
        );
        return systemctlPromise;
    };
    const inspectLock = async (): Promise<DaemonServiceStatus> =>
        await dependencies.inspectDaemonServiceStatus(lockPath, {
            workspace,
            isPidAlive: dependencies.pidIsAlive,
        });
    const readUnit = async (systemctl: string): Promise<SystemdUnitState> => {
        const result = await dependencies.runProcess(systemctl, [
            '--user',
            'show',
            unitName,
            '--property=LoadState',
            '--property=ActiveState',
            '--property=SubState',
            '--property=MainPID',
            '--property=FragmentPath',
            '--property=UnitFileState',
            '--no-pager',
        ]);
        if (result.exitCode !== 0) {
            throw new Error(
                `systemctl show failed: ${concise(result.stderr || result.stdout || `exit ${result.exitCode}`)}`,
            );
        }
        return parseUnitState(result.stdout);
    };
    const classify = (
        lock: DaemonServiceStatus,
        unit: SystemdUnitState | undefined,
        unitError?: unknown,
    ): PersistentDaemonStatus => {
        if (lock.status === 'running') {
            const active =
                unit?.activeState === 'active' ||
                unit?.activeState === 'activating';
            const managed =
                unit !== undefined &&
                active &&
                unit.fragmentPath === unitPath &&
                unit.mainPid === lock.pid &&
                unit.loadState === 'loaded';
            const ready =
                lock.ready &&
                (!managed ||
                    desiredServiceIdentity === undefined ||
                    lock.serviceIdentity === desiredServiceIdentity);
            return {
                status: ready ? 'running' : 'starting',
                unitName,
                ownership: managed ? 'managed' : 'independent',
                detail: ready
                    ? managed
                        ? 'The verified workspace systemd user service owns the ready daemon lock.'
                        : 'An independently managed ready daemon owns the workspace lock.'
                    : managed
                      ? 'The verified workspace systemd user service owns the lock but is still starting.'
                      : 'An independently managed daemon owns the lock but is still starting.',
            };
        }
        if (lock.status === 'invalid') {
            return {
                status: 'invalid',
                unitName,
                detail: lock.detail,
            };
        }
        if (unitError) {
            return {
                status: 'unsupported',
                unitName,
                detail: `systemd user services are unavailable: ${concise(unitError instanceof Error ? unitError.message : String(unitError))}`,
            };
        }
        if (unit?.loadState === 'loaded' && unit.fragmentPath !== unitPath) {
            return {
                status: 'invalid',
                unitName,
                detail: `The loaded systemd unit fragment is not the expected workspace unit at ${unitPath}.`,
            };
        }
        if (lock.status === 'stale') {
            return {
                status: 'stale',
                unitName,
                detail: 'A stale daemon lock remains for this workspace.',
            };
        }
        if (
            unit?.activeState === 'active' ||
            unit?.activeState === 'activating'
        ) {
            return {
                status: 'starting',
                unitName,
                detail: `The systemd unit is ${unit.activeState}/${unit.subState}; waiting for its daemon lock.`,
            };
        }
        if (unit?.activeState === 'failed') {
            return {
                status: 'stopped',
                unitName,
                detail: `The systemd unit failed/${unit.subState}. Inspect it with systemctl --user status ${unitName}.`,
            };
        }
        return {
            status: 'stopped',
            unitName,
            detail:
                unit?.loadState === 'not-found'
                    ? 'No workspace systemd unit is installed.'
                    : 'The workspace daemon is stopped.',
        };
    };
    const status = async (): Promise<PersistentDaemonStatus> => {
        if (dependencies.platform !== 'linux') {
            return {
                status: 'unsupported',
                unitName,
                detail: 'Persistent goal daemons require a Linux systemd user session.',
            };
        }
        const lock = await inspectLock();
        let systemctl: string;
        try {
            systemctl = await resolveSystemctl();
        } catch (error) {
            return classify(lock, undefined, error);
        }
        try {
            return classify(lock, await readUnit(systemctl));
        } catch (error) {
            return classify(lock, undefined, error);
        }
    };
    const requiredSystemctl = async (
        systemctl: string,
        arguments_: readonly string[],
    ): Promise<void> => {
        const result = await dependencies.runProcess(systemctl, arguments_);
        if (result.exitCode === 0) return;
        throw new Error(
            `systemctl ${arguments_.join(' ')} failed: ${concise(result.stderr || result.stdout || `exit ${result.exitCode}`)}`,
        );
    };
    const unitIsVerified = (unit: SystemdUnitState): boolean =>
        unit.loadState === 'loaded' && unit.fragmentPath === unitPath;
    const inspectRequired = async (
        systemctl: string,
    ): Promise<{
        readonly lock: DaemonServiceStatus;
        readonly unit: SystemdUnitState;
    }> => {
        const [lock, unit] = await Promise.all([
            inspectLock(),
            readUnit(systemctl),
        ]);
        return { lock, unit };
    };
    const disableVerifiedUnitForIndependent = async (
        systemctl: string,
        lock: DaemonServiceStatus,
        unit: SystemdUnitState,
    ): Promise<PersistentDaemonStatus> => {
        const current = classify(lock, unit);
        if (lock.status !== 'running' || current.ownership !== 'independent') {
            return current;
        }
        if (
            !unitIsVerified(unit) ||
            (!unitIsActive(unit) && !unitIsEnabled(unit))
        ) {
            return current;
        }
        await requiredSystemctl(systemctl, [
            '--user',
            'disable',
            '--now',
            unitName,
        ]);
        const after = await inspectRequired(systemctl);
        if (
            after.lock.status !== 'running' ||
            after.lock.token !== lock.token
        ) {
            throw new Error(
                'Independent daemon ownership changed while disabling the verified workspace unit.',
            );
        }
        if (
            unitIsVerified(after.unit) &&
            (unitIsActive(after.unit) || unitIsEnabled(after.unit))
        ) {
            throw new Error(
                'The verified workspace unit remained enabled or active after systemctl disable --now.',
            );
        }
        return classify(after.lock, after.unit);
    };
    let programsPromise: Promise<VerifiedTuiPrograms> | undefined;
    const resolvePrograms = (): Promise<VerifiedTuiPrograms> => {
        programsPromise ??= options.verifiedPrograms
            ? Promise.resolve(options.verifiedPrograms)
            : verifyTuiPrograms({
                  ...(options.nodePath ? { nodePath: options.nodePath } : {}),
                  ...(options.cliPath ? { cliPath: options.cliPath } : {}),
                  dependencies,
              });
        return programsPromise.then(programs => {
            desiredServiceIdentity ??= systemdServiceIdentity({
                executablePath: programs.nodePath,
                cliPath: programs.cliPath,
                workspace,
                openCodeUrl: options.openCodeUrl,
            });
            return programs;
        });
    };
    const pollReady = async (
        systemctl: string,
        cleanUpIndependent: boolean,
    ): Promise<PersistentDaemonStatus> => {
        let last: PersistentDaemonStatus | undefined;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt > 0) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await dependencies.sleep(pollIntervalMs);
            }
            // oxlint-disable-next-line eslint/no-await-in-loop
            last = await status();
            if (last.status === 'running') {
                if (last.ownership === 'managed') return last;
                if (last.ownership === 'independent') {
                    if (cleanUpIndependent) {
                        // oxlint-disable-next-line eslint/no-await-in-loop
                        const snapshot = await inspectRequired(systemctl);
                        // oxlint-disable-next-line eslint/no-await-in-loop
                        last = await disableVerifiedUnitForIndependent(
                            systemctl,
                            snapshot.lock,
                            snapshot.unit,
                        );
                    }
                    if (last.status === 'running') return last;
                }
                continue;
            }
            if (
                last.status === 'starting' &&
                last.ownership === 'independent' &&
                cleanUpIndependent
            ) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                const snapshot = await inspectRequired(systemctl);
                // oxlint-disable-next-line eslint/no-await-in-loop
                last = await disableVerifiedUnitForIndependent(
                    systemctl,
                    snapshot.lock,
                    snapshot.unit,
                );
            }
            if (last.status === 'unsupported') {
                throw new PersistentDaemonUnsupportedError(last.detail);
            }
            if (
                last.status === 'stopped' &&
                last.detail.startsWith('The systemd unit failed/')
            ) {
                throw new Error(`Goal daemon startup failed. ${last.detail}`);
            }
        }
        throw new Error(
            `Goal daemon did not become ready within ${readinessTimeoutMs}ms. ${last?.detail ?? 'No daemon status was available.'}`,
        );
    };
    const pollIndependentWithoutSystemd = async (
        firstLock: DaemonServiceStatus,
        systemdError: unknown,
    ): Promise<PersistentDaemonStatus> => {
        let lock = firstLock;
        let last = classify(lock, undefined, systemdError);
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (last.status === 'running') return last;
            if (
                last.status !== 'starting' ||
                last.ownership !== 'independent'
            ) {
                throw new PersistentDaemonUnsupportedError(
                    `The independent daemon stopped before becoming ready. ${last.detail}`,
                );
            }
            if (attempt + 1 < attempts) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await dependencies.sleep(pollIntervalMs);
                // oxlint-disable-next-line eslint/no-await-in-loop
                lock = await inspectLock();
                last = classify(lock, undefined, systemdError);
            }
        }
        throw new Error(
            `Goal daemon did not become ready within ${readinessTimeoutMs}ms. ${last.detail}`,
        );
    };
    const ensureRunningUnlocked = async (): Promise<PersistentDaemonStatus> => {
        if (dependencies.platform !== 'linux') {
            const unsupported = await status();
            throw new PersistentDaemonUnsupportedError(
                `${unsupported.detail} Install/enable systemd user services or run cbranch-goal-supervisor serve separately.`,
            );
        }
        let systemctl: string;
        try {
            systemctl = await resolveSystemctl();
        } catch (error) {
            const lock = await inspectLock();
            const observed = classify(lock, undefined, error);
            if (observed.ownership === 'independent') {
                return observed.status === 'running'
                    ? observed
                    : await pollIndependentWithoutSystemd(lock, error);
            }
            throw new PersistentDaemonUnsupportedError(
                `systemd user services are unavailable: ${concise(error instanceof Error ? error.message : String(error))} Install/enable systemd user services or run cbranch-goal-supervisor serve separately.`,
            );
        }
        let snapshot = await inspectRequired(systemctl);
        let initial = classify(snapshot.lock, snapshot.unit);
        if (initial.status === 'invalid') {
            throw new Error(`Cannot start goal daemon: ${initial.detail}`);
        }
        if (initial.status === 'unsupported') {
            throw new PersistentDaemonUnsupportedError(
                `${initial.detail} Install/enable systemd user services or run cbranch-goal-supervisor serve separately.`,
            );
        }
        if (initial.ownership === 'independent') {
            initial = await disableVerifiedUnitForIndependent(
                systemctl,
                snapshot.lock,
                snapshot.unit,
            );
            return initial.status === 'running'
                ? initial
                : await pollReady(systemctl, true);
        }
        const { nodePath, cliPath } = await resolvePrograms();
        initial = classify(snapshot.lock, snapshot.unit);
        const identityMismatch =
            snapshot.lock.status === 'running' &&
            initial.ownership === 'managed' &&
            desiredServiceIdentity !== undefined &&
            snapshot.lock.serviceIdentity !== desiredServiceIdentity;
        const written = await dependencies.writeSystemdUserService({
            executablePath: nodePath,
            cliPath,
            workspace,
            openCodeUrl: options.openCodeUrl,
            systemdUserDirectory,
            unitPath,
        });
        const wasVerified = unitIsVerified(snapshot.unit);
        const wasActive = wasVerified && unitIsActive(snapshot.unit);
        if (written.changed || !wasVerified || identityMismatch) {
            await requiredSystemctl(systemctl, ['--user', 'daemon-reload']);
            snapshot = await inspectRequired(systemctl);
            const reloaded = classify(snapshot.lock, snapshot.unit);
            if (reloaded.ownership === 'independent') {
                const independent = await disableVerifiedUnitForIndependent(
                    systemctl,
                    snapshot.lock,
                    snapshot.unit,
                );
                return independent.status === 'running'
                    ? independent
                    : await pollReady(systemctl, true);
            }
        }
        if (!unitIsEnabled(snapshot.unit)) {
            await requiredSystemctl(systemctl, ['--user', 'enable', unitName]);
        }
        if (
            !written.changed &&
            wasActive &&
            !identityMismatch &&
            (initial.status === 'running' || initial.status === 'starting')
        ) {
            return initial.status === 'running'
                ? initial
                : await pollReady(systemctl, true);
        }
        try {
            await requiredSystemctl(systemctl, ['--user', 'restart', unitName]);
        } catch (error) {
            const raced = await status();
            if (raced.ownership === 'independent') {
                const racedSnapshot = await inspectRequired(systemctl);
                const independent = await disableVerifiedUnitForIndependent(
                    systemctl,
                    racedSnapshot.lock,
                    racedSnapshot.unit,
                );
                return independent.status === 'running'
                    ? independent
                    : await pollReady(systemctl, true);
            }
            throw error;
        }
        return await pollReady(systemctl, true);
    };
    const stopUnlocked = async (): Promise<PersistentDaemonStatus> => {
        if (dependencies.platform !== 'linux') {
            const unsupported = await status();
            throw new PersistentDaemonUnsupportedError(unsupported.detail);
        }
        let systemctl: string;
        try {
            systemctl = await resolveSystemctl();
        } catch (error) {
            const lock = await inspectLock();
            const observed = classify(lock, undefined, error);
            if (observed.ownership === 'independent') return observed;
            throw new PersistentDaemonUnsupportedError(
                `systemd user services are unavailable: ${concise(error instanceof Error ? error.message : String(error))}`,
            );
        }
        let snapshot = await inspectRequired(systemctl);
        let initial = classify(snapshot.lock, snapshot.unit);
        if (initial.status === 'invalid') {
            throw new Error(`Cannot stop goal daemon: ${initial.detail}`);
        }
        if (initial.ownership === 'independent') {
            return await disableVerifiedUnitForIndependent(
                systemctl,
                snapshot.lock,
                snapshot.unit,
            );
        }
        if (
            unitIsVerified(snapshot.unit) &&
            (unitIsActive(snapshot.unit) || unitIsEnabled(snapshot.unit))
        ) {
            await requiredSystemctl(systemctl, [
                '--user',
                'disable',
                '--now',
                unitName,
            ]);
            snapshot = await inspectRequired(systemctl);
            initial = classify(snapshot.lock, snapshot.unit);
        } else if (initial.status === 'stopped') {
            return initial;
        }
        let last = initial;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt > 0) {
                // oxlint-disable-next-line eslint/no-await-in-loop
                await dependencies.sleep(pollIntervalMs);
            }
            // oxlint-disable-next-line eslint/no-await-in-loop
            last = await status();
            if (last.ownership === 'independent') {
                // oxlint-disable-next-line eslint/no-await-in-loop
                const independent = await inspectRequired(systemctl);
                // oxlint-disable-next-line eslint/no-await-in-loop
                return await disableVerifiedUnitForIndependent(
                    systemctl,
                    independent.lock,
                    independent.unit,
                );
            }
            if (last.status === 'stopped' || last.status === 'stale') {
                return last;
            }
        }
        throw new Error(
            `Goal daemon did not stop within ${readinessTimeoutMs}ms. ${last.detail}`,
        );
    };

    let lifecycleTail = Promise.resolve();
    const serializeLifecycle = <Result>(
        mutation: () => Promise<Result>,
    ): Promise<Result> => {
        const result = lifecycleTail.then(mutation, mutation);
        lifecycleTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
    const withLifecycleLock = async <Result>(
        mutation: () => Promise<Result>,
    ): Promise<Result> => {
        const lock = await acquireLifecycleLock(
            lifecycleLockPath,
            workspace,
            lifecycleLockTimeoutMs,
            lifecycleLockPollIntervalMs,
            dependencies.pidIsAlive,
            dependencies.sleep,
        );
        try {
            return await mutation();
        } finally {
            lock.release();
        }
    };
    const ensureRunning = (): Promise<PersistentDaemonStatus> =>
        serializeLifecycle(() => withLifecycleLock(ensureRunningUnlocked));
    const stop = (): Promise<PersistentDaemonStatus> =>
        serializeLifecycle(() => withLifecycleLock(stopUnlocked));

    return { workspace, unitName, unitPath, status, ensureRunning, stop };
};
