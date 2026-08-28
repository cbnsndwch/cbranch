import { readFileSync } from 'node:fs';

export type ProcessIdentity = `linux:${string}:${string}`;

/** Linux boot ID plus /proc start time distinguishes a PID from a later reuse. */
export const processIdentity = (pid: number): ProcessIdentity | undefined => {
    if (
        process.platform !== 'linux' ||
        !Number.isSafeInteger(pid) ||
        pid <= 0
    ) {
        return undefined;
    }
    try {
        const bootId = readFileSync(
            '/proc/sys/kernel/random/boot_id',
            'utf8',
        ).trim();
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closingParenthesis = stat.lastIndexOf(')');
        const startTime = stat.slice(closingParenthesis + 2).split(' ')[19];
        if (
            !/^[0-9a-f-]{36}$/iu.test(bootId) ||
            !/^\d+$/u.test(startTime ?? '')
        ) {
            return undefined;
        }
        return `linux:${bootId.toLowerCase()}:${startTime}`;
    } catch {
        return undefined;
    }
};

export const isProcessIdentity = (value: unknown): value is ProcessIdentity =>
    typeof value === 'string' &&
    /^linux:[0-9a-f]{8}-[0-9a-f-]{27}:\d+$/u.test(value);
