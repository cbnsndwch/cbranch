// Git command log (docs/spec/17 REQ-P6-CLOG-001..005). A process-wide, bounded ring
// buffer that the host-`git` invocation runners append to — the argument vector, working
// directory, start time, duration, and exit status of every spawn. It is a diagnostic
// tail only: never persisted, never written to git config, and it stores NO full
// stdout/object bytes (only a bounded stderr excerpt on failure). Credential-bearing
// tokens in argv and in the stderr excerpt are redacted; the environment is never recorded.

/** One recorded host-`git` invocation. `exitCode` is null when the process was killed. */
export interface CommandLogRecord {
    readonly seq: number;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly startedAt: number;
    readonly durationMs: number;
    readonly exitCode: number | null;
    readonly success: boolean;
    /** Bounded, credential-scrubbed stderr excerpt — present only on failure. */
    readonly stderrExcerpt?: string;
}

/** Fixed recent-history size; older entries age out (REQ-P6-CLOG-004). */
export const COMMAND_LOG_CAPACITY = 500;
const STDERR_EXCERPT_MAX = 2000;

let seq = 0;
const buffer: CommandLogRecord[] = [];
type Listener = (record: CommandLogRecord) => void;
const listeners = new Set<Listener>();

/**
 * Redact credential-bearing tokens: URL userinfo passwords (`scheme://user:pass@host`
 * → `scheme://user:***@host`) in any argument or message. Remote auth is out-of-band
 * (BatchMode), so such tokens are rare, but a pasted URL could carry one (REQ-P6-CLOG-003).
 */
export const redactSecret = (text: string): string =>
    text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/gi, '$1:***@');

const redactArgv = (argv: ReadonlyArray<string>): string[] =>
    argv.map(redactSecret);

/** Append one invocation to the ring buffer and notify live subscribers. Never throws. */
export const recordInvocation = (
    record: Omit<CommandLogRecord, 'seq' | 'argv' | 'stderrExcerpt'> & {
        readonly argv: ReadonlyArray<string>;
        readonly stderrExcerpt?: string;
    },
): void => {
    const full: CommandLogRecord = {
        seq: seq++,
        argv: redactArgv(record.argv),
        cwd: record.cwd,
        startedAt: record.startedAt,
        durationMs: record.durationMs,
        exitCode: record.exitCode,
        success: record.success,
        stderrExcerpt:
            record.stderrExcerpt === undefined
                ? undefined
                : redactSecret(
                      record.stderrExcerpt.slice(0, STDERR_EXCERPT_MAX),
                  ),
    };
    buffer.push(full);
    if (buffer.length > COMMAND_LOG_CAPACITY) buffer.shift();
    for (const listener of listeners) {
        try {
            listener(full);
        } catch {
            // A misbehaving subscriber must never break the git runner.
        }
    }
};

/** Read the buffer newest-first, optionally capped to `limit` entries (REQ-P6-CLOG-001). */
export const listInvocations = (
    predicate?: (record: CommandLogRecord) => boolean,
    limit?: number,
): CommandLogRecord[] => {
    const out: CommandLogRecord[] = [];
    for (let i = buffer.length - 1; i >= 0; i--) {
        const rec = buffer[i]!;
        if (predicate === undefined || predicate(rec)) out.push(rec);
        if (limit !== undefined && out.length >= limit) break;
    }
    return out;
};

/** Register a live-tail listener; returns an unsubscribe function (REQ-P6-CLOG-005). */
export const subscribeInvocations = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** Reset the buffer (test hook only; the log is otherwise process-lifetime state). */
export const resetCommandLog = (): void => {
    buffer.length = 0;
    seq = 0;
};

/** Build a completed record's timing/exit fields for a spawn that reached `close`. */
export const excerptStderr = (stderr: string): string =>
    stderr.slice(0, STDERR_EXCERPT_MAX);
