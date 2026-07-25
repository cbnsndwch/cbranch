import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type {
    TuiPlugin,
    TuiPluginApi,
    TuiPluginModule,
} from '@opencode-ai/plugin/tui';

import {
    MAX_GOAL_PLAN_MARKDOWN_BYTES,
    parseGoalPlanMarkdown,
    type GoalPlanInput,
} from './goal-plan.js';
import {
    createPersistentDaemonManager,
    createTuiBridgeClient,
    type PersistentDaemonManager,
    type PersistentDaemonStatus,
    type TuiBridgeClient,
} from './tui-daemon.js';
import {
    goalLaunchCommandId,
    type TuiBridgeLaunchResponse,
} from './tui-protocol.js';

export { goalLaunchCommandId };

export type ConfinedGoalPlanFile = {
    readonly workspace: string;
    readonly path: string;
    readonly markdown: string;
    readonly digest: `sha256:${string}`;
};

export type PreparedGoalPlan = ConfinedGoalPlanFile & {
    readonly plan: GoalPlanInput;
};

export type GoalLaunchResult = Pick<TuiBridgeLaunchResponse, 'goal'>;

export interface GoalTuiRuntime {
    readonly workspace: string;
    readonly daemonManager: PersistentDaemonManager;
    readonly prepare: (path: string) => Promise<PreparedGoalPlan>;
    readonly launch: (prepared: PreparedGoalPlan) => Promise<GoalLaunchResult>;
    readonly list: () => Promise<Awaited<ReturnType<TuiBridgeClient['list']>>>;
    readonly daemonStatus: () => Promise<PersistentDaemonStatus>;
    readonly ensureDaemon: () => Promise<PersistentDaemonStatus>;
    readonly stopDaemon: () => Promise<PersistentDaemonStatus>;
    readonly dispose: () => Promise<void>;
}

export type GoalDialogApi = {
    readonly ui: Pick<
        TuiPluginApi['ui'],
        'DialogAlert' | 'DialogConfirm' | 'DialogPrompt' | 'dialog' | 'toast'
    >;
};

export type GoalLaunchDialogServices = Pick<
    GoalTuiRuntime,
    'prepare' | 'launch'
>;

export type GoalTuiDependencies = {
    readonly createTuiBridgeClient: typeof createTuiBridgeClient;
    readonly createPersistentDaemonManager: typeof createPersistentDaemonManager;
    readonly parseGoalPlanMarkdown: typeof parseGoalPlanMarkdown;
};

const defaultDependencies: GoalTuiDependencies = {
    createTuiBridgeClient,
    createPersistentDaemonManager,
    parseGoalPlanMarkdown,
};

const terminalText = (value: string): string =>
    Array.from(value)
        .map(character => {
            const code = character.charCodeAt(0);
            return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('')
        .replace(/\s+/gu, ' ')
        .trim();

const errorText = (error: unknown): string =>
    terminalText(error instanceof Error ? error.message : String(error)).slice(
        0,
        500,
    );

const insideWorkspace = (workspace: string, path: string): boolean => {
    const local = relative(workspace, path);
    return (
        local === '' ||
        (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))
    );
};

const readAtMost = async (
    handle: Awaited<ReturnType<typeof open>>,
    maximumBytes: number,
): Promise<Buffer> => {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const { bytesRead } = await handle.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > maximumBytes) {
        throw new Error(
            `Goal-plan file exceeds the ${maximumBytes}-byte limit.`,
        );
    }
    return buffer.subarray(0, offset);
};

/** Reads a stable, regular, non-symlink file wholly within the workspace. */
export const readConfinedGoalPlanFile = async (
    workspace: string,
    inputPath: string,
    maximumBytes = MAX_GOAL_PLAN_MARKDOWN_BYTES,
): Promise<ConfinedGoalPlanFile> => {
    if (!inputPath.trim() || inputPath.includes('\0')) {
        throw new Error('Enter a nonempty goal-plan path.');
    }
    if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes <= 0 ||
        maximumBytes > MAX_GOAL_PLAN_MARKDOWN_BYTES
    ) {
        throw new RangeError(
            `maximumBytes must be from 1 through ${MAX_GOAL_PLAN_MARKDOWN_BYTES}.`,
        );
    }

    const canonicalWorkspace = await realpath(workspace);
    const workspaceInfo = await lstat(canonicalWorkspace);
    if (!workspaceInfo.isDirectory()) {
        throw new Error('The OpenCode workspace is not a directory.');
    }
    const requestedPath = resolve(canonicalWorkspace, inputPath);
    if (!insideWorkspace(canonicalWorkspace, requestedPath)) {
        throw new Error('Goal-plan path must stay within the workspace.');
    }

    const requestedInfo = await lstat(requestedPath);
    if (requestedInfo.isSymbolicLink()) {
        throw new Error('Goal-plan file may not be a symbolic link.');
    }
    if (!requestedInfo.isFile()) {
        throw new Error('Goal-plan path must name a regular file.');
    }
    if (requestedInfo.size > maximumBytes) {
        throw new Error(
            `Goal-plan file exceeds the ${maximumBytes}-byte limit.`,
        );
    }

    const canonicalPath = await realpath(requestedPath);
    if (!insideWorkspace(canonicalWorkspace, canonicalPath)) {
        throw new Error('Goal-plan path must stay within the workspace.');
    }
    if (canonicalPath !== requestedPath) {
        throw new Error('Goal-plan path may not traverse symbolic links.');
    }

    const noFollow =
        typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
    try {
        const before = await handle.stat();
        if (
            !before.isFile() ||
            before.dev !== requestedInfo.dev ||
            before.ino !== requestedInfo.ino
        ) {
            throw new Error('Goal-plan file changed while it was opened.');
        }
        if (before.size > maximumBytes) {
            throw new Error(
                `Goal-plan file exceeds the ${maximumBytes}-byte limit.`,
            );
        }
        const bytes = await readAtMost(handle, maximumBytes);
        const after = await handle.stat();
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            after.size !== bytes.length
        ) {
            throw new Error('Goal-plan file changed while it was read.');
        }
        let markdown: string;
        try {
            markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
            throw new Error('Goal-plan file must contain valid UTF-8.');
        }
        return {
            workspace: canonicalWorkspace,
            path: canonicalPath,
            markdown,
            digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        };
    } finally {
        await handle.close();
    }
};

export const prepareGoalPlan = async (
    workspace: string,
    inputPath: string,
    parser: typeof parseGoalPlanMarkdown = parseGoalPlanMarkdown,
    maximumBytes = MAX_GOAL_PLAN_MARKDOWN_BYTES,
): Promise<PreparedGoalPlan> => {
    const file = await readConfinedGoalPlanFile(
        workspace,
        inputPath,
        maximumBytes,
    );
    return { ...file, plan: parser(file.markdown) };
};

const displayPath = (prepared: PreparedGoalPlan): string => {
    const local = relative(prepared.workspace, prepared.path);
    return terminalText(local || prepared.path);
};

const confirmationMessage = (prepared: PreparedGoalPlan): string =>
    [
        `Objective: ${terminalText(prepared.plan.objective).slice(0, 500)}`,
        `Units: ${prepared.plan.units.length}`,
        `Path: ${displayPath(prepared)}`,
        `Digest: ${prepared.digest}`,
    ].join('\n');

export const openGoalLaunchDialog = (
    api: GoalDialogApi,
    services: GoalLaunchDialogServices,
    initialPath = '',
): void => {
    const showPrompt = (value: string): void => {
        const DialogPrompt = api.ui.DialogPrompt;
        api.ui.dialog.setSize('medium');
        api.ui.dialog.replace(() =>
            DialogPrompt({
                title: 'Launch supervised goal',
                placeholder: 'path/to/goal-plan.md',
                value,
                onConfirm: async inputPath => {
                    const submitted = inputPath;
                    api.ui.dialog.replace(() =>
                        DialogPrompt({
                            title: 'Launch supervised goal',
                            value: submitted,
                            busy: true,
                            busyText: 'Reading and validating plan...',
                        }),
                    );
                    try {
                        const prepared = await services.prepare(submitted);
                        const DialogConfirm = api.ui.DialogConfirm;
                        let launching = false;
                        api.ui.dialog.replace(() =>
                            DialogConfirm({
                                title: 'Confirm goal launch',
                                message: confirmationMessage(prepared),
                                onConfirm: () => {
                                    if (launching) return;
                                    launching = true;
                                    void services.launch(prepared).then(
                                        result =>
                                            api.ui.toast({
                                                variant: 'success',
                                                title: 'Goal launch complete',
                                                message: `Goal ${terminalText(result.goal.id)} is ${result.goal.state}.`,
                                            }),
                                        error =>
                                            api.ui.toast({
                                                variant: 'error',
                                                title: 'Goal launch incomplete',
                                                message: errorText(error),
                                            }),
                                    );
                                },
                            }),
                        );
                    } catch (error) {
                        api.ui.toast({
                            variant: 'error',
                            title: 'Invalid goal plan',
                            message: errorText(error),
                        });
                        showPrompt(submitted);
                    }
                },
            }),
        );
    };

    showPrompt(initialPath);
};

type ClientWithConfig = {
    readonly client?: {
        readonly getConfig?: () => { readonly baseUrl?: unknown };
    };
};

const validOpenCodeUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
        return url.href;
    } catch {
        return undefined;
    }
};

/** Resolves the pinned SDK client's server URL without exposing it to dialogs. */
export const openCodeClientUrl = (
    client: unknown,
    configuredUrl?: unknown,
): string => {
    const configured = validOpenCodeUrl(configuredUrl);
    if (configured) return configured;
    if (configuredUrl !== undefined) {
        throw new Error('Configured OpenCode URL must use HTTP or HTTPS.');
    }
    const internal = (client as ClientWithConfig).client?.getConfig?.().baseUrl;
    const discovered = validOpenCodeUrl(internal);
    if (discovered) return discovered;
    throw new Error('Could not determine the local OpenCode server URL.');
};

export type BootstrapGoalTuiOptions = {
    readonly workspace: string;
    readonly client: unknown;
    readonly openCodeUrl?: string;
    readonly actor?: string;
    readonly maximumPlanBytes?: number;
    readonly dependencies?: Partial<GoalTuiDependencies>;
};

export const bootstrapGoalTui = async (
    options: BootstrapGoalTuiOptions,
): Promise<GoalTuiRuntime> => {
    const dependencies = { ...defaultDependencies, ...options.dependencies };
    const maximumBytes =
        options.maximumPlanBytes ?? MAX_GOAL_PLAN_MARKDOWN_BYTES;
    if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes <= 0 ||
        maximumBytes > MAX_GOAL_PLAN_MARKDOWN_BYTES
    ) {
        throw new RangeError(
            `maximumPlanBytes must be from 1 through ${MAX_GOAL_PLAN_MARKDOWN_BYTES}.`,
        );
    }
    const bridge = await dependencies.createTuiBridgeClient();
    const initialized = await bridge.init(options.workspace);
    const daemonManager = await dependencies.createPersistentDaemonManager({
        workspace: initialized.workspace,
        openCodeUrl: openCodeClientUrl(options.client, options.openCodeUrl),
        verifiedPrograms: bridge.verifiedPrograms,
    });
    const actor = options.actor ?? 'tui';
    const disposed = Promise.resolve();

    return {
        workspace: initialized.workspace,
        daemonManager,
        prepare: path =>
            prepareGoalPlan(
                initialized.workspace,
                path,
                dependencies.parseGoalPlanMarkdown,
                maximumBytes,
            ),
        launch: async prepared => {
            const result = await bridge.launch({
                workspace: initialized.workspace,
                planPath: prepared.path,
                planMarkdown: prepared.markdown,
                actor,
            });
            if (result.goal.state !== 'executing') return result;
            try {
                await daemonManager.ensureRunning();
            } catch (error) {
                throw new Error(
                    `Goal ${terminalText(result.goal.id)} is durable, but its persistent daemon did not start: ${errorText(error)} Retry the same confirmed plan to retry daemon bootstrap.`,
                    { cause: error },
                );
            }
            return result;
        },
        list: () => bridge.list(initialized.workspace),
        daemonStatus: daemonManager.status,
        ensureDaemon: daemonManager.ensureRunning,
        stopDaemon: daemonManager.stop,
        dispose: () => disposed,
    };
};

export const ensureDaemonForExecutingGoals = async (
    runtime: GoalTuiRuntime,
): Promise<PersistentDaemonStatus | undefined> => {
    const listing = await runtime.list();
    return listing.hasExecuting ? await runtime.ensureDaemon() : undefined;
};

const daemonStatusText = (status: PersistentDaemonStatus): string =>
    status.status === 'running'
        ? `${status.status} (${status.ownership})`
        : status.status;

const showStatus = async (
    api: GoalDialogApi,
    runtime: GoalTuiRuntime,
): Promise<void> => {
    try {
        const [daemonStatus, listing] = await Promise.all([
            runtime.daemonStatus(),
            runtime.list(),
        ]);
        const goals = listing.goals;
        const goalLines = goals
            .slice(0, 20)
            .map(
                goal =>
                    `${terminalText(goal.id)} [${goal.state}] ${terminalText(goal.objective).slice(0, 120)}`,
            );
        const DialogAlert = api.ui.DialogAlert;
        api.ui.dialog.setSize('medium');
        api.ui.dialog.replace(() =>
            DialogAlert({
                title: 'Goal supervisor status',
                message: [
                    `Daemon: ${daemonStatusText(daemonStatus)}`,
                    `Unit: ${terminalText(daemonStatus.unitName)}`,
                    terminalText(daemonStatus.detail),
                    `Goals: ${listing.total}`,
                    ...(goalLines.length > 0
                        ? goalLines
                        : ['No supervised goals.']),
                    ...(listing.total > goalLines.length
                        ? [
                              `${listing.total - goalLines.length} more goals not shown.`,
                          ]
                        : []),
                ].join('\n'),
            }),
        );
    } catch (error) {
        api.ui.toast({
            variant: 'error',
            title: 'Goal status failed',
            message: errorText(error),
        });
    }
};

const showDaemonStop = (api: GoalDialogApi, runtime: GoalTuiRuntime): void => {
    const DialogConfirm = api.ui.DialogConfirm;
    api.ui.dialog.replace(() =>
        DialogConfirm({
            title: 'Stop goal daemon',
            message:
                'Disable and stop this workspace systemd user service? Independently managed daemons are left running.',
            onConfirm: () => {
                void runtime.stopDaemon().then(
                    status =>
                        api.ui.toast({
                            variant:
                                status.ownership === 'independent'
                                    ? 'warning'
                                    : 'success',
                            message:
                                status.ownership === 'independent'
                                    ? terminalText(status.detail)
                                    : 'Goal daemon service stopped.',
                        }),
                    error =>
                        api.ui.toast({
                            variant: 'error',
                            message: errorText(error),
                        }),
                );
            },
        }),
    );
};

export const registerGoalTuiCommands = (
    api: TuiPluginApi,
    runtime: GoalTuiRuntime,
): (() => void) =>
    api.keymap.registerLayer({
        commands: [
            {
                name: 'goal.launch.dialog',
                title: 'Launch supervised goal',
                category: 'Goal supervisor',
                namespace: 'palette',
                slashName: 'goal',
                run: () => openGoalLaunchDialog(api, runtime),
            },
            {
                name: 'goal.status.dialog',
                title: 'Goal supervisor status',
                category: 'Goal supervisor',
                namespace: 'palette',
                slashName: 'goal-status',
                run: () => {
                    void showStatus(api, runtime);
                },
            },
            {
                name: 'goal.daemon.stop.dialog',
                title: 'Stop workspace goal daemon service',
                category: 'Goal supervisor',
                namespace: 'palette',
                slashName: 'goal-daemon-stop',
                run: () => showDaemonStop(api, runtime),
            },
        ],
    });

export const createGoalTuiPlugin = (
    dependencyOverrides: Partial<GoalTuiDependencies> = {},
): TuiPluginModule & { readonly id: string } => {
    const tui: TuiPlugin = async (api, options) => {
        if (options?.enabled === false) return;
        let runtime: GoalTuiRuntime | undefined;
        let unregister: (() => void) | undefined;
        let disposed = false;
        api.lifecycle.onDispose(async () => {
            disposed = true;
            unregister?.();
            await runtime?.dispose();
        });

        const configuredMaximum = options?.maximumPlanBytes;
        const maximumPlanBytes =
            typeof configuredMaximum === 'number'
                ? Math.min(MAX_GOAL_PLAN_MARKDOWN_BYTES, configuredMaximum)
                : undefined;
        runtime = await bootstrapGoalTui({
            workspace: api.state.path.directory,
            client: api.client,
            openCodeUrl:
                typeof options?.openCodeUrl === 'string'
                    ? options.openCodeUrl
                    : undefined,
            actor:
                typeof options?.actor === 'string' ? options.actor : undefined,
            maximumPlanBytes,
            dependencies: dependencyOverrides,
        });
        if (disposed || api.lifecycle.signal.aborted) {
            await runtime.dispose();
            return;
        }
        unregister = registerGoalTuiCommands(api, runtime);
        try {
            await ensureDaemonForExecutingGoals(runtime);
        } catch (error) {
            api.ui.toast({
                variant: 'error',
                title: 'Goal daemon restart failed',
                message: errorText(error),
            });
        }
    };

    return { id: 'cbranch-goal-supervisor', tui };
};

export default createGoalTuiPlugin();
