import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
    redactVerificationOutput,
    runVerification,
    type VerificationInput,
} from './verification.js';

const workspaces: string[] = [];

const createWorkspace = async (): Promise<string> => {
    const workspace = await mkdtemp(join(tmpdir(), 'verification-'));
    workspaces.push(workspace);
    return workspace;
};

const inputFor = (
    cwd: string,
    script: string,
    overrides: Partial<VerificationInput> = {},
): VerificationInput => ({
    id: 'verification-id',
    label: 'Verification label',
    command: process.execPath,
    args: ['-e', script],
    cwd,
    timeoutMs: 2_000,
    maxOutputBytes: 16 * 1024,
    ...overrides,
});

afterAll(async () => {
    await Promise.all(
        workspaces.map(workspace =>
            rm(workspace, { recursive: true, force: true }),
        ),
    );
});

describe('runVerification', () => {
    test('captures successful and failed commands and supports expected exit codes', async () => {
        const workspace = await createWorkspace();
        const script =
            'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;';

        const failed = await runVerification(
            workspace,
            inputFor(workspace, script),
        );
        const expected = await runVerification(
            workspace,
            inputFor(workspace, script, { expectedExitCodes: [3] }),
        );

        expect(failed).toMatchObject({
            id: 'verification-id',
            label: 'Verification label',
            status: 'failed',
            exitCode: 3,
            signal: null,
            stdout: 'out',
            stderr: 'err',
            improvement: 'not-applicable',
        });
        expect(expected.status).toBe('passed');
        expect(expected.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(expected.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(expected.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('times out and reaps a command', async () => {
        const workspace = await createWorkspace();
        const result = await runVerification(
            workspace,
            inputFor(workspace, 'setInterval(() => {}, 1_000);', {
                timeoutMs: 40,
            }),
        );

        expect(result.status).toBe('timed-out');
        expect(result.exitCode).toBeNull();
        expect(result.durationMs).toBeLessThan(1_000);
    });

    test('bounds inherited-pipe draining after the direct child exits', async () => {
        const workspace = await createWorkspace();
        const controller = new AbortController();
        const script = [
            'const { spawn } = require("node:child_process");',
            'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"],',
            '  { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
            'child.unref();',
            'process.stdout.write("direct child done");',
        ].join('\n');

        const result = await runVerification(
            workspace,
            inputFor(workspace, script, {
                signal: controller.signal,
                timeoutMs: 1_500,
            }),
        );

        expect(result).toMatchObject({
            status: 'passed',
            stdout: 'direct child done',
        });
        expect(result.durationMs).toBeLessThan(750);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    test('cancels and reaps a command through AbortSignal', async () => {
        const workspace = await createWorkspace();
        const controller = new AbortController();
        const pending = runVerification(
            workspace,
            inputFor(workspace, 'setInterval(() => {}, 1_000);', {
                signal: controller.signal,
            }),
        );
        setTimeout(() => controller.abort(), 40);

        const result = await pending;

        expect(result.status).toBe('cancelled');
        expect(result.durationMs).toBeLessThan(1_000);
    });

    test('enforces one combined output cap and terminates the command', async () => {
        const workspace = await createWorkspace();
        const result = await runVerification(
            workspace,
            inputFor(
                workspace,
                'setInterval(() => process.stdout.write("x".repeat(4096)), 1);',
                { maxOutputBytes: 1024 },
            ),
        );

        expect(result.status).toBe('output-limit');
        expect(
            Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
        ).toBeLessThanOrEqual(1024);
        expect(result.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    test('rejects cwd escapes and accepts a child directory', async () => {
        const workspace = await createWorkspace();
        const childDirectory = join(workspace, 'child');
        await mkdir(childDirectory);

        const inside = await runVerification(
            workspace,
            inputFor('child', 'process.stdout.write(process.cwd());'),
        );

        expect(inside.status).toBe('passed');
        await expect(
            runVerification(workspace, inputFor('..', 'process.exit(0);')),
        ).rejects.toThrow('inside the workspace root');
    });

    test('returns a structured spawn error', async () => {
        const workspace = await createWorkspace();
        const result = await runVerification(workspace, {
            ...inputFor(workspace, ''),
            command: join(workspace, 'missing-executable'),
            args: [],
        });

        expect(result).toMatchObject({
            status: 'spawn-error',
            exitCode: null,
            signal: null,
        });
        expect(result.stderr).toContain('could not be started');
    });

    test('redacts credentials and exact values without returning environment data', async () => {
        const workspace = await createWorkspace();
        const sensitiveOutput = [
            'https://alice:hunter@example.com/path',
            'Authorization: Bearer abc.def',
            'token=token-value',
            'password: "password value"',
            "client_secret='secret value'",
            'provided-secret',
        ].join('\n');
        const result = await runVerification(
            workspace,
            inputFor(
                workspace,
                `process.stdout.write(${JSON.stringify(sensitiveOutput)} + "\\n" + process.env.PRIVATE_TOKEN);`,
                {
                    secrets: ['provided-secret'],
                    env: {
                        overrides: { PRIVATE_TOKEN: 'environment-secret' },
                    },
                },
            ),
        );

        expect(result.stdout).not.toMatch(
            /alice|hunter|abc\.def|token-value|password value|secret value|provided-secret|environment-secret/,
        );
        expect(result.stdout).toContain('https://[REDACTED]@example.com');
        expect(result).not.toHaveProperty('env');
        expect(result).not.toHaveProperty('command');
        expect(
            redactVerificationOutput('short-long short', [
                'short',
                'short-long',
            ]),
        ).toBe('[REDACTED] [REDACTED]');
    });

    test('produces deterministic output digests and baseline improvement', async () => {
        const workspace = await createWorkspace();
        const script =
            'process.stdout.write("stable\\n"); process.stderr.write("warning\\n"); process.exitCode = 2;';
        const failed = await runVerification(
            workspace,
            inputFor(workspace, script),
        );
        const improved = await runVerification(
            workspace,
            inputFor(workspace, script, {
                expectedExitCodes: [2],
                baseline: failed,
            }),
        );
        const unchanged = await runVerification(
            workspace,
            inputFor(workspace, script, {
                expectedExitCodes: [2],
                baseline: improved,
            }),
        );

        expect(improved.outputDigest).toBe(failed.outputDigest);
        expect(unchanged.outputDigest).toBe(failed.outputDigest);
        expect(improved.improvement).toBe('improved');
        expect(unchanged.improvement).toBe('unchanged');
        expect(improved.baseline).toEqual({
            status: 'failed',
            exitCode: 2,
            outputDigest: failed.outputDigest,
        });
        expect(improved.baseline).not.toHaveProperty('stdout');
    });
});
