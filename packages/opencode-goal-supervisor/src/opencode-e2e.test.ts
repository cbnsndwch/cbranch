import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { SCHEMA_VERSION, type OutboxCommand } from './domain.js';
import { createOpenCodeAdapter } from './opencode-adapter.js';

const workspaces: string[] = [];
const processes: ChildProcess[] = [];

const availablePort = async (): Promise<number> =>
    await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                reject(new Error('Could not allocate a local test port.'));
                return;
            }
            server.close(error =>
                error ? reject(error) : resolve(address.port),
            );
        });
    });

const stopProcess = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([
        new Promise<void>(resolve => child.once('close', () => resolve())),
        new Promise<void>(resolve =>
            setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 2_000),
        ),
    ]);
};

const bounded = async <Value>(
    label: string,
    promise: Promise<Value>,
    timeoutMs = 10_000,
): Promise<Value> =>
    await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) =>
            setTimeout(
                () => reject(new Error(`${label} timed out.`)),
                timeoutMs,
            ),
        ),
    ]);

afterEach(async () => {
    await Promise.all(processes.splice(0).map(stopProcess));
    await Promise.all(
        workspaces
            .splice(0)
            .map(workspace => rm(workspace, { recursive: true, force: true })),
    );
});

test.runIf(process.env.CBRANCH_OPENCODE_E2E === '1')(
    'dispatches idempotently through a temporary OpenCode server',
    async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'goal-opencode-e2e-'));
        workspaces.push(workspace);
        const port = await availablePort();
        const child = spawn(
            process.env.CBRANCH_OPENCODE_BIN ?? 'opencode',
            [
                'serve',
                '--pure',
                '--hostname',
                '127.0.0.1',
                '--port',
                String(port),
            ],
            {
                cwd: workspace,
                env: {
                    ...process.env,
                    XDG_CONFIG_HOME: join(workspace, '.config'),
                    XDG_DATA_HOME: join(workspace, '.data'),
                    XDG_CACHE_HOME: join(workspace, '.cache'),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            },
        );
        processes.push(child);
        let serverOutput = '';
        const listening = new Promise<void>(resolve => {
            const capture = (chunk: Buffer): void => {
                serverOutput += chunk.toString('utf8');
                if (serverOutput.includes('server listening on')) resolve();
            };
            child.stdout?.on('data', capture);
            child.stderr?.on('data', capture);
        });
        const startupError = new Promise<never>((_resolve, reject) =>
            child.once('error', reject),
        );
        try {
            await bounded(
                'OpenCode server startup',
                Promise.race([listening, startupError]),
            );
        } catch (error) {
            throw new Error(
                `${error instanceof Error ? error.message : String(error)} ${serverOutput}`,
                { cause: error },
            );
        }
        const adapter = await createOpenCodeAdapter({
            baseUrl: `http://127.0.0.1:${port}`,
            directory: workspace,
        });
        const deadline = Date.now() + 10_000;
        while (true) {
            // oxlint-disable-next-line eslint/no-await-in-loop
            const health = await bounded(
                'OpenCode health check',
                adapter.health(),
            );
            if (health.healthy) break;
            if (Date.now() >= deadline) {
                throw new Error(
                    'Temporary OpenCode server did not become ready.',
                );
            }
            // oxlint-disable-next-line eslint/no-await-in-loop
            await Promise.race([
                startupError,
                new Promise(resolve => setTimeout(resolve, 100)),
            ]);
        }

        const command: OutboxCommand = {
            schemaVersion: SCHEMA_VERSION,
            id: 'outbox-e2e',
            type: 'dispatch-attempt',
            goalId: 'goal-e2e',
            workUnitId: 'unit-e2e',
            attemptId: 'attempt-e2e',
            leaseToken: 'lease-e2e-1234567890',
            idempotencyKey: 'attempt:attempt-e2e',
            payload: {
                kind: 'agent',
                input: {
                    title: 'E2E fixture',
                    instructions: 'Return a structured failed outcome.',
                    acceptanceCriteria: ['The session is created once'],
                },
            },
            createdAt: new Date().toISOString(),
        };
        const input = {
            idempotencyKey: command.idempotencyKey,
            command,
            workspace,
        };

        const first = await bounded('first dispatch', adapter.dispatch(input));
        const second = await bounded(
            'second dispatch',
            adapter.dispatch(input),
        );

        expect(second).toEqual(first);
        expect(['absent', 'active', 'completed', 'unknown']).toContain(
            (await bounded('probe', adapter.probe(input))).status,
        );
        await expect(
            bounded(
                'abort',
                adapter.abort({
                    externalRef: first.externalRef,
                    workspace,
                    reason: 'E2E fixture complete',
                }),
            ),
        ).resolves.toMatchObject({ aborted: expect.any(Boolean) });
    },
    30_000,
);
