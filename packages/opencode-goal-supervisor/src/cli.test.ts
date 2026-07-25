import {
    access,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
    parseCliArguments,
    runCli,
    type CliDependencies,
    type TuiBridgeInput,
} from './cli.js';
import {
    initWorkspaceControl,
    openWorkspaceControl,
    type GoalControlService,
    type InitializedWorkspaceControl,
} from './control.js';
import { parseGoalPlanMarkdown } from './goal-plan.js';
import { GoalStore } from './store.js';
import {
    goalLaunchCommandId,
    MAX_TUI_BRIDGE_GOALS,
    MAX_TUI_BRIDGE_REQUEST_BYTES,
    TUI_BRIDGE_COMMAND,
    TUI_BRIDGE_PROTOCOL,
    TuiBridgeFailureResponseSchema,
    TuiBridgeResponseSchema,
} from './tui-protocol.js';

const directories: string[] = [];
const approvalToken = 'a'.repeat(32);
const serviceIdentity = `sha256:${'c'.repeat(64)}`;

const workspace = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-cli-'));
    directories.push(directory);
    return directory;
};

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const capture = () => {
    let value = '';
    return {
        writer: { write: (chunk: string) => (value += chunk) },
        value: () => value,
    };
};

const invoke = async (
    directory: string,
    arguments_: readonly string[],
    overrides: CliDependencies = {},
) => {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli(arguments_, {
        cwd: () => directory,
        stdout: stdout.writer,
        stderr: stderr.writer,
        ...overrides,
    });
    return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
};

const bridgeInput = (value: string | Uint8Array): TuiBridgeInput => ({
    async *[Symbol.asyncIterator]() {
        yield value;
    },
});

const invokeBridge = async (
    source: string | Uint8Array,
    overrides: CliDependencies = {},
    arguments_: readonly string[] = [],
) => {
    const root = '/unused';
    return invoke(root, [TUI_BRIDGE_COMMAND, ...arguments_], {
        stdin: bridgeInput(source),
        ...overrides,
    });
};

const bridgeRequest = (
    operation: 'init' | 'list' | 'launch',
    workspacePath: string,
    extra: Readonly<Record<string, unknown>> = {},
): string =>
    JSON.stringify({
        protocol: TUI_BRIDGE_PROTOCOL,
        operation,
        workspace: workspacePath,
        ...extra,
    });

const goalMarkdown = (pretty = false): string =>
    [
        '# Confirmed goal',
        '```goal-plan',
        JSON.stringify(
            {
                ...(pretty ? { authoredBy: 'planner' } : {}),
                objective: 'Exercise the private bridge',
                units: [
                    {
                        id: 'unit-1',
                        title: 'Implement',
                        instructions: 'Implement and verify the bridge.',
                        dependencyIds: [],
                        acceptanceCriteria: ['The bridge is verified'],
                        verificationRequirements: [],
                    },
                ],
                ...(!pretty ? { authoredBy: 'planner' } : {}),
            },
            null,
            pretty ? 4 : undefined,
        ),
        '```',
    ].join('\n');

const initializedBridgeControl = (
    canonicalWorkspace: string,
    control: object,
    token = 'loaded-control-secret',
): InitializedWorkspaceControl =>
    ({
        workspace: canonicalWorkspace,
        tokenPath: join(canonicalWorkspace, 'control.token'),
        internalTransportAuthToken: token,
        control,
    }) as unknown as InitializedWorkspaceControl;

const plan = {
    authoredBy: 'planner',
    units: [
        {
            id: 'unit-1',
            title: 'Implement the goal',
            instructions: 'Implement and verify the requested goal.',
            dependencyIds: [],
            acceptanceCriteria: ['The requested result is verified'],
            verificationRequirements: [],
            required: true,
            destructive: false,
        },
    ],
    finalVerificationRequirements: [],
};

describe('parseCliArguments', () => {
    test.each([
        [['init'], 'init'],
        [
            ['init', '--systemd', '--opencode-url', 'http://localhost:4096'],
            'init',
        ],
        [
            [
                'serve',
                '--global-concurrency',
                '8',
                '--workspace-concurrency',
                '3',
                '--dispatch-interval-ms',
                '10',
                '--reconciliation-interval-ms',
                '11',
                '--cancellation-interval-ms',
                '12',
                '--observation-restart-interval-ms',
                '13',
            ],
            'serve',
        ],
        [['status'], 'status'],
        [['status', 'goal-1'], 'status'],
        [['plan', 'goal-1', '--file', 'plan.json'], 'plan'],
        [['plan', '--objective', 'Ship safely', '--file', 'plan.json'], 'plan'],
        [['start', 'goal-1', '--approval-token', approvalToken], 'start'],
        [['pause', 'goal-1', '--reason', 'Operator pause'], 'pause'],
        [['resume', 'goal-1', '--approval-token', approvalToken], 'resume'],
        [['cancel', 'goal-1', '--reason', 'Operator cancel'], 'cancel'],
        [
            ['approve', 'goal-1', 'approve-plan', '--plan-id', 'plan-1'],
            'approve',
        ],
        [['approve', 'goal-1', 'issue-start'], 'approve'],
        [['approve', 'goal-1', 'issue-resume'], 'approve'],
        [['approve', 'goal-1', 'issue-blocked-resume'], 'approve'],
        [['approve', 'goal-1', 'issue-recovery'], 'approve'],
        [['approve', 'goal-1', 'issue-budget'], 'approve'],
        [
            [
                'approve',
                'goal-1',
                'issue-destructive',
                '--work-unit-id',
                'unit-1',
                '--actor',
                'operator-1',
                '--reason',
                'Approved explicitly',
                '--ttl-ms',
                '1000',
            ],
            'approve',
        ],
        [
            [
                'approve',
                'goal-1',
                'approve-destructive',
                '--work-unit-id',
                'unit-1',
                '--approval-token',
                approvalToken,
            ],
            'approve',
        ],
        [
            [
                'recover',
                'goal-1',
                '--target',
                'paused',
                '--approval-token',
                approvalToken,
                '--decision',
                'No external change completed',
            ],
            'recover',
        ],
        [['doctor'], 'doctor'],
        [
            ['doctor', '--recover', '--opencode-url', 'https://localhost:4096'],
            'doctor',
        ],
        [['mcp'], 'mcp'],
    ] as const)('accepts %j', (arguments_, command) => {
        expect(parseCliArguments(arguments_, '/tmp/workspace').command).toBe(
            command,
        );
    });

    test('accepts global options before or after the command', () => {
        expect(
            parseCliArguments(
                ['--json', 'status', '--workspace', './project', 'goal-1'],
                '/tmp',
            ),
        ).toMatchObject({
            command: 'status',
            workspace: '/tmp/project',
            json: true,
            goalId: 'goal-1',
        });
    });

    test('accepts only a valid private serve service identity', () => {
        expect(
            parseCliArguments(
                ['serve', '--internal-service-identity', serviceIdentity],
                '/tmp/workspace',
            ),
        ).toMatchObject({ command: 'serve', serviceIdentity });
        expect(() =>
            parseCliArguments(
                ['serve', '--internal-service-identity', 'invalid'],
                '/tmp/workspace',
            ),
        ).toThrow('lowercase SHA-256 identity');
    });

    test.each(
        (
            [
                [],
                ['create', 'old prototype'],
                ['list'],
                ['transition', 'goal-1', 'ready'],
                ['status', '--unknown'],
                ['status', '--json', '--json'],
                ['status', '--workspace', '/tmp', '--workspace', '/var/tmp'],
                ['status', 'goal-1', 'extra'],
                ['init', '--opencode-url', 'http://localhost:4096'],
                ['serve', '--opencode-url', 'file:///tmp/socket'],
                ['serve', '--global-concurrency', '0'],
                ['serve', '--global-concurrency', '2.5'],
                ['serve', '--global-concurrency', '1001'],
                [
                    'serve',
                    '--global-concurrency',
                    '1',
                    '--workspace-concurrency',
                    '2',
                ],
                ['plan', '--file', 'plan.json'],
                [
                    'plan',
                    'goal-1',
                    '--objective',
                    'Both',
                    '--file',
                    'plan.json',
                ],
                ['plan', 'goal-1'],
                ['start', 'goal-1'],
                ['start', 'goal-1', '--approval-token', 'short'],
                ['pause', 'goal-1'],
                ['resume', 'goal-1'],
                ['cancel', 'goal-1'],
                ['approve', 'goal-1', 'anything'],
                ['approve', 'goal-1', 'approve-plan'],
                [
                    'approve',
                    'goal-1',
                    'approve-plan',
                    '--plan-id',
                    'plan-1',
                    '--reason',
                    'not used',
                ],
                ['approve', 'goal-1', 'issue-destructive'],
                [
                    'approve',
                    'goal-1',
                    'issue-start',
                    '--work-unit-id',
                    'unit-1',
                ],
                [
                    'approve',
                    'goal-1',
                    'approve-destructive',
                    '--work-unit-id',
                    'unit-1',
                ],
                [
                    'recover',
                    'goal-1',
                    '--target',
                    'unknown-outcome',
                    '--approval-token',
                    approvalToken,
                    '--decision',
                    'invalid target',
                ],
                ['doctor', 'extra'],
                ['mcp', 'extra'],
                ['status', '--json=true'],
            ] as readonly (readonly string[])[]
        ).map(arguments_ => [arguments_] as const),
    )('rejects invalid argv %j', arguments_ => {
        expect(() => parseCliArguments(arguments_, '/tmp/workspace')).toThrow();
    });

    test('keeps the private TUI bridge outside the public parser', () => {
        expect(() =>
            parseCliArguments([TUI_BRIDGE_COMMAND], '/tmp/workspace'),
        ).toThrow('Unknown command');
    });
});

describe('private TUI bridge', () => {
    test.each([
        ['malformed JSON', '{'],
        [
            'multiple JSON objects',
            `${bridgeRequest('list', '/workspace')}\n${bridgeRequest('list', '/workspace')}`,
        ],
        [
            'an unknown field',
            bridgeRequest('list', '/workspace', { unknown: true }),
        ],
        [
            'an auth token field',
            bridgeRequest('list', '/workspace', {
                authToken: 'request-secret',
            }),
        ],
        [
            'a transport command field',
            bridgeRequest('list', '/workspace', {
                commandId: 'caller-controlled',
            }),
        ],
    ])('rejects %s before opening state', async (_label, source) => {
        const initialize = vi.fn();
        const open = vi.fn();

        const result = await invokeBridge(source, {
            initWorkspaceControl:
                initialize as unknown as typeof initWorkspaceControl,
            openWorkspaceControl:
                open as unknown as typeof openWorkspaceControl,
        });
        const response = TuiBridgeFailureResponseSchema.parse(
            JSON.parse(result.stdout),
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout.endsWith('\n')).toBe(true);
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
        expect(result.stderr).toBe('');
        expect(response.error.code).toBe('invalid-request');
        expect(initialize).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });

    test('rejects oversized input and bridge arguments before opening state', async () => {
        const initialize = vi.fn();
        const open = vi.fn();
        const dependencies: CliDependencies = {
            initWorkspaceControl:
                initialize as unknown as typeof initWorkspaceControl,
            openWorkspaceControl:
                open as unknown as typeof openWorkspaceControl,
        };

        const oversized = await invokeBridge(
            'x'.repeat(MAX_TUI_BRIDGE_REQUEST_BYTES + 1),
            dependencies,
        );
        const withArgument = await invokeBridge(
            bridgeRequest('list', '/workspace'),
            dependencies,
            ['unexpected'],
        );

        expect(oversized.exitCode).toBe(1);
        expect(withArgument.exitCode).toBe(1);
        expect(oversized.stderr).toBe('');
        expect(withArgument.stderr).toBe('');
        expect(initialize).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
    });

    test('rejects malformed launch Markdown before opening state', async () => {
        const open = vi.fn();
        const result = await invokeBridge(
            bridgeRequest('launch', '/workspace', {
                planPath: '/workspace/goal.md',
                planMarkdown: 'not a goal plan',
                actor: 'operator',
            }),
            {
                openWorkspaceControl:
                    open as unknown as typeof openWorkspaceControl,
            },
        );

        expect(result.exitCode).toBe(1);
        expect(open).not.toHaveBeenCalled();
        expect(result.stderr).toBe('');
    });

    test('initializes and returns only the canonical workspace before closing', async () => {
        const close = vi.fn(async () => undefined);
        const initialize = vi.fn(async () =>
            initializedBridgeControl('/canonical/workspace', { close }),
        );

        const result = await invokeBridge(bridgeRequest('init', '/requested'), {
            initWorkspaceControl:
                initialize as unknown as typeof initWorkspaceControl,
        });

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            protocol: TUI_BRIDGE_PROTOCOL,
            ok: true,
            operation: 'init',
            workspace: '/canonical/workspace',
        });
        expect(initialize).toHaveBeenCalledWith('/requested');
        expect(close).toHaveBeenCalledOnce();
        expect(result.stderr).toBe('');
    });

    test('lists an exact total with a bounded terminal-safe projection', async () => {
        const close = vi.fn(async () => undefined);
        const goals = Array.from(
            { length: MAX_TUI_BRIDGE_GOALS + 5 },
            (_, index) => ({
                id: `goal-${index}`,
                state:
                    index === MAX_TUI_BRIDGE_GOALS + 4
                        ? ('executing' as const)
                        : ('paused' as const),
                objective: `Goal ${index}\n\u001b[31mstatus`,
            }),
        );
        const list = vi.fn(() => goals);
        const open = vi.fn(async () =>
            initializedBridgeControl('/workspace', { list, close }),
        );

        const result = await invokeBridge(bridgeRequest('list', '/workspace'), {
            openWorkspaceControl:
                open as unknown as typeof openWorkspaceControl,
        });
        const response = TuiBridgeResponseSchema.parse(
            JSON.parse(result.stdout),
        );

        expect(response).toMatchObject({
            ok: true,
            operation: 'list',
            total: goals.length,
            hasExecuting: true,
        });
        if (!response.ok || response.operation !== 'list') {
            throw new Error('Expected a list response.');
        }
        expect(response.goals).toHaveLength(MAX_TUI_BRIDGE_GOALS);
        expect(
            Array.from(JSON.stringify(response.goals)).every(character => {
                const code = character.codePointAt(0)!;
                return code >= 0x20 && (code < 0x7f || code > 0x9f);
            }),
        ).toBe(true);
        expect(list).toHaveBeenCalledWith({
            authToken: 'loaded-control-secret',
        });
        expect(close).toHaveBeenCalledOnce();
    });

    test('reparses and launches without exposing control fields', async () => {
        const canonicalWorkspace = '/workspace';
        const planPath = join(canonicalWorkspace, 'plans', 'goal.md');
        const markdown = goalMarkdown();
        const parsedPlan = parseGoalPlanMarkdown(markdown);
        const close = vi.fn(async () => undefined);
        const create = vi.fn(() => ({
            goal: { id: 'goal-1', state: 'executing' as const },
        }));
        const status = vi.fn(() => ({
            goal: { id: 'goal-1', state: 'executing' as const },
        }));
        const parse = vi.fn(parseGoalPlanMarkdown);
        const open = vi.fn(async () =>
            initializedBridgeControl(canonicalWorkspace, {
                createProposeApproveStart: create,
                status,
                close,
            }),
        );

        const result = await invokeBridge(
            bridgeRequest('launch', canonicalWorkspace, {
                planPath,
                planMarkdown: markdown,
                actor: 'operator',
            }),
            {
                openWorkspaceControl:
                    open as unknown as typeof openWorkspaceControl,
                parseGoalPlanMarkdown: parse,
            },
        );

        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            protocol: TUI_BRIDGE_PROTOCOL,
            ok: true,
            operation: 'launch',
            goal: { id: 'goal-1', state: 'executing' },
        });
        expect(parse).toHaveBeenCalledWith(markdown);
        expect(create).toHaveBeenCalledWith({
            authToken: 'loaded-control-secret',
            commandId: goalLaunchCommandId(
                canonicalWorkspace,
                planPath,
                parsedPlan,
                'operator',
            ),
            planMarkdown: markdown,
            actor: 'operator',
        });
        expect(status).toHaveBeenCalledWith({
            authToken: 'loaded-control-secret',
            goalId: 'goal-1',
        });
        expect(result.stdout).not.toContain('loaded-control-secret');
        expect(result.stdout).not.toContain('commandId');
        expect(close).toHaveBeenCalledOnce();
    });

    test('keeps one launch ID but returns current state after replay', async () => {
        const canonicalWorkspace = '/workspace';
        const planPath = join(canonicalWorkspace, 'goal.md');
        const commandIds: string[] = [];
        const states = ['executing', 'achieved'] as const;
        const closes: ReturnType<typeof vi.fn>[] = [];
        const open = vi.fn(async () => {
            const close = vi.fn(async () => undefined);
            closes.push(close);
            return initializedBridgeControl(canonicalWorkspace, {
                close,
                createProposeApproveStart: (
                    request: Parameters<
                        GoalControlService['createProposeApproveStart']
                    >[0],
                ) => {
                    commandIds.push(request.commandId!);
                    return {
                        goal: { id: 'goal-1', state: 'executing' },
                    } as ReturnType<
                        GoalControlService['createProposeApproveStart']
                    >;
                },
                status: () => ({
                    goal: {
                        id: 'goal-1',
                        state: states[commandIds.length - 1],
                    },
                }),
            });
        });
        const launch = async (planMarkdown: string) =>
            await invokeBridge(
                bridgeRequest('launch', canonicalWorkspace, {
                    planPath,
                    planMarkdown,
                    actor: 'operator',
                }),
                {
                    openWorkspaceControl:
                        open as unknown as typeof openWorkspaceControl,
                },
            );

        const first = await launch(goalMarkdown());
        const replay = await launch(goalMarkdown(true));

        expect(first.exitCode).toBe(0);
        expect(replay.exitCode).toBe(0);
        expect(JSON.parse(first.stdout)).toMatchObject({
            goal: { id: 'goal-1', state: 'executing' },
        });
        expect(JSON.parse(replay.stdout)).toMatchObject({
            goal: { id: 'goal-1', state: 'achieved' },
        });
        expect(commandIds).toHaveLength(2);
        expect(commandIds[0]).toBe(commandIds[1]);
        expect(closes).toHaveLength(2);
        for (const close of closes) expect(close).toHaveBeenCalledOnce();
    });

    test('rejects a lexical path escape without rereading or mutating', async () => {
        const canonicalWorkspace = '/workspace';
        const close = vi.fn(async () => undefined);
        const create = vi.fn();
        const read = vi.fn();
        const open = vi.fn(async () =>
            initializedBridgeControl(canonicalWorkspace, {
                createProposeApproveStart: create,
                close,
            }),
        );

        const result = await invokeBridge(
            bridgeRequest('launch', canonicalWorkspace, {
                planPath: resolve(canonicalWorkspace, '..', 'outside.md'),
                planMarkdown: goalMarkdown(),
                actor: 'operator',
            }),
            {
                openWorkspaceControl:
                    open as unknown as typeof openWorkspaceControl,
                readFile: read as unknown as typeof readFile,
            },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain('within the workspace');
        expect(create).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
    });

    test('redacts a loaded control token from operation errors', async () => {
        const token = 's'.repeat(512);
        const close = vi.fn(async () => undefined);
        const list = vi.fn(() => {
            throw new Error(`database failed while using ${token}`);
        });
        const open = vi.fn(async () =>
            initializedBridgeControl('/workspace', { list, close }, token),
        );

        const result = await invokeBridge(bridgeRequest('list', '/workspace'), {
            openWorkspaceControl:
                open as unknown as typeof openWorkspaceControl,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).not.toContain(token);
        expect(result.stdout).not.toContain(token.slice(0, 100));
        expect(result.stdout).toContain('[REDACTED]');
        expect(result.stderr).toBe('');
        expect(close).toHaveBeenCalledOnce();
    });
});

describe('CLI pre-open validation and output', () => {
    test('rejects invalid arguments before opening a nonexistent workspace', async () => {
        const root = await workspace();
        const initialize = vi.fn();
        const result = await invoke(
            join(root, 'does-not-exist'),
            ['start', 'goal with spaces', '--approval-token', approvalToken],
            {
                initWorkspaceControl:
                    initialize as unknown as typeof initWorkspaceControl,
            },
        );

        expect(result.exitCode).toBe(1);
        expect(initialize).not.toHaveBeenCalled();
        expect(result.stdout).toBe('');
        expect(result.stderr.trim().split('\n')).toHaveLength(1);
    });

    test('reads and parses a plan before workspace initialization or mutation', async () => {
        const root = await workspace();
        await writeFile(join(root, 'bad.json'), '{');
        const initialize = vi.fn();
        const result = await invoke(
            root,
            [
                'plan',
                '--objective',
                'Must not be created',
                '--file',
                'bad.json',
            ],
            {
                initWorkspaceControl:
                    initialize as unknown as typeof initWorkspaceControl,
            },
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Plan file is not valid JSON');
        expect(initialize).not.toHaveBeenCalled();
    });

    test('initializes human and JSON output without revealing transport auth', async () => {
        const root = await workspace();
        const human = await invoke(root, ['init']);
        const json = await invoke(root, ['--json', 'init']);

        expect(human.exitCode).toBe(0);
        expect(human.stdout).toContain('Next commands:');
        expect(human.stdout).toContain('serve --opencode-url');
        expect(json.exitCode).toBe(0);
        expect(JSON.parse(json.stdout)).toMatchObject({
            command: 'init',
            workspace: root,
        });
        expect(json.stdout).not.toContain('internalTransportAuthToken');
        expect(json.stdout).not.toContain('tokenHash');
    });

    test('writes a user unit without running lifecycle commands', async () => {
        const root = await workspace();
        const systemdUserDirectory = join(
            root,
            'home',
            '.config',
            'systemd',
            'user',
        );
        const result = await invoke(
            root,
            [
                '--json',
                'init',
                '--systemd',
                '--opencode-url',
                'http://localhost:4096',
            ],
            {
                systemdUserDirectory: () => systemdUserDirectory,
                executablePath: '/usr/bin/node',
                cliPath: '/opt/cbranch/cli.js',
            },
        );
        const output = JSON.parse(result.stdout) as {
            systemd: { unitPath: string };
            nextCommands: string[];
        };

        expect(result.exitCode).toBe(0);
        await expect(access(output.systemd.unitPath)).resolves.toBeUndefined();
        expect(output.nextCommands).toEqual([
            'systemctl --user daemon-reload',
            'systemctl --user enable cbranch-goal-supervisor.service',
            'systemctl --user start cbranch-goal-supervisor.service',
            'systemctl --user status cbranch-goal-supervisor.service',
        ]);
    });
});

describe('CLI control workflows', () => {
    test('plans, approves, starts, pauses, resumes, cancels, and formats status', async () => {
        const root = await workspace();
        await writeFile(join(root, 'plan.json'), JSON.stringify(plan));

        const proposed = await invoke(root, [
            '--json',
            'plan',
            '--objective',
            'Exercise the operator CLI',
            '--file',
            'plan.json',
        ]);
        expect(proposed.exitCode).toBe(0);
        const proposal = JSON.parse(proposed.stdout) as {
            createdGoal: { id: string };
            plan: { id: string };
        };
        const goalId = proposal.createdGoal.id;

        expect(
            (
                await invoke(root, [
                    'approve',
                    goalId,
                    'approve-plan',
                    '--plan-id',
                    proposal.plan.id,
                ])
            ).stdout,
        ).toContain('ready');
        const startApproval = await invoke(root, [
            '--json',
            'approve',
            goalId,
            'issue-start',
        ]);
        const startToken = JSON.parse(startApproval.stdout)
            .actionToken as string;
        expect(startToken).toHaveLength(43);
        expect(
            (
                await invoke(root, [
                    'start',
                    goalId,
                    '--approval-token',
                    startToken,
                ])
            ).stdout,
        ).toContain('executing');
        expect(
            (
                await invoke(root, [
                    'pause',
                    goalId,
                    '--reason',
                    'Operator inspection',
                ])
            ).stdout,
        ).toContain('paused');
        const resumeApproval = await invoke(root, [
            '--json',
            'approve',
            goalId,
            'issue-resume',
        ]);
        const resumeToken = JSON.parse(resumeApproval.stdout)
            .actionToken as string;
        expect(
            (
                await invoke(root, [
                    'resume',
                    goalId,
                    '--approval-token',
                    resumeToken,
                ])
            ).stdout,
        ).toContain('executing');
        expect(
            (
                await invoke(root, [
                    'cancel',
                    goalId,
                    '--reason',
                    'Operator cancellation',
                ])
            ).stdout,
        ).toContain('cancelled');

        const status = await invoke(root, ['status', goalId]);
        const list = await invoke(root, ['--json', 'status']);
        expect(status.stdout).toContain('TERMINAL: cancelled');
        expect(JSON.parse(list.stdout).goals).toHaveLength(1);
        expect(startApproval.stdout).not.toContain('tokenHash');
    });

    test('issues recovery approval and recovers an unknown outcome', async () => {
        const root = await workspace();
        await writeFile(join(root, 'plan.json'), JSON.stringify(plan));
        const proposal = JSON.parse(
            (
                await invoke(root, [
                    '--json',
                    'plan',
                    '--objective',
                    'Recover an ambiguous dispatch',
                    '--file',
                    'plan.json',
                ])
            ).stdout,
        ) as { createdGoal: { id: string }; plan: { id: string } };
        const goalId = proposal.createdGoal.id;
        await invoke(root, [
            'approve',
            goalId,
            'approve-plan',
            '--plan-id',
            proposal.plan.id,
        ]);
        const startToken = JSON.parse(
            (await invoke(root, ['--json', 'approve', goalId, 'issue-start']))
                .stdout,
        ).actionToken as string;
        await invoke(root, ['start', goalId, '--approval-token', startToken]);

        const store = new GoalStore(
            join(root, '.opencode', 'goal-supervisor', 'goal.db'),
        );
        const attempt = store.claimNextWork('worker', 60_000, root)!;
        const message = store.claimOutbox(1, 60_000, 'dispatcher')[0]!;
        store.markDispatchStarted(message.id, message.leaseToken);
        store.markUnknownOutcome(
            message.id,
            message.leaseToken,
            `Ambiguous dispatch ${attempt.id}`,
        );
        store.close();

        const recoveryToken = JSON.parse(
            (
                await invoke(root, [
                    '--json',
                    'approve',
                    goalId,
                    'issue-recovery',
                ])
            ).stdout,
        ).actionToken as string;
        const recovered = await invoke(root, [
            'recover',
            goalId,
            '--target',
            'paused',
            '--approval-token',
            recoveryToken,
            '--decision',
            'The operator confirmed no external change completed',
        ]);

        expect(recovered.exitCode).toBe(0);
        expect(recovered.stdout).toContain('paused');
    });
});

describe('CLI process seams', () => {
    test('doctor reports permissions, lock, integrity, recovery, and OpenCode health', async () => {
        const root = await workspace();
        expect((await invoke(root, ['init'])).exitCode).toBe(0);
        const createAdapter = vi.fn(async () => ({
            health: async () => ({ healthy: true }),
        }));
        const result = await invoke(root, ['--json', 'doctor', '--recover'], {
            createOpenCodeAdapter:
                createAdapter as unknown as CliDependencies['createOpenCodeAdapter'],
        });

        expect(result.exitCode, result.stderr || result.stdout).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            command: 'doctor',
            healthy: true,
            workspace: root,
            integrity: { ok: true },
            projections: { ok: true },
            database: { ownerOnly: true },
            token: { ownerOnly: true },
            service: { status: 'stopped' },
            openCode: { healthy: true },
        });
        expect(createAdapter).toHaveBeenCalledWith({
            baseUrl: 'http://127.0.0.1:4096/',
            directory: root,
        });
    });

    test('doctor reports an uninitialized workspace without creating state', async () => {
        const root = await workspace();
        const result = await invoke(root, ['--json', 'doctor']);

        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            command: 'doctor',
            healthy: false,
            control: { available: false },
            database: { exists: false },
            token: { exists: false },
        });
        await expect(access(join(root, '.opencode'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    test.runIf(process.platform !== 'win32')(
        'doctor reports a database symlink as invalid without following it',
        async () => {
            const root = await workspace();
            expect((await invoke(root, ['init'])).exitCode).toBe(0);
            const databasePath = join(
                root,
                '.opencode',
                'goal-supervisor',
                'goal.db',
            );
            const outsidePath = join(root, 'outside.db');
            await writeFile(outsidePath, 'outside sentinel');
            await rm(databasePath);
            await symlink(outsidePath, databasePath);

            const result = await invoke(root, ['--json', 'doctor']);

            expect(result.exitCode).toBe(1);
            expect(JSON.parse(result.stdout)).toMatchObject({
                healthy: false,
                database: {
                    exists: true,
                    regularFile: false,
                    symbolicLink: true,
                },
            });
            await expect(readFile(outsidePath, 'utf8')).resolves.toBe(
                'outside sentinel',
            );
        },
    );

    test('routes explicit doctor recovery through the control service', async () => {
        const root = await workspace();
        const seeded = await initWorkspaceControl(root);
        await seeded.control.close();
        const initialized = await openWorkspaceControl(root);
        const doctor = vi.spyOn(initialized.control, 'doctor');
        const createAdapter = vi.fn(async () => ({
            health: async () => ({ healthy: true }),
        }));

        const result = await invoke(root, ['--json', 'doctor', '--recover'], {
            openWorkspaceControl: async () => initialized,
            createOpenCodeAdapter:
                createAdapter as unknown as CliDependencies['createOpenCodeAdapter'],
            randomUUID: () => 'doctor-recovery-command',
        });

        expect(result.exitCode, result.stderr || result.stdout).toBe(0);
        expect(doctor).toHaveBeenCalledWith({
            authToken: initialized.internalTransportAuthToken,
            commandId: 'doctor-recovery-command',
            recover: true,
        });
        expect(JSON.parse(result.stdout)).toMatchObject({
            recovery: { expiredAttempts: 0, expiredOutboxLeases: 0 },
        });
    });

    test('closes initialization before serve opens daemon state', async () => {
        const root = await workspace();
        let closed = false;
        const close = vi.fn(async () => {
            closed = true;
        });
        const initialize = vi.fn(
            async () =>
                ({
                    workspace: root,
                    tokenPath: join(root, 'control.token'),
                    internalTransportAuthToken: 'transport-secret',
                    control: { close },
                }) as unknown as InitializedWorkspaceControl,
        );
        const adapter = { health: async () => ({ healthy: true }) };
        const createAdapter = vi.fn(async () => adapter);
        const daemon = vi.fn(async () => {
            expect(closed).toBe(true);
        });

        const result = await invoke(
            root,
            [
                '--json',
                'serve',
                '--global-concurrency',
                '3',
                '--workspace-concurrency',
                '2',
                '--dispatch-interval-ms',
                '25',
                '--internal-service-identity',
                serviceIdentity,
            ],
            {
                initWorkspaceControl:
                    initialize as unknown as typeof initWorkspaceControl,
                createOpenCodeAdapter:
                    createAdapter as unknown as CliDependencies['createOpenCodeAdapter'],
                runGoalDaemon:
                    daemon as unknown as CliDependencies['runGoalDaemon'],
            },
        );

        expect(result.exitCode).toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(daemon).toHaveBeenCalledWith(
            expect.objectContaining({
                workspace: root,
                adapter,
                globalConcurrency: 3,
                workspaceConcurrency: 2,
                dispatchIntervalMs: 25,
                serviceIdentity,
            }),
        );
        expect(JSON.parse(result.stdout)).toMatchObject({
            command: 'serve',
            status: 'starting',
        });
    });

    test('keeps MCP stdout clean and closes deterministically on failure', async () => {
        const root = await workspace();
        const close = vi.fn(async () => undefined);
        const initialize = vi.fn(
            async () =>
                ({
                    workspace: root,
                    tokenPath: join(root, 'control.token'),
                    internalTransportAuthToken: 'transport-secret',
                    control: { close },
                }) as unknown as InitializedWorkspaceControl,
        );
        const mcp = vi.fn(async () => {
            throw new Error('protocol failed\nwith details');
        });
        const result = await invoke(root, ['mcp'], {
            initWorkspaceControl:
                initialize as unknown as typeof initWorkspaceControl,
            runGoalMcp: mcp as unknown as CliDependencies['runGoalMcp'],
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('protocol failed with details\n');
        expect(close).toHaveBeenCalledOnce();
        expect(mcp).toHaveBeenCalledWith(expect.anything(), 'transport-secret');
    });
});
