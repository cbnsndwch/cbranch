import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type VerificationStatus =
    | 'passed'
    | 'failed'
    | 'timed-out'
    | 'cancelled'
    | 'output-limit'
    | 'spawn-error';

export type VerificationImprovement =
    | 'improved'
    | 'unchanged'
    | 'regressed'
    | 'not-applicable';

export interface VerificationBaseline {
    readonly status: VerificationStatus;
    readonly exitCode?: number | null;
    readonly outputDigest?: string;
}

export interface VerificationEnvironment {
    /** Additional names whose values may be inherited from the parent process. */
    readonly allowlist?: ReadonlyArray<string>;
    /** Explicit values to add, replace, or remove from the controlled environment. */
    readonly overrides?: Readonly<Record<string, string | undefined>>;
}

export interface VerificationInput {
    readonly id: string;
    readonly label: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly expectedExitCodes?: ReadonlyArray<number>;
    readonly baseline?: VerificationBaseline;
    readonly env?: VerificationEnvironment;
    readonly secrets?: ReadonlyArray<string>;
    readonly redactionValues?: ReadonlyArray<string>;
    readonly signal?: AbortSignal;
}

export interface VerificationResult {
    readonly id: string;
    readonly label: string;
    readonly status: VerificationStatus;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly outputDigest: string;
    readonly baseline?: VerificationBaseline;
    readonly improvement: VerificationImprovement;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MIN_MAX_OUTPUT_BYTES = 1;
const MAX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const INHERITED_ENV_NAMES = [
    'PATH',
    'HOME',
    'SystemRoot',
    'TEMP',
    'TMP',
    'TMPDIR',
] as const;

const FIXED_ENV: Readonly<Record<string, string>> = {
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    CLICOLOR_FORCE: '0',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: process.execPath,
    GIT_CORE_ASKPASS: process.execPath,
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    GCM_INTERACTIVE: 'Never',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    SYSTEMD_PAGER: 'cat',
    GH_PROMPT_DISABLED: '1',
    NPM_CONFIG_COLOR: 'false',
};

const STATUS_RANK: Readonly<Record<VerificationStatus, number>> = {
    'spawn-error': 0,
    cancelled: 0,
    'timed-out': 1,
    'output-limit': 1,
    failed: 2,
    passed: 3,
};

const escapeRegularExpression = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remove common credential forms and exact caller-supplied values from output. */
export const redactVerificationOutput = (
    output: string,
    redactionValues: ReadonlyArray<string> = [],
): string => {
    const exactValues = [...new Set(redactionValues.filter(Boolean))].toSorted(
        (left, right) =>
            right.length - left.length ||
            (left < right ? -1 : left > right ? 1 : 0),
    );

    let redacted = output;
    for (const value of exactValues) {
        redacted = redacted.replace(
            new RegExp(escapeRegularExpression(value), 'g'),
            '[REDACTED]',
        );
    }

    redacted = redacted.replace(
        /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
        '$1[REDACTED]@',
    );
    redacted = redacted.replace(
        /\b(Bearer)[ \t]+[^\s,;"']+/gi,
        '$1 [REDACTED]',
    );

    const sensitiveKey = '[a-z0-9_.-]*(?:token|password|secret)[a-z0-9_.-]*';
    redacted = redacted.replace(
        new RegExp(
            `(^|[^a-z0-9_.-])(["']?)(${sensitiveKey})\\2` +
                `(\\s*(?:=|:)\\s*)(["'])([^\\r\\n]*?)\\5`,
            'gim',
        ),
        '$1$2$3$2$4$5[REDACTED]$5',
    );
    redacted = redacted.replace(
        new RegExp(
            `(^|[^a-z0-9_.-])(["']?)(${sensitiveKey})\\2` +
                `(\\s*(?:=|:)\\s*)([^\\s,;"']+)`,
            'gim',
        ),
        '$1$2$3$2$4[REDACTED]',
    );

    return redacted;
};

const boundedInteger = (
    name: string,
    value: number | undefined,
    defaultValue: number,
    minimum: number,
    maximum: number,
): number => {
    const resolvedValue = value ?? defaultValue;
    if (
        !Number.isSafeInteger(resolvedValue) ||
        resolvedValue < minimum ||
        resolvedValue > maximum
    ) {
        throw new RangeError(
            `${name} must be an integer from ${minimum} through ${maximum}.`,
        );
    }
    return resolvedValue;
};

const errorCode = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null || !('code' in error))
        return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
};

const realpathWhenAvailable = async (path: string): Promise<string> => {
    try {
        return await realpath(path);
    } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR') return path;
        throw new Error('Verification path could not be resolved.', {
            cause: error,
        });
    }
};

const resolveVerificationCwd = async (
    workspaceRoot: string,
    cwd: string,
): Promise<string> => {
    if (workspaceRoot.length === 0)
        throw new TypeError('workspaceRoot must not be empty.');
    if (cwd.length === 0) throw new TypeError('cwd must not be empty.');

    const resolvedRoot = resolve(workspaceRoot);
    const resolvedCwd = isAbsolute(cwd)
        ? resolve(cwd)
        : resolve(resolvedRoot, cwd);
    const [canonicalRoot, canonicalCwd] = await Promise.all([
        realpathWhenAvailable(resolvedRoot),
        realpathWhenAvailable(resolvedCwd),
    ]);
    const fromRoot = relative(canonicalRoot, canonicalCwd);
    if (
        fromRoot === '..' ||
        fromRoot.startsWith(`..${sep}`) ||
        isAbsolute(fromRoot)
    ) {
        throw new Error('Verification cwd must be inside the workspace root.');
    }
    return canonicalCwd;
};

const validEnvironmentName = (name: string): boolean =>
    /^[a-z_][a-z0-9_]*$/i.test(name);

const inheritedEnvironmentValue = (name: string): string | undefined => {
    const directValue = process.env[name];
    if (directValue !== undefined || process.platform !== 'win32')
        return directValue;
    const actualName = Object.keys(process.env).find(
        candidate => candidate.toLowerCase() === name.toLowerCase(),
    );
    return actualName === undefined ? undefined : process.env[actualName];
};

const setEnvironmentValue = (
    env: NodeJS.ProcessEnv,
    name: string,
    value: string | undefined,
): void => {
    if (process.platform === 'win32') {
        const existingName = Object.keys(env).find(
            candidate => candidate.toLowerCase() === name.toLowerCase(),
        );
        if (existingName !== undefined) delete env[existingName];
    }
    if (value !== undefined) env[name] = value;
};

const controlledEnvironment = (
    input: VerificationEnvironment | undefined,
): {
    readonly env: NodeJS.ProcessEnv;
    readonly secrets: ReadonlyArray<string>;
} => {
    const env = Object.create(null) as NodeJS.ProcessEnv;
    const inheritedNames = [
        ...INHERITED_ENV_NAMES,
        ...(input?.allowlist ?? []),
    ];
    for (const name of inheritedNames) {
        if (!validEnvironmentName(name))
            throw new TypeError(
                'Environment allowlist contains an invalid name.',
            );
        setEnvironmentValue(env, name, inheritedEnvironmentValue(name));
    }

    for (const [name, value] of Object.entries(input?.overrides ?? {})) {
        if (!validEnvironmentName(name))
            throw new TypeError(
                'Environment overrides contain an invalid name.',
            );
        if (value?.includes('\0'))
            throw new TypeError(
                'Environment values must not contain null bytes.',
            );
        setEnvironmentValue(env, name, value);
    }
    for (const [name, value] of Object.entries(FIXED_ENV))
        setEnvironmentValue(env, name, value);

    const secrets = Object.entries(env)
        .filter(
            ([name, value]) =>
                value !== undefined &&
                /(token|password|secret|credential|auth|api[_-]?key|private[_-]?key)/i.test(
                    name,
                ),
        )
        .map(([, value]) => value!);
    return { env, secrets };
};

const normalizeBaseline = (
    baseline: VerificationBaseline | undefined,
): VerificationBaseline | undefined => {
    if (baseline === undefined) return undefined;
    if (!Object.hasOwn(STATUS_RANK, baseline.status))
        throw new TypeError('Verification baseline has an invalid status.');
    if (
        baseline.exitCode !== undefined &&
        baseline.exitCode !== null &&
        !Number.isSafeInteger(baseline.exitCode)
    ) {
        throw new TypeError('Verification baseline has an invalid exit code.');
    }
    if (
        baseline.outputDigest !== undefined &&
        !/^[a-f0-9]{64}$/.test(baseline.outputDigest)
    ) {
        throw new TypeError(
            'Verification baseline has an invalid output digest.',
        );
    }
    return {
        status: baseline.status,
        ...(baseline.exitCode === undefined
            ? {}
            : { exitCode: baseline.exitCode }),
        ...(baseline.outputDigest === undefined
            ? {}
            : { outputDigest: baseline.outputDigest }),
    };
};

const improvementFrom = (
    status: VerificationStatus,
    baseline: VerificationBaseline | undefined,
): VerificationImprovement => {
    if (baseline === undefined) return 'not-applicable';
    const difference = STATUS_RANK[status] - STATUS_RANK[baseline.status];
    if (difference > 0) return 'improved';
    if (difference < 0) return 'regressed';
    return 'unchanged';
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
    if (maximumBytes === 0) return '';
    const buffer = Buffer.from(value);
    if (buffer.length <= maximumBytes) return value;
    return new StringDecoder('utf8').write(buffer.subarray(0, maximumBytes));
};

const finalizeOutput = (
    stdoutChunks: ReadonlyArray<Buffer>,
    stderrChunks: ReadonlyArray<Buffer>,
    maximumBytes: number,
    redactionValues: ReadonlyArray<string>,
    additionalStderr = '',
): {
    readonly stdout: string;
    readonly stderr: string;
    readonly outputDigest: string;
} => {
    const redactedStdout = redactVerificationOutput(
        Buffer.concat(stdoutChunks).toString('utf8'),
        redactionValues,
    );
    const rawStderr = Buffer.concat(stderrChunks).toString('utf8');
    const redactedStderr = redactVerificationOutput(
        `${rawStderr}${rawStderr && additionalStderr ? '\n' : ''}${additionalStderr}`,
        redactionValues,
    );
    const stdout = truncateUtf8(redactedStdout, maximumBytes);
    const remainingBytes = maximumBytes - Buffer.byteLength(stdout, 'utf8');
    const stderr = truncateUtf8(redactedStderr, remainingBytes);
    const outputDigest = createHash('sha256')
        .update(JSON.stringify({ stdout, stderr }))
        .digest('hex');
    return { stdout, stderr, outputDigest };
};

const spawnErrorOutput = (error: unknown): string => {
    const code = errorCode(error);
    return code === undefined
        ? 'Verification process could not be started.'
        : `Verification process could not be started (${code}).`;
};

type TerminationStatus = 'timed-out' | 'cancelled' | 'output-limit';

/** Execute one bounded, non-interactive verification command without a shell. */
export const runVerification = async (
    workspaceRoot: string,
    input: VerificationInput,
): Promise<VerificationResult> => {
    const timeoutMs = boundedInteger(
        'timeoutMs',
        input.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
    );
    const maxOutputBytes = boundedInteger(
        'maxOutputBytes',
        input.maxOutputBytes,
        DEFAULT_MAX_OUTPUT_BYTES,
        MIN_MAX_OUTPUT_BYTES,
        MAX_MAX_OUTPUT_BYTES,
    );
    if (input.command.length === 0)
        throw new TypeError('command must not be empty.');
    const expectedExitCodes = new Set(input.expectedExitCodes ?? [0]);
    if (
        expectedExitCodes.size === 0 ||
        [...expectedExitCodes].some(code => !Number.isSafeInteger(code))
    ) {
        throw new TypeError('expectedExitCodes must contain integers.');
    }

    const cwd = await resolveVerificationCwd(workspaceRoot, input.cwd);
    const baseline = normalizeBaseline(input.baseline);
    const controlled = controlledEnvironment(input.env);
    const redactionValues = [
        ...(input.secrets ?? []),
        ...(input.redactionValues ?? []),
        ...controlled.secrets,
    ];
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const startedAtMonotonic = process.hrtime.bigint();

    const resultFor = (
        status: VerificationStatus,
        exitCode: number | null,
        signal: NodeJS.Signals | null,
        stdoutChunks: ReadonlyArray<Buffer>,
        stderrChunks: ReadonlyArray<Buffer>,
        additionalStderr = '',
    ): VerificationResult => {
        const finishedAt = new Date().toISOString();
        const durationMs =
            Number(process.hrtime.bigint() - startedAtMonotonic) / 1_000_000;
        return {
            id: input.id,
            label: input.label,
            status,
            exitCode,
            signal,
            startedAt,
            finishedAt,
            durationMs,
            ...finalizeOutput(
                stdoutChunks,
                stderrChunks,
                maxOutputBytes,
                redactionValues,
                additionalStderr,
            ),
            ...(baseline === undefined ? {} : { baseline }),
            improvement: improvementFrom(status, baseline),
        };
    };

    if (input.signal?.aborted)
        return resultFor('cancelled', null, null, [], []);

    let child: ChildProcess;
    try {
        child = spawn(input.command, [...input.args], {
            cwd,
            env: controlled.env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
    } catch (error) {
        return resultFor(
            'spawn-error',
            null,
            null,
            [],
            [],
            spawnErrorOutput(error),
        );
    }

    return await new Promise(resolveResult => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let capturedBytes = 0;
        let closed = false;
        let exited = false;
        let termination: TerminationStatus | undefined;
        let processError: unknown;
        let timeout: NodeJS.Timeout | undefined;
        let drainTimeout: NodeJS.Timeout | undefined;
        let directExitCode: number | null = null;
        let directExitSignal: NodeJS.Signals | null = null;

        const clearRunTimeout = (): void => {
            if (timeout !== undefined) clearTimeout(timeout);
            timeout = undefined;
        };

        const clearDrainTimeout = (): void => {
            if (drainTimeout !== undefined) clearTimeout(drainTimeout);
            drainTimeout = undefined;
        };

        const closeInheritedPipes = (): void => {
            child.stdout?.destroy();
            child.stderr?.destroy();
        };

        const requestTermination = (status: TerminationStatus): void => {
            if (
                closed ||
                processError !== undefined ||
                termination !== undefined
            ) {
                return;
            }
            termination = status;
            clearRunTimeout();
            if (exited) {
                closeInheritedPipes();
                return;
            }
            try {
                child.kill('SIGKILL');
            } catch {
                // The close event remains authoritative and reaps a concurrent exit.
            }
        };

        const capture = (chunks: Buffer[], chunk: Buffer | string): void => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = maxOutputBytes - capturedBytes;
            if (buffer.length <= remaining) {
                chunks.push(buffer);
                capturedBytes += buffer.length;
                return;
            }
            if (remaining > 0) {
                chunks.push(Buffer.from(buffer.subarray(0, remaining)));
                capturedBytes += remaining;
            }
            requestTermination('output-limit');
        };

        const onProcessError = (error: unknown): void => {
            if (processError === undefined) processError = error;
            clearRunTimeout();
            if (!exited && termination === undefined) {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // A spawn failure has no live process to kill.
                }
            }
        };

        const onAbort = (): void => requestTermination('cancelled');
        input.signal?.addEventListener('abort', onAbort, { once: true });

        child.once('error', onProcessError);
        child.stdout?.on('error', onProcessError);
        child.stderr?.on('error', onProcessError);
        child.stdout?.on('data', chunk => capture(stdoutChunks, chunk));
        child.stderr?.on('data', chunk => capture(stderrChunks, chunk));
        child.once('exit', (exitCode, signal) => {
            exited = true;
            directExitCode = exitCode;
            directExitSignal = signal;
            drainTimeout = setTimeout(closeInheritedPipes, 100);
            drainTimeout.unref();
        });
        child.once('close', (exitCode, signal) => {
            if (closed) return;
            closed = true;
            clearRunTimeout();
            clearDrainTimeout();
            input.signal?.removeEventListener('abort', onAbort);

            const settledExitCode = exited ? directExitCode : exitCode;
            const settledSignal = exited ? directExitSignal : signal;

            const status =
                termination ??
                (processError === undefined
                    ? expectedExitCodes.has(settledExitCode ?? Number.NaN)
                        ? 'passed'
                        : 'failed'
                    : 'spawn-error');
            const additionalStderr =
                processError === undefined
                    ? ''
                    : spawnErrorOutput(processError);
            resolveResult(
                resultFor(
                    status,
                    processError === undefined ? settledExitCode : null,
                    settledSignal,
                    stdoutChunks,
                    stderrChunks,
                    additionalStderr,
                ),
            );
        });

        if (input.signal?.aborted) requestTermination('cancelled');
        if (termination === undefined && processError === undefined) {
            timeout = setTimeout(
                () => requestTermination('timed-out'),
                timeoutMs,
            );
            timeout.unref();
        }
    });
};
