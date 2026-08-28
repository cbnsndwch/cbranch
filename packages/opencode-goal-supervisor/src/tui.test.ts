import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    TuiDialogAlertProps,
    TuiDialogConfirmProps,
    TuiDialogPromptProps,
    TuiPluginApi,
    TuiToast,
} from '@opencode-ai/plugin/tui';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { parseGoalPlanMarkdown } from './goal-plan.js';
import type {
    PersistentDaemonManager,
    TuiBridgeClient,
    TuiBridgeLaunchInput,
} from './tui-daemon.js';
import {
    bootstrapGoalTui,
    ensureDaemonForExecutingGoals,
    goalLaunchCommandId,
    openCodeClientUrl,
    openGoalLaunchDialog,
    prepareGoalPlan,
    readConfinedGoalPlanFile,
    registerGoalTuiCommands,
    type GoalDialogApi,
    type GoalLaunchResult,
    type GoalTuiRuntime,
    type PreparedGoalPlan,
} from './tui.js';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

const makeDirectory = async (prefix: string): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
};

const markdown = (): string =>
    [
        '# Reviewed goal',
        '',
        '```goal-plan',
        JSON.stringify({
            objective: 'Ship the confirmed change',
            units: [
                {
                    id: 'implement',
                    title: 'Implement',
                    instructions: 'Implement and verify the change.',
                    dependencyIds: [],
                    acceptanceCriteria: ['The change is verified'],
                    verificationRequirements: [],
                },
            ],
            authoredBy: 'planner',
        }),
        '```',
    ].join('\n');

type RenderedDialog =
    | { readonly kind: 'alert'; readonly props: TuiDialogAlertProps }
    | { readonly kind: 'confirm'; readonly props: TuiDialogConfirmProps }
    | { readonly kind: 'prompt'; readonly props: TuiDialogPromptProps };

const dialogHarness = (): {
    readonly api: GoalDialogApi;
    readonly current: () => RenderedDialog;
    readonly toasts: TuiToast[];
} => {
    let rendered: RenderedDialog | undefined;
    const toasts: TuiToast[] = [];
    return {
        api: {
            ui: {
                DialogAlert: props => ({ kind: 'alert', props }) as never,
                DialogConfirm: props => ({ kind: 'confirm', props }) as never,
                DialogPrompt: props => ({ kind: 'prompt', props }) as never,
                dialog: {
                    replace: render => {
                        rendered = render() as unknown as RenderedDialog;
                    },
                    clear: () => {},
                    setSize: () => {},
                    size: 'medium',
                    depth: 1,
                    open: true,
                },
                toast: input => toasts.push(input),
            },
        },
        current: () => {
            if (!rendered) throw new Error('No dialog was rendered.');
            return rendered;
        },
        toasts,
    };
};

describe('goal-plan file confinement', () => {
    test('reads and validates a stable workspace-local regular file', async () => {
        const workspace = await makeDirectory('goal-tui-');
        const path = join(workspace, 'goal.md');
        await writeFile(path, markdown());

        const prepared = await prepareGoalPlan(workspace, 'goal.md');

        expect(prepared.path).toBe(path);
        expect(prepared.plan.objective).toBe('Ship the confirmed change');
        expect(prepared.plan.units).toHaveLength(1);
        expect(prepared.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    });

    test('rejects outside, symlinked, nonregular, oversized, and invalid UTF-8 input', async () => {
        const workspace = await makeDirectory('goal-tui-');
        const outside = await makeDirectory('goal-tui-outside-');
        const validPath = join(workspace, 'goal.md');
        const outsidePath = join(outside, 'outside.md');
        await writeFile(validPath, markdown());
        await writeFile(outsidePath, markdown());
        await symlink(validPath, join(workspace, 'linked.md'));
        await mkdir(join(workspace, 'directory.md'));
        await writeFile(join(workspace, 'large.md'), '0123456789');
        await writeFile(join(workspace, 'invalid.md'), Buffer.from([0xff]));

        await expect(
            readConfinedGoalPlanFile(workspace, outsidePath),
        ).rejects.toThrow('stay within');
        await expect(
            readConfinedGoalPlanFile(workspace, 'linked.md'),
        ).rejects.toThrow('symbolic link');
        await expect(
            readConfinedGoalPlanFile(workspace, 'directory.md'),
        ).rejects.toThrow('regular file');
        await expect(
            readConfinedGoalPlanFile(workspace, 'large.md', 8),
        ).rejects.toThrow('8-byte limit');
        await expect(
            readConfinedGoalPlanFile(workspace, 'invalid.md'),
        ).rejects.toThrow('valid UTF-8');
    });

    test('rejects a path that traverses a symlinked directory', async () => {
        const workspace = await makeDirectory('goal-tui-');
        const actual = join(workspace, 'actual');
        await mkdir(actual);
        await writeFile(join(actual, 'goal.md'), markdown());
        await symlink(actual, join(workspace, 'alias'));

        await expect(
            readConfinedGoalPlanFile(workspace, 'alias/goal.md'),
        ).rejects.toThrow('traverse symbolic links');
    });
});

describe('goal launch dialogs', () => {
    test('summarizes the validated snapshot and launches only from confirm', async () => {
        const harness = dialogHarness();
        const plan = parseGoalPlanMarkdown(markdown());
        const prepared: PreparedGoalPlan = {
            workspace: '/workspace',
            path: '/workspace/plans/goal.md',
            markdown: markdown(),
            digest: `sha256:${'a'.repeat(64)}`,
            plan,
        };
        const prepare = vi.fn(async () => prepared);
        const launch = vi.fn(
            async () =>
                ({
                    goal: { id: 'goal-1', state: 'achieved' },
                }) as GoalLaunchResult,
        );

        openGoalLaunchDialog(harness.api, { prepare, launch });
        const prompt = harness.current();
        expect(prompt.kind).toBe('prompt');
        if (prompt.kind !== 'prompt') throw new Error('Expected prompt.');
        await prompt.props.onConfirm?.('plans/goal.md');

        expect(prepare).toHaveBeenCalledWith('plans/goal.md');
        expect(launch).not.toHaveBeenCalled();
        const confirm = harness.current();
        expect(confirm.kind).toBe('confirm');
        if (confirm.kind !== 'confirm') throw new Error('Expected confirm.');
        expect(confirm.props.message).toContain(
            'Objective: Ship the confirmed change',
        );
        expect(confirm.props.message).toContain('Units: 1');
        expect(confirm.props.message).toContain(
            'Path: /workspace/plans/goal.md',
        );
        expect(confirm.props.message).toContain(prepared.digest);

        confirm.props.onConfirm?.();
        await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
        expect(launch).toHaveBeenCalledWith(prepared);
        await vi.waitFor(() => expect(harness.toasts).toHaveLength(1));
        expect(harness.toasts[0]).toMatchObject({
            variant: 'success',
            title: 'Goal launch complete',
            message: 'Goal goal-1 is achieved.',
        });
        expect(harness.toasts[0]?.message).not.toContain('Started');
    });

    test('named command dispatch can only open the local path prompt', () => {
        const harness = dialogHarness();
        const prepare = vi.fn();
        const runtime = {
            prepare,
            launch: vi.fn(),
            daemonManager: {},
        } as unknown as GoalTuiRuntime;
        let layer: unknown;
        const api = {
            ...harness.api,
            keymap: {
                registerLayer: (value: unknown) => {
                    layer = value;
                    return () => {};
                },
            },
        } as unknown as TuiPluginApi;
        registerGoalTuiCommands(api, runtime);
        const commands = (
            layer as {
                readonly commands: readonly {
                    readonly slashName?: string;
                    readonly run: (context: unknown) => void;
                }[];
            }
        ).commands;
        const launchCommand = commands.find(
            command => command.slashName === 'goal',
        );
        expect(commands.map(command => command.slashName)).toEqual([
            'goal',
            'goal-status',
            'goal-daemon-stop',
        ]);

        launchCommand?.run({
            input: '/outside/attacker.md',
            payload: { confirmed: true },
        });

        expect(harness.current().kind).toBe('prompt');
        expect(prepare).not.toHaveBeenCalled();
    });

    test('status awaits asynchronous daemon and bridge list results', async () => {
        const harness = dialogHarness();
        let layer: unknown;
        const list = vi.fn(async () => ({
            total: 25,
            hasExecuting: true,
            goals: [
                {
                    id: 'goal-1',
                    state: 'executing' as const,
                    objective: 'Run asynchronously',
                },
            ],
        }));
        const runtime = {
            list,
            daemonStatus: vi.fn(async () => ({
                status: 'running' as const,
                unitName: 'goal.service',
                ownership: 'managed' as const,
                detail: 'running',
            })),
        } as unknown as GoalTuiRuntime;
        const api = {
            ...harness.api,
            keymap: {
                registerLayer: (value: unknown) => {
                    layer = value;
                    return () => {};
                },
            },
        } as unknown as TuiPluginApi;
        registerGoalTuiCommands(api, runtime);
        const statusCommand = (
            layer as {
                readonly commands: readonly {
                    readonly slashName?: string;
                    readonly run: () => void;
                }[];
            }
        ).commands.find(command => command.slashName === 'goal-status');

        statusCommand?.run();

        await vi.waitFor(() => expect(harness.current().kind).toBe('alert'));
        expect(list).toHaveBeenCalledOnce();
        const alert = harness.current();
        if (alert.kind !== 'alert') throw new Error('Expected alert.');
        expect(alert.props.message).toContain('goal-1 [executing]');
        expect(alert.props.message).toContain('Goals: 25');
        expect(alert.props.message).toContain('24 more goals not shown');
    });
});

describe('persistent TUI daemon bootstrap', () => {
    test('initializes through the bridge before manager creation and disposal leaves the service alone', async () => {
        const workspace = await makeDirectory('goal-tui-');
        const verifiedPrograms = {
            nodePath: '/usr/bin/node',
            cliPath: '/package/dist/cli.js',
        };
        const init = vi.fn(async () => ({ workspace }));
        const bridge = {
            verifiedPrograms,
            init,
            list: vi.fn(async () => ({
                total: 0,
                hasExecuting: false,
                goals: [],
            })),
            launch: vi.fn(),
        } as unknown as TuiBridgeClient;
        const manager = {
            status: vi.fn(),
            ensureRunning: vi.fn(),
            stop: vi.fn(),
        } as unknown as PersistentDaemonManager;
        const createBridge = vi.fn(async () => bridge);
        const createManager = vi.fn(async () => manager);

        const runtime = await bootstrapGoalTui({
            workspace,
            client: {},
            openCodeUrl: 'http://127.0.0.1:4096',
            dependencies: {
                createTuiBridgeClient: createBridge,
                createPersistentDaemonManager:
                    createManager as unknown as typeof import('./tui-daemon.js').createPersistentDaemonManager,
            },
        });
        expect(createBridge).toHaveBeenCalledOnce();
        expect(init).toHaveBeenCalledWith(workspace);
        expect(init.mock.invocationCallOrder[0]).toBeLessThan(
            createManager.mock.invocationCallOrder[0]!,
        );
        expect(createManager).toHaveBeenCalledWith(
            expect.objectContaining({
                workspace,
                openCodeUrl: 'http://127.0.0.1:4096/',
                managedOpenCode: false,
                verifiedPrograms,
            }),
        );
        expect(manager.ensureRunning).not.toHaveBeenCalled();

        await runtime.dispose();
        await runtime.dispose();

        expect(manager.stop).not.toHaveBeenCalled();
        expect('close' in bridge).toBe(false);
    });

    test('turns the TUI-only internal client into a managed OpenCode service', async () => {
        const workspace = await makeDirectory('goal-tui-managed-');
        const verifiedPrograms = {
            nodePath: '/usr/bin/node',
            cliPath: '/package/dist/cli.js',
        };
        const bridge = {
            verifiedPrograms,
            init: vi.fn(async () => ({ workspace })),
            list: vi.fn(),
            launch: vi.fn(),
        } as unknown as TuiBridgeClient;
        const manager = {
            status: vi.fn(),
            ensureRunning: vi.fn(),
            stop: vi.fn(),
        } as unknown as PersistentDaemonManager;
        const createManager = vi.fn(async () => manager);

        await bootstrapGoalTui({
            workspace,
            client: {
                client: {
                    getConfig: () => ({
                        baseUrl: 'http://opencode.internal/',
                    }),
                },
            },
            dependencies: {
                createTuiBridgeClient: async () => bridge,
                createPersistentDaemonManager:
                    createManager as unknown as typeof import('./tui-daemon.js').createPersistentDaemonManager,
            },
        });

        expect(createManager).toHaveBeenCalledWith(
            expect.objectContaining({
                workspace,
                openCodeUrl: 'http://opencode.internal/',
                managedOpenCode: true,
                verifiedPrograms,
            }),
        );

        await bootstrapGoalTui({
            workspace,
            client: {},
            openCodeUrl: 'https://opencode.internal/',
            dependencies: {
                createTuiBridgeClient: async () => bridge,
                createPersistentDaemonManager:
                    createManager as unknown as typeof import('./tui-daemon.js').createPersistentDaemonManager,
            },
        });
        expect(createManager).toHaveBeenLastCalledWith(
            expect.objectContaining({
                openCodeUrl: 'https://opencode.internal/',
                managedOpenCode: false,
            }),
        );
    });

    test('reconnects executing goals after an OpenCode restart', async () => {
        const ensureDaemon = vi.fn(async () => ({
            status: 'running' as const,
            unitName: 'goal.service',
            ownership: 'managed' as const,
            detail: 'running',
        }));
        const runtime = {
            list: vi.fn(async () => ({
                total: 21,
                hasExecuting: true,
                goals: [{ id: 'goal-2', state: 'paused' }],
            })),
            ensureDaemon,
        } as unknown as GoalTuiRuntime;

        await expect(
            ensureDaemonForExecutingGoals(runtime),
        ).resolves.toMatchObject({ status: 'running' });
        expect(ensureDaemon).toHaveBeenCalledOnce();

        const pausedRuntime = {
            list: vi.fn(async () => ({
                total: 1,
                hasExecuting: false,
                goals: [{ id: 'goal-2', state: 'paused' }],
            })),
            ensureDaemon,
        } as unknown as GoalTuiRuntime;
        await expect(
            ensureDaemonForExecutingGoals(pausedRuntime),
        ).resolves.toBeUndefined();
        expect(ensureDaemon).toHaveBeenCalledOnce();
    });

    test('replays one atomic launch ID and retries daemon bootstrap', async () => {
        const workspace = await makeDirectory('goal-tui-');
        const path = join(workspace, 'goal.md');
        const firstMarkdown = markdown();
        const secondMarkdown = `\n\n\`\`\`goal-plan\n${JSON.stringify(
            {
                authoredBy: 'planner',
                units: [
                    {
                        verificationRequirements: [],
                        acceptanceCriteria: ['The change is verified'],
                        dependencyIds: [],
                        instructions: 'Implement and verify the change.',
                        title: 'Implement',
                        id: 'implement',
                    },
                ],
                objective: 'Ship the confirmed change',
            },
            null,
            4,
        )}\n\`\`\`\n`;
        const result = {
            goal: { id: 'goal-1', state: 'executing' },
        } as GoalLaunchResult;
        const launch = vi.fn(async (_input: TuiBridgeLaunchInput) => result);
        const bridge = {
            verifiedPrograms: {
                nodePath: '/usr/bin/node',
                cliPath: '/package/dist/cli.js',
            },
            init: vi.fn(async () => ({ workspace })),
            list: vi.fn(async () => ({
                total: 0,
                hasExecuting: false,
                goals: [],
            })),
            launch,
        } as unknown as TuiBridgeClient;
        const ensureRunning = vi
            .fn()
            .mockRejectedValueOnce(new Error('systemd unavailable temporarily'))
            .mockResolvedValueOnce({ status: 'running' });
        const manager = {
            ensureRunning,
            status: vi.fn(),
            stop: vi.fn(),
        } as unknown as PersistentDaemonManager;
        const runtime = await bootstrapGoalTui({
            workspace,
            client: {},
            openCodeUrl: 'http://127.0.0.1:4096',
            actor: 'operator',
            dependencies: {
                createTuiBridgeClient: async () => bridge,
                createPersistentDaemonManager: async () => manager,
            },
        });
        const first: PreparedGoalPlan = {
            workspace,
            path,
            markdown: firstMarkdown,
            digest: `sha256:${'a'.repeat(64)}`,
            plan: parseGoalPlanMarkdown(firstMarkdown),
        };
        const second: PreparedGoalPlan = {
            ...first,
            markdown: secondMarkdown,
            digest: `sha256:${'b'.repeat(64)}`,
            plan: parseGoalPlanMarkdown(secondMarkdown),
        };

        await expect(runtime.launch(first)).rejects.toThrow(
            'systemd unavailable temporarily',
        );
        await expect(runtime.launch(second)).resolves.toBe(result);

        expect(ensureRunning).toHaveBeenCalledTimes(2);
        expect(launch).toHaveBeenCalledTimes(2);
        expect(launch.mock.calls[0]?.[0]).toEqual({
            workspace,
            planPath: path,
            planMarkdown: firstMarkdown,
            actor: 'operator',
        });
        expect(launch.mock.calls[1]?.[0]).toEqual({
            workspace,
            planPath: path,
            planMarkdown: secondMarkdown,
            actor: 'operator',
        });
        expect(launch.mock.invocationCallOrder[0]).toBeLessThan(
            ensureRunning.mock.invocationCallOrder[0]!,
        );
        expect(launch.mock.invocationCallOrder[1]).toBeLessThan(
            ensureRunning.mock.invocationCallOrder[1]!,
        );
        expect(
            goalLaunchCommandId(workspace, path, first.plan, 'operator'),
        ).toBe(goalLaunchCommandId(workspace, path, second.plan, 'operator'));
    });

    test.each(['achieved', 'cancelled'] as const)(
        'does not start a daemon for a replayed %s goal',
        async state => {
            const workspace = await makeDirectory('goal-tui-');
            const result = { goal: { id: 'goal-1', state } };
            const bridge = {
                verifiedPrograms: {
                    nodePath: '/usr/bin/node',
                    cliPath: '/package/dist/cli.js',
                },
                init: vi.fn(async () => ({ workspace })),
                list: vi.fn(async () => ({
                    total: 1,
                    hasExecuting: false,
                    goals: [],
                })),
                launch: vi.fn(async () => result),
            } as unknown as TuiBridgeClient;
            const ensureRunning = vi.fn();
            const manager = {
                ensureRunning,
                status: vi.fn(),
                stop: vi.fn(),
            } as unknown as PersistentDaemonManager;
            const runtime = await bootstrapGoalTui({
                workspace,
                client: {},
                openCodeUrl: 'http://127.0.0.1:4096',
                dependencies: {
                    createTuiBridgeClient: async () => bridge,
                    createPersistentDaemonManager: async () => manager,
                },
            });
            const prepared: PreparedGoalPlan = {
                workspace,
                path: join(workspace, 'goal.md'),
                markdown: markdown(),
                digest: `sha256:${'a'.repeat(64)}`,
                plan: parseGoalPlanMarkdown(markdown()),
            };

            await expect(runtime.launch(prepared)).resolves.toBe(result);
            expect(ensureRunning).not.toHaveBeenCalled();
        },
    );

    test('deterministic launch IDs include workspace, path, plan, and actor', () => {
        const plan = parseGoalPlanMarkdown(markdown());
        const base = goalLaunchCommandId(
            '/workspace',
            '/workspace/goal.md',
            plan,
            'operator',
        );
        expect(base).toBe(
            goalLaunchCommandId(
                '/workspace',
                '/workspace/goal.md',
                { ...plan, units: plan.units.map(unit => ({ ...unit })) },
                'operator',
            ),
        );
        expect(
            goalLaunchCommandId('/other', '/other/goal.md', plan, 'operator'),
        ).not.toBe(base);
        expect(
            goalLaunchCommandId(
                '/workspace',
                '/workspace/other.md',
                plan,
                'operator',
            ),
        ).not.toBe(base);
        expect(
            goalLaunchCommandId(
                '/workspace',
                '/workspace/goal.md',
                plan,
                'other',
            ),
        ).not.toBe(base);
    });

    test('discovers the pinned SDK base URL but honors an explicit URL', () => {
        const client = {
            client: {
                getConfig: () => ({ baseUrl: 'http://127.0.0.1:5000' }),
            },
        };
        expect(openCodeClientUrl(client)).toBe('http://127.0.0.1:5000/');
        expect(openCodeClientUrl(client, 'https://example.test/api')).toBe(
            'https://example.test/api',
        );
    });
});
