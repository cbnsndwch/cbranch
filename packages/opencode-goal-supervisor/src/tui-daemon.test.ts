import { randomUUID } from 'node:crypto';
import {
    access,
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { DaemonServiceStatus } from './systemd.js';
import {
    systemdServiceIdentity,
    type SystemdServiceIdentity,
    writeSystemdUserService,
} from './systemd.js';
import {
    createPersistentDaemonManager,
    createTuiBridgeClient,
    pathProgramCandidates,
    ProcessTerminationError,
    runProcessWithoutShell,
    workspaceSystemdUnitName,
    type ProcessResult,
    type ProcessRunner,
} from './tui-daemon.js';
import {
    MAX_TUI_BRIDGE_REQUEST_BYTES,
    TUI_BRIDGE_COMMAND,
    TUI_BRIDGE_PROTOCOL,
} from './tui-protocol.js';
import { processIdentity } from './process-identity.js';

const directories: string[] = [];
const lockToken = '00000000-0000-4000-8000-000000000000';

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-tui-daemon-'));
    directories.push(directory);
    return directory;
};

const programFiles = async (root: string) => {
    const nodePath = join(root, 'node');
    const openCodePath = join(root, 'opencode');
    const systemctlPath = join(root, 'systemctl');
    const cliPath = join(root, 'cli.js');
    await Promise.all([
        writeFile(nodePath, '#!/bin/sh\n', { mode: 0o700 }),
        writeFile(openCodePath, '#!/bin/sh\n', { mode: 0o700 }),
        writeFile(systemctlPath, '#!/bin/sh\n', { mode: 0o700 }),
        writeFile(cliPath, 'export {};\n', { mode: 0o600 }),
    ]);
    await Promise.all([
        chmod(nodePath, 0o700),
        chmod(openCodePath, 0o700),
        chmod(systemctlPath, 0o700),
    ]);
    return { nodePath, openCodePath, systemctlPath, cliPath };
};

const stopped = (lockPath: string): DaemonServiceStatus => ({
    status: 'stopped',
    lockPath,
});

const running = (
    lockPath: string,
    workspace: string,
    pid: number,
    ready = true,
    serviceIdentity?: SystemdServiceIdentity,
): DaemonServiceStatus => ({
    status: 'running',
    lockPath,
    workspace,
    pid,
    token: lockToken,
    createdAt: '2026-01-01T00:00:00.000Z',
    ready,
    ...(serviceIdentity ? { serviceIdentity } : {}),
});

const processResult = (
    stdout = '',
    stderr = '',
    exitCode = 0,
): ProcessResult => ({ stdout, stderr, exitCode });

const unitState = (
    activeState: string,
    mainPid: number,
    loadState = 'loaded',
    subState = activeState === 'active' ? 'running' : 'dead',
    fragmentPath = '',
    unitFileState = loadState === 'loaded' ? 'enabled' : 'disabled',
): string =>
    [
        `LoadState=${loadState}`,
        `ActiveState=${activeState}`,
        `SubState=${subState}`,
        `MainPID=${mainPid}`,
        `FragmentPath=${fragmentPath}`,
        `UnitFileState=${unitFileState}`,
        '',
    ].join('\n');

describe('one-shot Node TUI bridge', () => {
    test('builds systemctl candidates only from absolute safe PATH entries', () => {
        expect(
            pathProgramCandidates(
                'systemctl',
                ['/opt/systemd/bin', 'relative/bin', '/unsafe\npath'].join(
                    delimiter,
                ),
            ),
        ).toEqual(['/opt/systemd/bin/systemctl']);
    });

    test('falls back from a Bun-like execPath and sends exact token-free stdio without a shell argument', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const bunPath = join(root, 'bun');
        await writeFile(bunPath, '#!/bin/sh\n', { mode: 0o700 });
        await chmod(bunPath, 0o700);
        const calls: {
            readonly executable: string;
            readonly arguments_: readonly string[];
            readonly options: Parameters<ProcessRunner>[2];
        }[] = [];
        const runner: ProcessRunner = vi.fn(
            async (executable, arguments_, options) => {
                calls.push({ executable, arguments_, options });
                if (arguments_[0] === '--version') {
                    return basename(executable) === 'bun'
                        ? processResult('1.2.3\n')
                        : processResult('v20.20.0\n');
                }
                const request = JSON.parse(options?.stdin ?? '') as {
                    readonly operation: 'init' | 'launch' | 'list';
                };
                return processResult(
                    `${JSON.stringify(
                        request.operation === 'init'
                            ? {
                                  protocol: TUI_BRIDGE_PROTOCOL,
                                  ok: true,
                                  operation: 'init',
                                  workspace,
                              }
                            : request.operation === 'list'
                              ? {
                                    protocol: TUI_BRIDGE_PROTOCOL,
                                    ok: true,
                                    operation: 'list',
                                    total: 1,
                                    hasExecuting: true,
                                    goals: [
                                        {
                                            id: 'goal-1',
                                            state: 'executing',
                                            objective: 'Execute the plan',
                                        },
                                    ],
                                }
                              : {
                                    protocol: TUI_BRIDGE_PROTOCOL,
                                    ok: true,
                                    operation: 'launch',
                                    goal: {
                                        id: 'goal-1',
                                        state: 'achieved',
                                    },
                                },
                    )}\n`,
                );
            },
        );
        const client = await createTuiBridgeClient({
            cliPath: paths.cliPath,
            dependencies: {
                nodeCandidates: [bunPath, paths.nodePath],
                runProcess: runner,
            },
        });

        await expect(client.init(workspace)).resolves.toEqual({ workspace });
        await expect(client.list(workspace)).resolves.toEqual({
            total: 1,
            hasExecuting: true,
            goals: [
                {
                    id: 'goal-1',
                    state: 'executing',
                    objective: 'Execute the plan',
                },
            ],
        });
        await expect(
            client.launch({
                workspace,
                planPath: join(workspace, 'goal.md'),
                planMarkdown: 'goal plan',
                actor: 'tui',
            }),
        ).resolves.toEqual({
            goal: { id: 'goal-1', state: 'achieved' },
        });

        expect(client.verifiedPrograms).toMatchObject({
            nodePath: paths.nodePath,
            cliPath: paths.cliPath,
            programFileIdentity: expect.stringContaining(paths.nodePath),
        });
        const bridgeCalls = calls.filter(
            call => call.arguments_[1] === TUI_BRIDGE_COMMAND,
        );
        expect(bridgeCalls).toHaveLength(3);
        const bridgeCall = bridgeCalls[0]!;
        expect(bridgeCall.executable).toBe(paths.nodePath);
        expect(bridgeCall.arguments_).toEqual([
            paths.cliPath,
            TUI_BRIDGE_COMMAND,
        ]);
        expect(JSON.parse(bridgeCall.options?.stdin ?? '')).toEqual({
            protocol: TUI_BRIDGE_PROTOCOL,
            operation: 'init',
            workspace,
        });
        expect(bridgeCall.options?.stdin).not.toMatch(
            /auth|control|secret|token/iu,
        );
        expect(
            bridgeCalls.every(call => call.executable === paths.nodePath),
        ).toBe(true);
        expect(bridgeCalls.map(call => call.arguments_)).toEqual([
            [paths.cliPath, TUI_BRIDGE_COMMAND],
            [paths.cliPath, TUI_BRIDGE_COMMAND],
            [paths.cliPath, TUI_BRIDGE_COMMAND],
        ]);
        expect(bridgeCalls.map(call => call.options?.stdin)).not.toContainEqual(
            expect.stringMatching(/auth|control|secret|token/iu),
        );
    });

    test('runProcessWithoutShell preserves argv and stdin literally', async () => {
        const root = await temporaryDirectory();
        const marker = join(root, 'shell-was-used');
        const argument = `$(touch ${marker})`;
        const source = [
            "let input = '';",
            "process.stdin.setEncoding('utf8');",
            "process.stdin.on('data', chunk => { input += chunk; });",
            "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argument: process.argv[1], input })));",
        ].join('');

        const result = await runProcessWithoutShell(
            process.execPath,
            ['-e', source, argument],
            { stdin: 'strict-json-input\n' },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            argument,
            input: 'strict-json-input\n',
        });
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    test('rejects malformed, wrong-operation, failure, and nonzero bridge responses', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const responses: ProcessResult[] = [];
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) =>
            arguments_[0] === '--version'
                ? processResult('v20.20.0\n')
                : responses.shift()!,
        );
        const client = await createTuiBridgeClient({
            nodePath: paths.nodePath,
            cliPath: paths.cliPath,
            dependencies: { runProcess: runner },
        });

        responses.push(processResult('not-json'));
        await expect(client.init(workspace)).rejects.toThrow('malformed JSON');

        responses.push(
            processResult(
                JSON.stringify({
                    protocol: TUI_BRIDGE_PROTOCOL,
                    ok: true,
                    operation: 'list',
                    total: 0,
                    hasExecuting: false,
                    goals: [],
                }),
            ),
        );
        await expect(client.init(workspace)).rejects.toThrow(
            'did not match its request',
        );

        responses.push(
            processResult(
                JSON.stringify({
                    protocol: 'cbranch-goal-supervisor.tui/999',
                    ok: true,
                    operation: 'init',
                    workspace,
                }),
            ),
        );
        await expect(client.init(workspace)).rejects.toThrow(
            'invalid response',
        );

        responses.push(
            processResult(
                JSON.stringify({
                    protocol: TUI_BRIDGE_PROTOCOL,
                    ok: false,
                    error: {
                        code: 'operation-failed',
                        message: 'database temporarily busy',
                    },
                }),
                '',
                1,
            ),
        );
        await expect(client.init(workspace)).rejects.toThrow(
            'database temporarily busy',
        );

        responses.push(
            processResult(
                JSON.stringify({
                    protocol: TUI_BRIDGE_PROTOCOL,
                    ok: true,
                    operation: 'init',
                    workspace,
                }),
                '',
                2,
            ),
        );
        await expect(client.init(workspace)).rejects.toThrow(
            'exited with code 2',
        );
    });

    test('caps process timeout, stdout, and stderr independently', async () => {
        await expect(
            runProcessWithoutShell(
                process.execPath,
                ['-e', 'setTimeout(() => {}, 1_000)'],
                { timeoutMs: 5 },
            ),
        ).rejects.toThrow('timed out');
        await expect(
            runProcessWithoutShell(
                process.execPath,
                ['-e', "process.stdout.write('x'.repeat(20))"],
                { stdoutLimitBytes: 10 },
            ),
        ).rejects.toThrow('stdout exceeded');
        await expect(
            runProcessWithoutShell(
                process.execPath,
                ['-e', "process.stderr.write('x'.repeat(20))"],
                { stderrLimitBytes: 10 },
            ),
        ).rejects.toThrow('stderr exceeded');
    });

    test.runIf(process.platform === 'linux')(
        'waits for close and escalates termination before rejecting',
        async () => {
            const root = await temporaryDirectory();
            const pidPath = join(root, 'child.pid');
            const source = [
                "const { writeFileSync } = require('node:fs');",
                `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
                "process.on('SIGTERM', () => {});",
                'setInterval(() => {}, 1_000);',
            ].join('');

            await expect(
                runProcessWithoutShell(process.execPath, ['-e', source], {
                    timeoutMs: 100,
                }),
            ).rejects.toThrow('timed out');

            const pid = Number(await readFile(pidPath, 'utf8'));
            await expect(access(`/proc/${pid}`)).rejects.toMatchObject({
                code: 'ENOENT',
            });

            const closedPath = join(root, 'output-child-closed');
            const outputSource = [
                "const { writeFileSync } = require('node:fs');",
                `process.on('SIGTERM', () => setTimeout(() => { writeFileSync(${JSON.stringify(closedPath)}, 'closed'); process.exit(0); }, 25));`,
                "process.stdout.write('x'.repeat(1_000));",
                'setInterval(() => {}, 1_000);',
            ].join('');
            await expect(
                runProcessWithoutShell(process.execPath, ['-e', outputSource], {
                    stdoutLimitBytes: 10,
                }),
            ).rejects.toThrow('stdout exceeded');
            await expect(readFile(closedPath, 'utf8')).resolves.toBe('closed');
        },
    );

    test('reports a terminated launch as possibly committed', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            if (arguments_[0] === '--version') {
                return processResult('v20.20.0\n');
            }
            throw new ProcessTerminationError(
                'timeout',
                'Process execution timed out.',
            );
        });
        const client = await createTuiBridgeClient({
            nodePath: paths.nodePath,
            cliPath: paths.cliPath,
            dependencies: { runProcess: runner },
        });

        await expect(
            client.launch({
                workspace,
                planPath: join(workspace, 'goal.md'),
                planMarkdown: 'goal plan',
                actor: 'tui',
            }),
        ).rejects.toThrow('may already be durable');
    });

    test('encodes worst-case control and multibyte plan text within the bridge cap', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        const paths = await programFiles(root);
        let requestBytes = 0;
        const runner: ProcessRunner = vi.fn(
            async (_executable, arguments_, options) => {
                if (arguments_[0] === '--version')
                    return processResult('v20.20.0\n');
                requestBytes = Buffer.byteLength(options?.stdin ?? '');
                return processResult(
                    JSON.stringify({
                        protocol: TUI_BRIDGE_PROTOCOL,
                        ok: true,
                        operation: 'launch',
                        goal: { id: 'goal-1', state: 'executing' },
                    }),
                );
            },
        );
        const client = await createTuiBridgeClient({
            nodePath: paths.nodePath,
            cliPath: paths.cliPath,
            dependencies: { runProcess: runner },
        });

        await client.launch({
            workspace,
            planPath: join(workspace, 'plan.md'),
            planMarkdown: `${'\u0001'.repeat(1_048_576 - 4)}\ud83d\ude80`,
            actor: 'tui',
        });

        expect(requestBytes).toBeLessThanOrEqual(MAX_TUI_BRIDGE_REQUEST_BYTES);
        expect(requestBytes).toBeGreaterThan(6_000_000);
    });
});

describe('persistent workspace daemon manager', () => {
    test('derives deterministic workspace-specific unit names', () => {
        const first = workspaceSystemdUnitName('/workspace/one');
        expect(first).toMatch(
            /^cbranch-goal-supervisor-[a-f0-9]{24}\.service$/u,
        );
        expect(workspaceSystemdUnitName('/workspace/one')).toBe(first);
        expect(workspaceSystemdUnitName('/workspace/two')).not.toBe(first);
    });

    test('requires readiness and the exact unit fragment for managed status', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const serviceIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        let ready = false;
        let fragmentPath = '';
        let unitPid = 4242;
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) =>
            arguments_[0] === '--version'
                ? processResult('systemd 252\n')
                : processResult(
                      unitState(
                          'active',
                          unitPid,
                          'loaded',
                          'running',
                          fragmentPath,
                      ),
                  ),
        );
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                runProcess: runner,
                inspectDaemonServiceStatus: async () =>
                    running(lockPath, workspace, 4242, ready, serviceIdentity),
            },
        });
        fragmentPath = manager.unitPath;

        await expect(manager.status()).resolves.toMatchObject({
            status: 'starting',
            ownership: 'managed',
        });
        ready = true;
        await expect(manager.status()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        unitPid = 4343;
        await expect(manager.status()).resolves.toMatchObject({
            status: 'starting',
            ownership: 'managed',
        });
        unitPid = 4242;
        fragmentPath = join(root, 'other.service');
        await expect(manager.status()).resolves.toMatchObject({
            status: 'running',
            ownership: 'independent',
        });
    });

    test('fails startup when a pre-ready lock disappears and the unit fails', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const identity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        const lockStates = [
            running(lockPath, workspace, 4242, false, identity),
            stopped(lockPath),
        ];
        let expectedUnitPath = '';
        let showCalls = 0;
        const calls: string[][] = [];
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version') {
                return processResult('systemd 252\n');
            }
            showCalls++;
            return processResult(
                showCalls === 1
                    ? unitState(
                          'active',
                          4242,
                          'loaded',
                          'running',
                          expectedUnitPath,
                      )
                    : unitState(
                          'failed',
                          0,
                          'loaded',
                          'failed',
                          expectedUnitPath,
                      ),
            );
        });
        const writeService = vi.fn(async () => ({ changed: false }));
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            readinessTimeoutMs: 20,
            pollIntervalMs: 5,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    lockStates.shift() ?? stopped(lockPath),
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
                sleep: async () => {},
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).rejects.toThrow(
            'Goal daemon startup failed',
        );
        expect(calls.some(arguments_ => arguments_.includes('restart'))).toBe(
            false,
        );
    });

    test('disables only the verified unit while preserving an independent owner', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        let expectedUnitPath = '';
        let enabled = true;
        const calls: string[][] = [];
        const inspect = vi.fn(async () => running(lockPath, workspace, 1111));
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version') {
                return processResult('systemd 252\n');
            }
            if (arguments_.includes('show')) {
                return processResult(
                    enabled
                        ? unitState(
                              'active',
                              2222,
                              'loaded',
                              'running',
                              expectedUnitPath,
                              'enabled',
                          )
                        : unitState(
                              'inactive',
                              0,
                              'loaded',
                              'dead',
                              expectedUnitPath,
                              'disabled',
                          ),
                );
            }
            if (arguments_.includes('disable')) enabled = false;
            return processResult();
        });
        const writeService = vi.fn();
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus:
                    inspect as unknown as typeof import('./systemd.js').inspectDaemonServiceStatus,
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).rejects.toThrow(
            'independently managed daemon owns this workspace',
        );
        enabled = true;
        await expect(manager.stop()).resolves.toMatchObject({
            status: 'running',
            ownership: 'independent',
        });

        expect(
            calls.filter(arguments_ => arguments_.includes('disable')),
        ).toEqual([
            ['--user', 'disable', '--now', manager.unitName],
            ['--user', 'disable', '--now', manager.unitName],
        ]);
        expect(inspect).toHaveBeenCalledTimes(4);
        expect(writeService).not.toHaveBeenCalled();
    });

    test('fails when verified-unit cleanup for an independent owner fails', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        let expectedUnitPath = '';
        const inspect = vi.fn(async () => running(lockPath, workspace, 1111));
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            if (arguments_[0] === '--version') {
                return processResult('systemd 252\n');
            }
            if (arguments_.includes('show')) {
                return processResult(
                    unitState(
                        'active',
                        2222,
                        'loaded',
                        'running',
                        expectedUnitPath,
                    ),
                );
            }
            return arguments_.includes('disable')
                ? processResult('', 'permission denied', 1)
                : processResult();
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus:
                    inspect as unknown as typeof import('./systemd.js').inspectDaemonServiceStatus,
                runProcess: runner,
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).rejects.toThrow(
            'permission denied',
        );
        expect(inspect).toHaveBeenCalledOnce();
    });

    test('keeps an unchanged managed service running and restarts changed URL configuration', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const userDirectory = join(root, 'systemd', 'user');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const unitPath = join(
            userDirectory,
            workspaceSystemdUnitName(workspace),
        );
        await writeSystemdUserService({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            systemdUserDirectory: userDirectory,
            unitPath,
        });
        const originalIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        const changedIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:5000',
        });
        let activeIdentity = originalIdentity;
        const inode = (await stat(unitPath)).ino;
        const calls: string[][] = [];
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version') {
                return processResult('systemd 252\n');
            }
            if (arguments_.includes('restart')) {
                activeIdentity = changedIdentity;
            }
            return processResult(
                unitState(
                    'active',
                    4242,
                    'loaded',
                    'running',
                    unitPath,
                    'enabled',
                ),
            );
        });
        const dependencies = {
            platform: 'linux' as const,
            inspectDaemonServiceStatus: async () =>
                running(lockPath, workspace, 4242, true, activeIdentity),
            runProcess: runner,
        };
        const unchanged = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            systemdUserDirectory: userDirectory,
            lockPath,
            dependencies,
        });

        await expect(unchanged.ensureRunning()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        expect((await stat(unitPath)).ino).toBe(inode);
        expect(calls.some(arguments_ => arguments_.includes('restart'))).toBe(
            false,
        );
        expect(
            calls.some(arguments_ => arguments_.includes('daemon-reload')),
        ).toBe(false);

        const changed = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:5000',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            systemdUserDirectory: userDirectory,
            lockPath,
            dependencies,
        });
        await expect(changed.ensureRunning()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        expect(calls).toContainEqual(['--user', 'restart', changed.unitName]);
        expect(await readFile(unitPath, 'utf8')).toContain(
            'http://127.0.0.1:5000/',
        );
    });

    test('restarts an unchanged managed OpenCode unit with a stale service identity', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const desiredIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://opencode.internal/',
            managedOpenCodePath: paths.openCodePath,
        });
        const staleIdentity = `sha256:${'f'.repeat(64)}` as const;
        let activeIdentity: SystemdServiceIdentity = staleIdentity;
        let expectedUnitPath = '';
        const calls: string[][] = [];
        const runner: ProcessRunner = vi.fn(async (executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version') {
                return basename(executable) === 'opencode'
                    ? processResult('1.17.20\n')
                    : processResult('systemd 252\n');
            }
            if (arguments_.includes('restart')) {
                activeIdentity = desiredIdentity;
            }
            return arguments_.includes('show')
                ? processResult(
                      unitState(
                          'active',
                          4242,
                          'loaded',
                          'running',
                          expectedUnitPath,
                          'enabled',
                      ),
                  )
                : processResult();
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://opencode.internal/',
            managedOpenCode: true,
            openCodePath: paths.openCodePath,
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    running(lockPath, workspace, 4242, true, activeIdentity),
                writeSystemdUserService: vi.fn(async () => ({
                    changed: false,
                })) as unknown as typeof writeSystemdUserService,
                runProcess: runner,
                sleep: async () => {},
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        expect(calls).toContainEqual(['--user', 'daemon-reload']);
        expect(calls).toContainEqual(['--user', 'restart', manager.unitName]);
        expect(activeIdentity).toBe(desiredIdentity);
    });

    test.each(['daemon-reload', 'restart'] as const)(
        'retries a pre-ready wrong-identity rollout after %s fails',
        async failingCommand => {
            const root = await temporaryDirectory();
            const workspace = join(root, 'workspace');
            const userDirectory = join(root, 'systemd', 'user');
            const lockPath = join(workspace, 'daemon.lock');
            await mkdir(workspace);
            const paths = await programFiles(root);
            const unitPath = join(
                userDirectory,
                workspaceSystemdUnitName(workspace),
            );
            const oldOptions = {
                executablePath: paths.nodePath,
                cliPath: paths.cliPath,
                workspace,
                openCodeUrl: 'http://127.0.0.1:4096',
            };
            const desiredOptions = {
                ...oldOptions,
                openCodeUrl: 'http://127.0.0.1:5000',
            };
            await writeSystemdUserService({
                ...oldOptions,
                systemdUserDirectory: userDirectory,
                unitPath,
            });
            let activeIdentity = systemdServiceIdentity(oldOptions);
            let activeReady = false;
            const desiredIdentity = systemdServiceIdentity(desiredOptions);
            let failed = false;
            const calls: string[][] = [];
            const runner: ProcessRunner = vi.fn(
                async (_executable, arguments_) => {
                    calls.push([...arguments_]);
                    if (arguments_[0] === '--version') {
                        return processResult('systemd 252\n');
                    }
                    if (arguments_.includes(failingCommand) && !failed) {
                        failed = true;
                        return processResult('', `${failingCommand} failed`, 1);
                    }
                    if (arguments_.includes('restart')) {
                        activeIdentity = desiredIdentity;
                        activeReady = true;
                    }
                    return arguments_.includes('show')
                        ? processResult(
                              unitState(
                                  'active',
                                  4242,
                                  'loaded',
                                  'running',
                                  unitPath,
                                  'enabled',
                              ),
                          )
                        : processResult();
                },
            );
            const manager = await createPersistentDaemonManager({
                workspace,
                openCodeUrl: desiredOptions.openCodeUrl,
                verifiedPrograms: {
                    nodePath: paths.nodePath,
                    cliPath: paths.cliPath,
                },
                systemctlPath: paths.systemctlPath,
                systemdUserDirectory: userDirectory,
                lockPath,
                dependencies: {
                    platform: 'linux',
                    inspectDaemonServiceStatus: async () =>
                        running(
                            lockPath,
                            workspace,
                            4242,
                            activeReady,
                            activeIdentity,
                        ),
                    runProcess: runner,
                },
            });

            await expect(manager.ensureRunning()).rejects.toThrow(
                `${failingCommand} failed`,
            );
            await expect(manager.ensureRunning()).resolves.toMatchObject({
                status: 'running',
                ownership: 'managed',
            });

            expect(
                calls.filter(arguments_ =>
                    arguments_.includes('daemon-reload'),
                ),
            ).toHaveLength(2);
            expect(
                calls.filter(arguments_ => arguments_.includes('restart')),
            ).toHaveLength(failingCommand === 'restart' ? 2 : 1);
            expect(activeIdentity).toBe(desiredIdentity);
        },
    );

    test('serializes lifecycle mutations across manager instances', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        const lifecycleLockPath = `${lockPath}.lifecycle`;
        await mkdir(workspace);
        await writeFile(
            lifecycleLockPath,
            `${JSON.stringify({
                pid: 2_147_483_647,
                processIdentity: 'linux:00000000-0000-4000-8000-000000000000:1',
                token: randomUUID(),
                workspace,
                createdAt: new Date().toISOString(),
            })}\n`,
        );
        const paths = await programFiles(root);
        const identity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        let expectedUnitPath = '';
        let release!: () => void;
        const holdFirst = new Promise<void>(resolve => {
            release = resolve;
        });
        let writes = 0;
        let activeWrites = 0;
        let maximumWrites = 0;
        const writeService = vi.fn(async () => {
            writes++;
            activeWrites++;
            maximumWrites = Math.max(maximumWrites, activeWrites);
            if (writes === 1) await holdFirst;
            activeWrites--;
            return { changed: false };
        });
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) =>
            arguments_[0] === '--version'
                ? processResult('systemd 252\n')
                : processResult(
                      unitState(
                          'active',
                          4242,
                          'loaded',
                          'running',
                          expectedUnitPath,
                          'enabled',
                      ),
                  ),
        );
        const options = {
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            lifecycleLockPath,
            lifecycleLockTimeoutMs: 1_000,
            lifecycleLockPollIntervalMs: 5,
            dependencies: {
                platform: 'linux' as const,
                inspectDaemonServiceStatus: async () =>
                    running(lockPath, workspace, 4242, true, identity),
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
            },
        };
        const firstManager = await createPersistentDaemonManager(options);
        const secondManager = await createPersistentDaemonManager(options);
        expectedUnitPath = firstManager.unitPath;

        const first = firstManager.ensureRunning();
        const second = secondManager.ensureRunning();
        await vi.waitFor(() => expect(writeService).toHaveBeenCalledOnce());
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(writeService).toHaveBeenCalledOnce();
        release();
        await Promise.all([first, second]);

        expect(writeService).toHaveBeenCalledTimes(2);
        expect(maximumWrites).toBe(1);
    });

    test('fails closed on malformed/live lifecycle locks and recovers a stale owner without signals', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        const lifecycleLockPath = join(workspace, 'lifecycle.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const identity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        let expectedUnitPath = '';
        const writeService = vi.fn(async () => ({ changed: false }));
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) =>
            arguments_[0] === '--version'
                ? processResult('systemd 252\n')
                : processResult(
                      unitState(
                          'active',
                          4242,
                          'loaded',
                          'running',
                          expectedUnitPath,
                          'enabled',
                      ),
                  ),
        );
        let ownerAlive = true;
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            lifecycleLockPath,
            lifecycleLockTimeoutMs: 10,
            lifecycleLockPollIntervalMs: 1,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    running(lockPath, workspace, 4242, true, identity),
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
                pidIsAlive: () => ownerAlive,
                sleep: async milliseconds =>
                    await new Promise(resolve =>
                        setTimeout(resolve, milliseconds),
                    ),
            },
        });
        expectedUnitPath = manager.unitPath;

        await writeFile(lifecycleLockPath, 'not-json');
        await expect(manager.ensureRunning()).rejects.toThrow('malformed');
        expect(writeService).not.toHaveBeenCalled();

        await writeFile(
            lifecycleLockPath,
            `${JSON.stringify({
                pid: process.pid,
                token: randomUUID(),
                workspace,
                createdAt: new Date().toISOString(),
            })}\n`,
        );
        await expect(manager.ensureRunning()).rejects.toThrow(
            'Timed out waiting for workspace lifecycle lock',
        );
        expect(writeService).not.toHaveBeenCalled();

        ownerAlive = false;
        const kill = vi.spyOn(process, 'kill');
        await expect(manager.ensureRunning()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        expect(writeService).toHaveBeenCalledOnce();
        expect(kill).not.toHaveBeenCalled();
        await expect(access(lifecycleLockPath)).rejects.toMatchObject({
            code: 'ENOENT',
        });

        await writeFile(`${lifecycleLockPath}.recovery`, '');
        await expect(manager.ensureRunning()).rejects.toThrow(
            'lifecycle recovery',
        );
    });

    test('serializes concurrent lifecycle mutations', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const serviceIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        let expectedUnitPath = '';
        let release!: () => void;
        const firstWrite = new Promise<void>(resolve => {
            release = resolve;
        });
        let writes = 0;
        let activeWrites = 0;
        let maximumWrites = 0;
        let serviceStopped = false;
        const lifecycleCalls: string[][] = [];
        const writeService = vi.fn(async () => {
            writes++;
            activeWrites++;
            maximumWrites = Math.max(maximumWrites, activeWrites);
            if (writes === 1) await firstWrite;
            activeWrites--;
            return { changed: false };
        });
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            lifecycleCalls.push([...arguments_]);
            if (arguments_[0] === '--version') {
                return processResult('systemd 252\n');
            }
            if (arguments_.includes('disable')) {
                serviceStopped = true;
                return processResult();
            }
            return processResult(
                serviceStopped
                    ? unitState(
                          'inactive',
                          0,
                          'loaded',
                          'dead',
                          expectedUnitPath,
                          'disabled',
                      )
                    : unitState(
                          'active',
                          4242,
                          'loaded',
                          'running',
                          expectedUnitPath,
                          'enabled',
                      ),
            );
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    serviceStopped
                        ? stopped(lockPath)
                        : running(
                              lockPath,
                              workspace,
                              4242,
                              true,
                              serviceIdentity,
                          ),
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
            },
        });
        expectedUnitPath = manager.unitPath;

        const first = manager.ensureRunning();
        const second = manager.stop();
        await vi.waitFor(() => expect(writeService).toHaveBeenCalledOnce());
        expect(
            lifecycleCalls.some(arguments_ => arguments_.includes('disable')),
        ).toBe(false);
        release();
        await Promise.all([first, second]);

        expect(writeService).toHaveBeenCalledOnce();
        expect(maximumWrites).toBe(1);
        expect(lifecycleCalls).toContainEqual([
            '--user',
            'disable',
            '--now',
            manager.unitName,
        ]);
    });

    test('repairs a previously generated bad unit before startup', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const serviceIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        let expectedUnitPath = '';
        let reloaded = false;
        let restarted = false;
        let writes = 0;
        const writeService = vi.fn(async () => ({
            changed: writes++ === 0,
        }));
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            if (arguments_[0] === '--version') {
                return processResult('systemd 252\n');
            }
            if (arguments_.includes('daemon-reload')) {
                reloaded = true;
                return processResult();
            }
            if (arguments_.includes('restart')) {
                restarted = true;
                return processResult();
            }
            if (arguments_.includes('show')) {
                if (!reloaded) {
                    return processResult('', 'bad unit setting', 1);
                }
                return processResult(
                    unitState(
                        restarted ? 'active' : 'inactive',
                        restarted ? 4242 : 0,
                        'loaded',
                        restarted ? 'running' : 'dead',
                        expectedUnitPath,
                        'enabled',
                    ),
                );
            }
            return processResult();
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    restarted
                        ? running(
                              lockPath,
                              workspace,
                              4242,
                              true,
                              serviceIdentity,
                          )
                        : stopped(lockPath),
                writeSystemdUserService:
                    writeService as unknown as typeof writeSystemdUserService,
                runProcess: runner,
                sleep: async () => {},
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        expect(writeService).toHaveBeenCalledTimes(2);
        expect(
            vi
                .mocked(runner)
                .mock.calls.some(([, args]) => args.includes('daemon-reload')),
        ).toBe(true);
    });

    test('writes a hardened unit, invokes absolute programs without a shell, and polls readiness', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const userDirectory = join(root, 'systemd', 'user');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const serviceIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://opencode.internal/',
            managedOpenCodePath: paths.openCodePath,
        });
        const lockStates = [
            stopped(lockPath),
            stopped(lockPath),
            running(lockPath, workspace, 4242, false),
            running(lockPath, workspace, 4242, true, serviceIdentity),
        ];
        const inspect = vi.fn(
            async () =>
                lockStates.shift() ??
                running(lockPath, workspace, 4242, true, serviceIdentity),
        );
        const calls: { executable: string; arguments_: readonly string[] }[] =
            [];
        let showCalls = 0;
        let expectedUnitPath = '';
        let enabled = false;
        const runner: ProcessRunner = vi.fn(async (executable, arguments_) => {
            calls.push({ executable, arguments_ });
            if (arguments_.length === 1 && arguments_[0] === '--version') {
                if (basename(executable) === 'opencode') {
                    return processResult('1.17.20\n');
                }
                return processResult('systemd 252\n');
            }
            if (arguments_.includes('show')) {
                showCalls += 1;
                return processResult(
                    showCalls === 1
                        ? unitState('inactive', 0, 'not-found')
                        : unitState(
                              'active',
                              4242,
                              'loaded',
                              'running',
                              expectedUnitPath,
                              enabled ? 'enabled' : 'disabled',
                          ),
                );
            }
            if (arguments_.includes('enable')) enabled = true;
            return processResult();
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://opencode.internal/',
            managedOpenCode: true,
            openCodePath: paths.openCodePath,
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            systemdUserDirectory: userDirectory,
            lockPath,
            readinessTimeoutMs: 20,
            pollIntervalMs: 5,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus:
                    inspect as unknown as typeof import('./systemd.js').inspectDaemonServiceStatus,
                runProcess: runner,
                sleep: async () => {},
                pidIsAlive: () => true,
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });

        const unit = await readFile(manager.unitPath, 'utf8');
        expect(unit).toContain(
            `"${paths.nodePath}" "${paths.cliPath}" "serve"`,
        );
        expect(unit).toContain(`"--workspace" "${workspace}"`);
        expect(unit).toContain(
            `"--internal-managed-opencode" "${paths.openCodePath}"`,
        );
        expect(unit).not.toContain('"--opencode-url"');
        expect(calls.every(call => call.executable.startsWith(root))).toBe(
            true,
        );
        expect(
            calls.some(
                call =>
                    basename(call.executable) === 'opencode' &&
                    call.arguments_[0] === '--version',
            ),
        ).toBe(true);
        expect(
            calls
                .map(call => call.arguments_)
                .filter(args => args.includes('daemon-reload')),
        ).toEqual([['--user', 'daemon-reload']]);
        expect(calls.map(call => call.arguments_)).toContainEqual([
            '--user',
            'enable',
            manager.unitName,
        ]);
        expect(calls.map(call => call.arguments_)).toContainEqual([
            '--user',
            'restart',
            manager.unitName,
        ]);
    });

    test('status is read-only and stop targets only the deterministic unit', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const serviceIdentity = systemdServiceIdentity({
            executablePath: paths.nodePath,
            cliPath: paths.cliPath,
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
        });
        const lockStates = [
            running(lockPath, workspace, 9001, true, serviceIdentity),
            running(lockPath, workspace, 9001, true, serviceIdentity),
            stopped(lockPath),
        ];
        const inspect = vi.fn(
            async () => lockStates.shift() ?? stopped(lockPath),
        );
        const writeService = vi.fn();
        const calls: string[][] = [];
        let disabled = false;
        let expectedUnitPath = '';
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version')
                return processResult('systemd 252\n');
            if (arguments_.includes('show')) {
                return processResult(
                    disabled
                        ? unitState(
                              'inactive',
                              0,
                              'loaded',
                              'dead',
                              expectedUnitPath,
                              'disabled',
                          )
                        : unitState(
                              'active',
                              9001,
                              'loaded',
                              'running',
                              expectedUnitPath,
                          ),
                );
            }
            if (arguments_.includes('disable')) disabled = true;
            return processResult();
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            verifiedPrograms: {
                nodePath: paths.nodePath,
                cliPath: paths.cliPath,
            },
            systemctlPath: paths.systemctlPath,
            lockPath,
            readinessTimeoutMs: 20,
            pollIntervalMs: 5,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus:
                    inspect as unknown as typeof import('./systemd.js').inspectDaemonServiceStatus,
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
                sleep: async () => {},
                pidIsAlive: () => true,
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.status()).resolves.toMatchObject({
            status: 'running',
            ownership: 'managed',
        });
        expect(writeService).not.toHaveBeenCalled();
        expect(calls.some(args => args.includes('enable'))).toBe(false);
        expect(calls.some(args => args.includes('restart'))).toBe(false);
        expect(calls.some(args => args.includes('disable'))).toBe(false);

        await expect(manager.stop()).resolves.toMatchObject({
            status: 'stopped',
        });
        expect(calls).toContainEqual([
            '--user',
            'disable',
            '--now',
            manager.unitName,
        ]);
    });

    test('rejects independent ownership without writing, starting, or stopping its owner', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const writeService = vi.fn();
        const calls: string[][] = [];
        const runner: ProcessRunner = vi.fn(async (_executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version')
                return processResult('systemd 252\n');
            return processResult(unitState('active', 2222));
        });
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    running(lockPath, workspace, 1111),
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
                pidIsAlive: () => true,
            },
        });

        await expect(manager.ensureRunning()).rejects.toThrow(
            'independently managed daemon owns this workspace',
        );
        await expect(manager.stop()).resolves.toMatchObject({
            status: 'running',
            ownership: 'independent',
        });
        expect(writeService).not.toHaveBeenCalled();
        expect(calls.some(args => args.includes('enable'))).toBe(false);
        expect(calls.some(args => args.includes('restart'))).toBe(false);
        expect(calls.some(args => args.includes('disable'))).toBe(false);
    });

    test('resolves a post-start lock race in favor of an independent daemon', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const lockStates = [
            stopped(lockPath),
            running(lockPath, workspace, 1111),
            running(lockPath, workspace, 1111),
        ];
        const calls: string[][] = [];
        let showCalls = 0;
        let expectedUnitPath = '';
        let disabled = false;
        const runner: ProcessRunner = vi.fn(async (executable, arguments_) => {
            calls.push([...arguments_]);
            if (arguments_[0] === '--version') {
                return basename(executable) === 'node'
                    ? processResult('v20.20.0\n')
                    : processResult('systemd 252\n');
            }
            if (arguments_.includes('show')) {
                showCalls += 1;
                return processResult(
                    showCalls === 1
                        ? unitState('inactive', 0, 'not-found')
                        : disabled
                          ? unitState(
                                'inactive',
                                0,
                                'loaded',
                                'dead',
                                expectedUnitPath,
                                'disabled',
                            )
                          : unitState(
                                'active',
                                2222,
                                'loaded',
                                'running',
                                expectedUnitPath,
                            ),
                );
            }
            if (arguments_.includes('disable')) disabled = true;
            return processResult();
        });
        const writeService = vi.fn(async () => ({ changed: true }));
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            nodePath: paths.nodePath,
            cliPath: paths.cliPath,
            systemctlPath: paths.systemctlPath,
            lockPath,
            readinessTimeoutMs: 20,
            pollIntervalMs: 5,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    lockStates.shift() ?? running(lockPath, workspace, 1111),
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
                runProcess: runner,
                sleep: async () => {},
                pidIsAlive: () => true,
            },
        });
        expectedUnitPath = manager.unitPath;

        await expect(manager.ensureRunning()).rejects.toThrow(
            'independently managed daemon owns this workspace',
        );
        expect(writeService).toHaveBeenCalledOnce();
        expect(calls).toContainEqual([
            '--user',
            'disable',
            '--now',
            manager.unitName,
        ]);
    });

    test('fails actionably without falling back on unsupported hosts', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        await mkdir(workspace);
        const runner = vi.fn();
        const writeService = vi.fn();
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            dependencies: {
                platform: 'darwin',
                runProcess: runner,
                writeSystemdUserService:
                    writeService as unknown as typeof import('./systemd.js').writeSystemdUserService,
            },
        });

        await expect(manager.status()).resolves.toMatchObject({
            status: 'unsupported',
            detail: expect.stringContaining('Linux systemd user session'),
        });
        await expect(manager.ensureRunning()).rejects.toThrow(
            'run cbranch-goal-supervisor serve separately',
        );
        expect(runner).not.toHaveBeenCalled();
        expect(writeService).not.toHaveBeenCalled();
    });

    test('does not accept independent readiness when systemctl is unavailable', async () => {
        const root = await temporaryDirectory();
        const workspace = join(root, 'workspace');
        const lockPath = join(workspace, 'daemon.lock');
        await mkdir(workspace);
        const paths = await programFiles(root);
        const writeService = vi.fn();
        const manager = await createPersistentDaemonManager({
            workspace,
            openCodeUrl: 'http://127.0.0.1:4096',
            systemctlPath: paths.systemctlPath,
            lockPath,
            dependencies: {
                platform: 'linux',
                inspectDaemonServiceStatus: async () =>
                    running(lockPath, workspace, 1111),
                writeSystemdUserService:
                    writeService as unknown as typeof writeSystemdUserService,
                runProcess: async () =>
                    processResult('', 'systemctl unavailable', 1),
            },
        });

        await expect(manager.ensureRunning()).rejects.toThrow(
            'systemd user services are unavailable',
        );
        expect(writeService).not.toHaveBeenCalled();
    });

    test.runIf(process.platform === 'linux')(
        'inspects lock liveness through proc without signalling the PID',
        async () => {
            const root = await temporaryDirectory();
            const workspace = join(root, 'workspace');
            const controlDirectory = join(
                workspace,
                '.opencode',
                'goal-supervisor',
            );
            const lockPath = join(controlDirectory, 'daemon.lock');
            await mkdir(controlDirectory, { recursive: true });
            const owner = {
                pid: process.pid,
                processIdentity: processIdentity(process.pid)!,
                token: randomUUID(),
                workspace,
                createdAt: new Date().toISOString(),
            };
            const paths = await programFiles(root);
            const serviceIdentity = systemdServiceIdentity({
                executablePath: paths.nodePath,
                cliPath: paths.cliPath,
                workspace,
                openCodeUrl: 'http://127.0.0.1:4096',
            });
            const identifiedOwner = { ...owner, serviceIdentity };
            await writeFile(lockPath, `${JSON.stringify(identifiedOwner)}\n`);
            await writeFile(
                `${lockPath}.ready`,
                `${JSON.stringify({
                    pid: identifiedOwner.pid,
                    workspace: identifiedOwner.workspace,
                    token: identifiedOwner.token,
                    processIdentity: identifiedOwner.processIdentity,
                    serviceIdentity,
                    readyAt: new Date().toISOString(),
                })}\n`,
            );
            let expectedUnitPath = '';
            const runner: ProcessRunner = vi.fn(
                async (_executable, arguments_) =>
                    arguments_[0] === '--version'
                        ? processResult('systemd 252\n')
                        : processResult(
                              unitState(
                                  'active',
                                  process.pid,
                                  'loaded',
                                  'running',
                                  expectedUnitPath,
                              ),
                          ),
            );
            const kill = vi.spyOn(process, 'kill');
            const manager = await createPersistentDaemonManager({
                workspace,
                openCodeUrl: 'http://127.0.0.1:4096',
                verifiedPrograms: {
                    nodePath: paths.nodePath,
                    cliPath: paths.cliPath,
                },
                systemctlPath: paths.systemctlPath,
                lockPath,
                dependencies: { platform: 'linux', runProcess: runner },
            });
            expectedUnitPath = manager.unitPath;

            await expect(manager.status()).resolves.toMatchObject({
                status: 'running',
                ownership: 'managed',
            });
            expect(kill).not.toHaveBeenCalled();
        },
    );
});
