import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_CAP_BYTES = 64 * 1_024;
const TERMINATION_GRACE_MS = 2_000;
const listeningPattern =
    /\bopencode server listening on (http:\/\/127\.0\.0\.1:\d+)\b/u;

export type ManagedOpenCodeExit = {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
};

export interface ManagedOpenCodeServer {
    readonly url: string;
    readonly exited: Promise<ManagedOpenCodeExit>;
    readonly close: () => Promise<void>;
}

export type ManagedOpenCodeServerOptions = {
    readonly executablePath: string;
    readonly workspace: string;
    readonly startupTimeoutMs?: number;
    readonly outputCapBytes?: number;
    readonly writeOutput?: (value: string) => void;
    readonly spawnProcess?: typeof spawn;
};

const boundedInteger = (
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
        .slice(0, 1_000);

const stopChild = async (
    child: ChildProcess,
    exited: Promise<ManagedOpenCodeExit>,
): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const wait = async (): Promise<boolean> =>
        await Promise.race([
            exited.then(() => true),
            new Promise<false>(resolvePromise =>
                setTimeout(() => resolvePromise(false), TERMINATION_GRACE_MS),
            ),
        ]);
    if (await wait()) return;
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
    }
    await wait();
};

/** Starts a private loopback OpenCode server for one managed daemon service. */
export const startManagedOpenCodeServer = async (
    options: ManagedOpenCodeServerOptions,
): Promise<ManagedOpenCodeServer> => {
    if (!isAbsolute(options.executablePath)) {
        throw new Error(
            'Managed OpenCode executable must be an absolute path.',
        );
    }
    if (!isAbsolute(options.workspace)) {
        throw new Error('Managed OpenCode workspace must be an absolute path.');
    }
    const startupTimeoutMs = boundedInteger(
        options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        'startupTimeoutMs',
        5 * 60_000,
    );
    const outputCapBytes = boundedInteger(
        options.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
        'outputCapBytes',
        2 * 1_024 * 1_024,
    );
    const child = (options.spawnProcess ?? spawn)(
        resolve(options.executablePath),
        ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs'],
        {
            cwd: resolve(options.workspace),
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );
    if (!child.stdout || !child.stderr) {
        child.kill('SIGKILL');
        throw new Error('Managed OpenCode output pipes were unavailable.');
    }

    let resolveExit!: (exit: ManagedOpenCodeExit) => void;
    let exitResolved = false;
    const exited = new Promise<ManagedOpenCodeExit>(resolvePromise => {
        resolveExit = exit => {
            if (exitResolved) return;
            exitResolved = true;
            resolvePromise(exit);
        };
    });

    let startupOutput = '';
    let startupBytes = 0;
    let startupSettled = false;
    let resolveStartup!: (url: string) => void;
    let rejectStartup!: (error: Error) => void;
    const startup = new Promise<string>((resolvePromise, rejectPromise) => {
        resolveStartup = resolvePromise;
        rejectStartup = rejectPromise;
    });
    const timeout = setTimeout(() => {
        if (startupSettled) return;
        startupSettled = true;
        rejectStartup(new Error('Managed OpenCode server startup timed out.'));
        child.kill('SIGTERM');
    }, startupTimeoutMs);

    const observeOutput = (chunk: Buffer): void => {
        try {
            options.writeOutput?.(chunk.toString('utf8'));
        } catch {
            // Diagnostics must not control the managed server lifecycle.
        }
        if (startupSettled) return;
        startupBytes += chunk.byteLength;
        if (startupBytes > outputCapBytes) {
            startupSettled = true;
            clearTimeout(timeout);
            rejectStartup(
                new Error(
                    'Managed OpenCode startup output exceeded the safety limit.',
                ),
            );
            child.kill('SIGTERM');
            return;
        }
        startupOutput += chunk.toString('utf8');
        const match = listeningPattern.exec(startupOutput);
        if (!match?.[1]) return;
        startupSettled = true;
        clearTimeout(timeout);
        resolveStartup(new URL(match[1]).href);
    };

    child.stdout.on('data', chunk => observeOutput(Buffer.from(chunk)));
    child.stderr.on('data', chunk => observeOutput(Buffer.from(chunk)));
    child.once('error', error => {
        resolveExit({ code: null, signal: null, error });
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timeout);
        rejectStartup(error);
    });
    child.once('exit', (code, signal) => {
        resolveExit({ code, signal });
        if (startupSettled) return;
        startupSettled = true;
        clearTimeout(timeout);
        rejectStartup(
            new Error(
                `Managed OpenCode server exited before readiness: ${concise(startupOutput) || `exit ${code ?? signal ?? 'unknown'}`}.`,
            ),
        );
    });

    let url: string;
    try {
        url = await startup;
    } catch (error) {
        await stopChild(child, exited);
        throw error;
    }

    return {
        url,
        exited,
        close: async () => await stopChild(child, exited),
    };
};
