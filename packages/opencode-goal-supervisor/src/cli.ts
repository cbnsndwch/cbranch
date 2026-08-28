#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    formatGoalStatus,
    initWorkspaceControl,
    openWorkspaceControl,
    type ControlPlanInput,
    type InitializedWorkspaceControl,
} from './control.js';
import { runGoalDaemon, type RunGoalDaemonOptions } from './daemon.js';
import {
    startManagedOpenCodeServer,
    type ManagedOpenCodeServer,
} from './managed-opencode.js';
import { runGoalMcp } from './mcp.js';
import { parseGoalPlanMarkdown } from './goal-plan.js';
import {
    createOpenCodeAdapter,
    type OpenCodeSessionAdapter,
} from './opencode-adapter.js';
import {
    DEFAULT_SYSTEMD_UNIT_NAME,
    defaultSystemdUserDirectory,
    inspectDaemonServiceStatus,
    writeSystemdUserService,
    type DaemonServiceStatus,
    type WrittenSystemdUserService,
} from './systemd.js';
import {
    goalLaunchCommandId,
    MAX_TUI_BRIDGE_GOALS,
    MAX_TUI_BRIDGE_REQUEST_BYTES,
    TUI_BRIDGE_COMMAND,
    TUI_BRIDGE_PROTOCOL,
    TuiBridgeFailureResponseSchema,
    TuiBridgeInitResponseSchema,
    TuiBridgeLaunchResponseSchema,
    TuiBridgeListResponseSchema,
    TuiBridgeRequestSchema,
    type TuiBridgeFailureResponse,
    type TuiBridgeRequest,
    type TuiBridgeSuccessResponse,
} from './tui-protocol.js';

const executableName = 'cbranch-goal-supervisor';
const defaultOpenCodeUrl = 'http://127.0.0.1:4096/';
const maximumIntervalMs = 24 * 60 * 60_000;
const maximumApprovalTtlMs = 365 * 24 * 60 * 60_000;

const commands = [
    'init',
    'serve',
    'status',
    'plan',
    'start',
    'pause',
    'resume',
    'cancel',
    'approve',
    'recover',
    'doctor',
    'mcp',
] as const;

type CommandName = (typeof commands)[number];

const approvalActions = [
    'approve-plan',
    'issue-start',
    'issue-resume',
    'issue-blocked-resume',
    'issue-recovery',
    'issue-budget',
    'issue-destructive',
    'approve-destructive',
] as const;

type ApprovalAction = (typeof approvalActions)[number];

const recoveryTargets = [
    'ready',
    'executing',
    'paused',
    'needs-replan',
    'awaiting-decision',
    'blocked',
    'cancelled',
] as const;

type RecoveryTarget = (typeof recoveryTargets)[number];

interface ParsedBase {
    readonly workspace: string;
    readonly json: boolean;
}

export type ParsedCliArguments = ParsedBase &
    (
        | {
              readonly command: 'init';
              readonly systemd: boolean;
              readonly openCodeUrl: string;
          }
        | {
              readonly command: 'serve';
              readonly openCodeUrl: string;
              readonly globalConcurrency: number;
              readonly workspaceConcurrency: number;
              readonly dispatchIntervalMs: number;
              readonly reconciliationIntervalMs: number;
              readonly cancellationIntervalMs: number;
              readonly observationRestartIntervalMs: number;
              readonly serviceIdentity?: string;
              readonly programFileIdentity?: string;
              readonly managedOpenCodePath?: string;
          }
        | { readonly command: 'status'; readonly goalId?: string }
        | {
              readonly command: 'plan';
              readonly goalId?: string;
              readonly objective?: string;
              readonly file: string;
          }
        | {
              readonly command: 'start';
              readonly goalId: string;
              readonly approvalToken: string;
          }
        | {
              readonly command: 'resume';
              readonly goalId: string;
              readonly approvalToken: string;
          }
        | {
              readonly command: 'pause';
              readonly goalId: string;
              readonly reason: string;
          }
        | {
              readonly command: 'cancel';
              readonly goalId: string;
              readonly reason: string;
          }
        | {
              readonly command: 'approve';
              readonly goalId: string;
              readonly action: ApprovalAction;
              readonly planId?: string;
              readonly workUnitId?: string;
              readonly approvalToken?: string;
              readonly actor: string;
              readonly reason: string;
              readonly ttlMs: number;
          }
        | {
              readonly command: 'recover';
              readonly goalId: string;
              readonly target: RecoveryTarget;
              readonly approvalToken: string;
              readonly decision: string;
          }
        | {
              readonly command: 'doctor';
              readonly recover: boolean;
              readonly openCodeUrl: string;
          }
        | { readonly command: 'mcp' }
    );

const usage = [
    `Usage: ${executableName} [--workspace <path>] [--json] <command> [options]`,
    `Commands: ${commands.join(', ')}`,
].join('\n');

const commandUsage: Readonly<Record<CommandName, string>> = {
    init: `Usage: ${executableName} init [--systemd] [--opencode-url <url>]`,
    serve: `Usage: ${executableName} serve [--opencode-url <url>] [concurrency and interval options]`,
    status: `Usage: ${executableName} status [goal-id]`,
    plan: `Usage: ${executableName} plan (<goal-id> | --objective <text>) --file <json>`,
    start: `Usage: ${executableName} start <goal-id> --approval-token <token>`,
    pause: `Usage: ${executableName} pause <goal-id> --reason <text>`,
    resume: `Usage: ${executableName} resume <goal-id> --approval-token <token>`,
    cancel: `Usage: ${executableName} cancel <goal-id> --reason <text>`,
    approve: `Usage: ${executableName} approve <goal-id> <action> [action options]`,
    recover: `Usage: ${executableName} recover <goal-id> --target <state> --approval-token <token> --decision <text>`,
    doctor: `Usage: ${executableName} doctor [--recover] [--opencode-url <url>]`,
    mcp: `Usage: ${executableName} mcp`,
};

type OptionKind = 'boolean' | 'value';
type ParsedOptions = Readonly<Record<string, string | true>>;

const noControlCharacters = (value: string): boolean =>
    Array.from(value).every(character => {
        const code = character.charCodeAt(0);
        return code > 0x1f && (code < 0x7f || code > 0x9f);
    });

const parseOptions = (
    arguments_: readonly string[],
    allowed: Readonly<Record<string, OptionKind>>,
    command: CommandName,
): {
    readonly options: ParsedOptions;
    readonly positionals: readonly string[];
} => {
    const options: Record<string, string | true> = {};
    const positionals: string[] = [];
    for (let index = 0; index < arguments_.length; index++) {
        const argument = arguments_[index]!;
        if (!argument.startsWith('-')) {
            positionals.push(argument);
            continue;
        }
        const kind = allowed[argument];
        if (!kind)
            throw new Error(
                `Unknown option ${argument}. ${commandUsage[command]}`,
            );
        if (argument in options)
            throw new Error(`Option ${argument} may be specified only once.`);
        if (kind === 'boolean') {
            options[argument] = true;
            continue;
        }
        const value = arguments_[++index];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Option ${argument} requires a value.`);
        }
        options[argument] = value;
    }
    return { options, positionals };
};

const optionValue = (
    options: ParsedOptions,
    name: string,
): string | undefined => {
    const value = options[name];
    return typeof value === 'string' ? value : undefined;
};

const requiredOption = (options: ParsedOptions, name: string): string => {
    const value = optionValue(options, name);
    if (value === undefined) throw new Error(`Option ${name} is required.`);
    return value;
};

const onlyPositionals = (
    positionals: readonly string[],
    minimum: number,
    maximum: number,
    command: CommandName,
): void => {
    if (positionals.length < minimum || positionals.length > maximum) {
        throw new Error(commandUsage[command]);
    }
};

const validateId = (value: string, label: string): string => {
    if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
        throw new Error(`${label} must be a compact ID without whitespace.`);
    }
    return value;
};

const validateServiceIdentity = (value: string): string => {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
        throw new Error(
            '--internal-service-identity must be a lowercase SHA-256 identity.',
        );
    }
    return value;
};

const validateProgramFileIdentity = (value: string): string => {
    if (
        value.length > 16_384 ||
        !value ||
        !noControlCharacters(value) ||
        !value.includes('|')
    ) {
        throw new Error(
            '--internal-program-file-identity has an invalid shape.',
        );
    }
    return value;
};

const validateToken = (value: string): string => {
    if (
        value.length < 32 ||
        value.length > 512 ||
        !/^[A-Za-z0-9._~+-]+$/u.test(value)
    ) {
        throw new Error('Approval token has an invalid shape.');
    }
    return value;
};

const validateText = (
    value: string,
    label: string,
    maximum: number,
    singleLine = true,
): string => {
    const trimmed = value.trim();
    if (
        !trimmed ||
        trimmed.length > maximum ||
        !noControlCharacters(trimmed) ||
        (singleLine && /[\r\n]/u.test(trimmed))
    ) {
        throw new Error(
            `${label} must be nonempty${singleLine ? ', single-line' : ''}, and at most ${maximum} characters.`,
        );
    }
    return trimmed;
};

const validatePath = (value: string, label: string): string => {
    if (!value || value.length > 4_096 || !noControlCharacters(value)) {
        throw new Error(`${label} must be a valid nonempty path.`);
    }
    return value;
};

const validateUrl = (value: string): string => {
    if (!noControlCharacters(value)) {
        throw new Error('OpenCode URL contains invalid control characters.');
    }
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('OpenCode URL must be a valid HTTP or HTTPS URL.');
    }
    if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password
    ) {
        throw new Error(
            'OpenCode URL must be an HTTP or HTTPS URL without credentials.',
        );
    }
    return parsed.toString();
};

const parseInteger = (
    value: string | undefined,
    fallback: number,
    option: string,
    maximum: number,
): number => {
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/u.test(value)) {
        throw new Error(
            `${option} must be an integer from 1 through ${maximum}.`,
        );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > maximum) {
        throw new Error(
            `${option} must be an integer from 1 through ${maximum}.`,
        );
    }
    return parsed;
};

const rejectOptions = (
    options: ParsedOptions,
    names: readonly string[],
    action: ApprovalAction,
): void => {
    const invalid = names.find(name => name in options);
    if (invalid) throw new Error(`${invalid} is not valid for ${action}.`);
};

const parseApprove = (
    base: ParsedBase,
    arguments_: readonly string[],
): ParsedCliArguments => {
    const parsed = parseOptions(
        arguments_,
        {
            '--plan-id': 'value',
            '--work-unit-id': 'value',
            '--approval-token': 'value',
            '--actor': 'value',
            '--reason': 'value',
            '--ttl-ms': 'value',
        },
        'approve',
    );
    onlyPositionals(parsed.positionals, 2, 2, 'approve');
    const goalId = validateId(parsed.positionals[0]!, 'Goal ID');
    const actionValue = parsed.positionals[1]!;
    if (!approvalActions.includes(actionValue as ApprovalAction)) {
        throw new Error(
            `Approval action must be one of: ${approvalActions.join(', ')}.`,
        );
    }
    const action = actionValue as ApprovalAction;
    const actor = validateId(
        optionValue(parsed.options, '--actor') ?? 'operator',
        'Actor',
    );
    const reason = validateText(
        optionValue(parsed.options, '--reason') ?? 'Operator approval',
        'Reason',
        500,
    );
    const ttlMs = parseInteger(
        optionValue(parsed.options, '--ttl-ms'),
        15 * 60_000,
        '--ttl-ms',
        maximumApprovalTtlMs,
    );

    if (action === 'approve-plan') {
        rejectOptions(
            parsed.options,
            ['--work-unit-id', '--approval-token', '--reason', '--ttl-ms'],
            action,
        );
        return {
            ...base,
            command: 'approve',
            goalId,
            action,
            planId: validateId(
                requiredOption(parsed.options, '--plan-id'),
                'Plan ID',
            ),
            actor,
            reason,
            ttlMs,
        };
    }
    if (action === 'approve-destructive') {
        rejectOptions(
            parsed.options,
            ['--plan-id', '--actor', '--reason', '--ttl-ms'],
            action,
        );
        return {
            ...base,
            command: 'approve',
            goalId,
            action,
            workUnitId: validateId(
                requiredOption(parsed.options, '--work-unit-id'),
                'Work unit ID',
            ),
            approvalToken: validateToken(
                requiredOption(parsed.options, '--approval-token'),
            ),
            actor,
            reason,
            ttlMs,
        };
    }

    rejectOptions(parsed.options, ['--plan-id', '--approval-token'], action);
    const workUnitId = optionValue(parsed.options, '--work-unit-id');
    if (action === 'issue-destructive' && workUnitId === undefined) {
        throw new Error('Option --work-unit-id is required.');
    }
    if (action !== 'issue-destructive' && workUnitId !== undefined) {
        throw new Error(`--work-unit-id is not valid for ${action}.`);
    }
    return {
        ...base,
        command: 'approve',
        goalId,
        action,
        ...(workUnitId
            ? { workUnitId: validateId(workUnitId, 'Work unit ID') }
            : {}),
        actor,
        reason,
        ttlMs,
    };
};

/** Parse and validate argv without opening files, workspace state, or transports. */
export const parseCliArguments = (
    arguments_: readonly string[],
    cwd = process.cwd(),
): ParsedCliArguments => {
    const remaining: string[] = [];
    let workspaceOption: string | undefined;
    let json = false;
    for (let index = 0; index < arguments_.length; index++) {
        const argument = arguments_[index]!;
        if (argument === '--workspace') {
            if (workspaceOption !== undefined) {
                throw new Error(
                    'Option --workspace may be specified only once.',
                );
            }
            const value = arguments_[++index];
            if (value === undefined || value.startsWith('--')) {
                throw new Error('Option --workspace requires a value.');
            }
            workspaceOption = validatePath(value, 'Workspace');
        } else if (argument === '--json') {
            if (json)
                throw new Error('Option --json may be specified only once.');
            json = true;
        } else {
            remaining.push(argument);
        }
    }

    const commandValue = remaining.shift();
    if (!commandValue) throw new Error(usage);
    if (!commands.includes(commandValue as CommandName)) {
        throw new Error(
            `Unknown command ${JSON.stringify(commandValue)}. ${usage}`,
        );
    }
    const command = commandValue as CommandName;
    const workspace = resolve(
        validatePath(cwd, 'Current directory'),
        workspaceOption ?? '.',
    );
    const base: ParsedBase = { workspace, json };

    if (command === 'init') {
        const parsed = parseOptions(
            remaining,
            { '--systemd': 'boolean', '--opencode-url': 'value' },
            command,
        );
        onlyPositionals(parsed.positionals, 0, 0, command);
        const systemd = parsed.options['--systemd'] === true;
        if (!systemd && '--opencode-url' in parsed.options) {
            throw new Error('--opencode-url requires --systemd for init.');
        }
        return {
            ...base,
            command,
            systemd,
            openCodeUrl: validateUrl(
                optionValue(parsed.options, '--opencode-url') ??
                    defaultOpenCodeUrl,
            ),
        };
    }
    if (command === 'serve') {
        const parsed = parseOptions(
            remaining,
            {
                '--opencode-url': 'value',
                '--global-concurrency': 'value',
                '--workspace-concurrency': 'value',
                '--dispatch-interval-ms': 'value',
                '--reconciliation-interval-ms': 'value',
                '--cancellation-interval-ms': 'value',
                '--observation-restart-interval-ms': 'value',
                '--internal-service-identity': 'value',
                '--internal-program-file-identity': 'value',
                '--internal-managed-opencode': 'value',
            },
            command,
        );
        onlyPositionals(parsed.positionals, 0, 0, command);
        const managedOpenCodePath = optionValue(
            parsed.options,
            '--internal-managed-opencode',
        );
        if (
            managedOpenCodePath !== undefined &&
            '--opencode-url' in parsed.options
        ) {
            throw new Error(
                '--internal-managed-opencode may not be combined with --opencode-url.',
            );
        }
        const programFileIdentity = optionValue(
            parsed.options,
            '--internal-program-file-identity',
        );
        if (
            programFileIdentity !== undefined &&
            !optionValue(parsed.options, '--internal-service-identity')
        ) {
            throw new Error(
                '--internal-program-file-identity requires --internal-service-identity.',
            );
        }
        if (
            managedOpenCodePath !== undefined &&
            !isAbsolute(managedOpenCodePath)
        ) {
            throw new Error(
                '--internal-managed-opencode requires an absolute path.',
            );
        }
        const globalConcurrency = parseInteger(
            optionValue(parsed.options, '--global-concurrency'),
            4,
            '--global-concurrency',
            1_000,
        );
        const workspaceConcurrency = parseInteger(
            optionValue(parsed.options, '--workspace-concurrency'),
            2,
            '--workspace-concurrency',
            1_000,
        );
        if (workspaceConcurrency > globalConcurrency) {
            throw new Error(
                '--workspace-concurrency may not exceed --global-concurrency.',
            );
        }
        return {
            ...base,
            command,
            openCodeUrl: validateUrl(
                optionValue(parsed.options, '--opencode-url') ??
                    defaultOpenCodeUrl,
            ),
            globalConcurrency,
            workspaceConcurrency,
            ...(optionValue(parsed.options, '--internal-service-identity')
                ? {
                      serviceIdentity: validateServiceIdentity(
                          optionValue(
                              parsed.options,
                              '--internal-service-identity',
                          )!,
                      ),
                  }
                : {}),
            ...(managedOpenCodePath
                ? {
                      managedOpenCodePath: resolve(
                          validatePath(
                              managedOpenCodePath,
                              'Managed OpenCode path',
                          ),
                      ),
                  }
                : {}),
            ...(programFileIdentity
                ? {
                      programFileIdentity:
                          validateProgramFileIdentity(programFileIdentity),
                  }
                : {}),
            dispatchIntervalMs: parseInteger(
                optionValue(parsed.options, '--dispatch-interval-ms'),
                1_000,
                '--dispatch-interval-ms',
                maximumIntervalMs,
            ),
            reconciliationIntervalMs: parseInteger(
                optionValue(parsed.options, '--reconciliation-interval-ms'),
                1_000,
                '--reconciliation-interval-ms',
                maximumIntervalMs,
            ),
            cancellationIntervalMs: parseInteger(
                optionValue(parsed.options, '--cancellation-interval-ms'),
                500,
                '--cancellation-interval-ms',
                maximumIntervalMs,
            ),
            observationRestartIntervalMs: parseInteger(
                optionValue(
                    parsed.options,
                    '--observation-restart-interval-ms',
                ),
                1_000,
                '--observation-restart-interval-ms',
                maximumIntervalMs,
            ),
        };
    }
    if (command === 'status') {
        const parsed = parseOptions(remaining, {}, command);
        onlyPositionals(parsed.positionals, 0, 1, command);
        return {
            ...base,
            command,
            ...(parsed.positionals[0]
                ? { goalId: validateId(parsed.positionals[0], 'Goal ID') }
                : {}),
        };
    }
    if (command === 'plan') {
        const parsed = parseOptions(
            remaining,
            { '--file': 'value', '--objective': 'value' },
            command,
        );
        const objectiveValue = optionValue(parsed.options, '--objective');
        onlyPositionals(
            parsed.positionals,
            objectiveValue === undefined ? 1 : 0,
            objectiveValue === undefined ? 1 : 0,
            command,
        );
        return {
            ...base,
            command,
            ...(objectiveValue === undefined
                ? { goalId: validateId(parsed.positionals[0]!, 'Goal ID') }
                : {
                      objective: validateText(
                          objectiveValue,
                          'Objective',
                          20_000,
                          false,
                      ),
                  }),
            file: resolve(
                validatePath(cwd, 'Current directory'),
                validatePath(
                    requiredOption(parsed.options, '--file'),
                    'Plan file',
                ),
            ),
        };
    }
    if (command === 'start' || command === 'resume') {
        const parsed = parseOptions(
            remaining,
            { '--approval-token': 'value' },
            command,
        );
        onlyPositionals(parsed.positionals, 1, 1, command);
        return {
            ...base,
            command,
            goalId: validateId(parsed.positionals[0]!, 'Goal ID'),
            approvalToken: validateToken(
                requiredOption(parsed.options, '--approval-token'),
            ),
        };
    }
    if (command === 'pause' || command === 'cancel') {
        const parsed = parseOptions(
            remaining,
            { '--reason': 'value' },
            command,
        );
        onlyPositionals(parsed.positionals, 1, 1, command);
        return {
            ...base,
            command,
            goalId: validateId(parsed.positionals[0]!, 'Goal ID'),
            reason: validateText(
                requiredOption(parsed.options, '--reason'),
                'Reason',
                500,
            ),
        };
    }
    if (command === 'approve') return parseApprove(base, remaining);
    if (command === 'recover') {
        const parsed = parseOptions(
            remaining,
            {
                '--target': 'value',
                '--approval-token': 'value',
                '--decision': 'value',
            },
            command,
        );
        onlyPositionals(parsed.positionals, 1, 1, command);
        const targetValue = requiredOption(parsed.options, '--target');
        if (!recoveryTargets.includes(targetValue as RecoveryTarget)) {
            throw new Error(
                `Recovery target must be one of: ${recoveryTargets.join(', ')}.`,
            );
        }
        return {
            ...base,
            command,
            goalId: validateId(parsed.positionals[0]!, 'Goal ID'),
            target: targetValue as RecoveryTarget,
            approvalToken: validateToken(
                requiredOption(parsed.options, '--approval-token'),
            ),
            decision: validateText(
                requiredOption(parsed.options, '--decision'),
                'Decision',
                500,
            ),
        };
    }
    if (command === 'doctor') {
        const parsed = parseOptions(
            remaining,
            { '--recover': 'boolean', '--opencode-url': 'value' },
            command,
        );
        onlyPositionals(parsed.positionals, 0, 0, command);
        return {
            ...base,
            command,
            recover: parsed.options['--recover'] === true,
            openCodeUrl: validateUrl(
                optionValue(parsed.options, '--opencode-url') ??
                    defaultOpenCodeUrl,
            ),
        };
    }
    const parsed = parseOptions(remaining, {}, command);
    onlyPositionals(parsed.positionals, 0, 0, command);
    return { ...base, command };
};

interface OutputWriter {
    write(value: string): unknown;
}

export type TuiBridgeInput = AsyncIterable<
    string | Uint8Array<ArrayBufferLike>
>;

export interface CliDependencies {
    readonly cwd?: () => string;
    readonly stdin?: TuiBridgeInput;
    readonly stdout?: OutputWriter;
    readonly stderr?: OutputWriter;
    readonly initWorkspaceControl?: typeof initWorkspaceControl;
    readonly openWorkspaceControl?: typeof openWorkspaceControl;
    readonly parseGoalPlanMarkdown?: typeof parseGoalPlanMarkdown;
    readonly readFile?: typeof readFile;
    readonly randomUUID?: () => string;
    readonly createOpenCodeAdapter?: typeof createOpenCodeAdapter;
    readonly startManagedOpenCodeServer?: typeof startManagedOpenCodeServer;
    readonly runGoalDaemon?: (options: RunGoalDaemonOptions) => Promise<void>;
    readonly runGoalMcp?: typeof runGoalMcp;
    readonly writeSystemdUserService?: typeof writeSystemdUserService;
    readonly inspectDaemonServiceStatus?: typeof inspectDaemonServiceStatus;
    readonly readProgramFileIdentity?: (
        paths: readonly string[],
    ) => Promise<string>;
    readonly systemdUserDirectory?: () => string;
    readonly executablePath?: string;
    readonly cliPath?: string;
}

type ResolvedCliDependencies = Required<
    Omit<CliDependencies, 'systemdUserDirectory' | 'executablePath' | 'cliPath'>
> & {
    readonly systemdUserDirectory: () => string;
    readonly executablePath: string;
    readonly cliPath: string;
};

const readProgramFileIdentity = async (
    paths: readonly string[],
): Promise<string> =>
    (
        await Promise.all(
            paths.map(async path => {
                const info = await lstat(path);
                if (!info.isFile() || info.isSymbolicLink()) {
                    throw new Error(
                        'Managed service program identity is no longer a regular file.',
                    );
                }
                return `${path}:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
            }),
        )
    ).join('|');

const dependencies = (input: CliDependencies): ResolvedCliDependencies => ({
    cwd: input.cwd ?? (() => process.cwd()),
    stdin: input.stdin ?? process.stdin,
    stdout: input.stdout ?? process.stdout,
    stderr: input.stderr ?? process.stderr,
    initWorkspaceControl: input.initWorkspaceControl ?? initWorkspaceControl,
    openWorkspaceControl: input.openWorkspaceControl ?? openWorkspaceControl,
    parseGoalPlanMarkdown: input.parseGoalPlanMarkdown ?? parseGoalPlanMarkdown,
    readFile: input.readFile ?? readFile,
    randomUUID: input.randomUUID ?? randomUUID,
    createOpenCodeAdapter: input.createOpenCodeAdapter ?? createOpenCodeAdapter,
    startManagedOpenCodeServer:
        input.startManagedOpenCodeServer ?? startManagedOpenCodeServer,
    runGoalDaemon: input.runGoalDaemon ?? runGoalDaemon,
    runGoalMcp: input.runGoalMcp ?? runGoalMcp,
    writeSystemdUserService:
        input.writeSystemdUserService ?? writeSystemdUserService,
    inspectDaemonServiceStatus:
        input.inspectDaemonServiceStatus ?? inspectDaemonServiceStatus,
    readProgramFileIdentity:
        input.readProgramFileIdentity ?? readProgramFileIdentity,
    systemdUserDirectory:
        input.systemdUserDirectory ?? defaultSystemdUserDirectory,
    executablePath: resolve(input.executablePath ?? process.execPath),
    cliPath: resolve(input.cliPath ?? process.argv[1] ?? 'dist/cli.js'),
});

const redactedJson = (_key: string, value: unknown): unknown => {
    if (
        _key === 'authToken' ||
        _key === 'internalTransportAuthToken' ||
        _key === 'tokenHash'
    ) {
        return undefined;
    }
    return value;
};

const printJson = (output: OutputWriter, value: unknown): void => {
    output.write(`${JSON.stringify(value, redactedJson)}\n`);
};

const concise = (value: unknown): string =>
    Array.from(String(value))
        .map(character => (noControlCharacters(character) ? character : ' '))
        .join('')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 500);

const errorMessage = (error: unknown): string => {
    const message = concise(error instanceof Error ? error.message : error);
    return message || 'Goal supervisor command failed.';
};

export type TuiBridgeDependencies = Pick<
    CliDependencies,
    | 'stdin'
    | 'stdout'
    | 'initWorkspaceControl'
    | 'openWorkspaceControl'
    | 'parseGoalPlanMarkdown'
>;

class InvalidTuiBridgeRequestError extends Error {}

const readTuiBridgeRequest = async (
    input: TuiBridgeInput,
): Promise<TuiBridgeRequest> => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of input) {
        const bytes =
            typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        byteLength += bytes.byteLength;
        if (byteLength > MAX_TUI_BRIDGE_REQUEST_BYTES) {
            throw new InvalidTuiBridgeRequestError(
                'TUI bridge request exceeds the input limit.',
            );
        }
        chunks.push(Buffer.from(bytes));
    }
    if (byteLength === 0) {
        throw new InvalidTuiBridgeRequestError(
            'TUI bridge request must contain one JSON object.',
        );
    }

    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks, byteLength),
        );
    } catch {
        throw new InvalidTuiBridgeRequestError(
            'TUI bridge request must be valid UTF-8.',
        );
    }

    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new InvalidTuiBridgeRequestError(
            'TUI bridge request must contain exactly one JSON object.',
        );
    }
    const request = TuiBridgeRequestSchema.safeParse(value);
    if (!request.success) {
        throw new InvalidTuiBridgeRequestError(
            'TUI bridge request does not match the protocol.',
        );
    }
    return request.data;
};

const insideWorkspace = (workspace: string, path: string): boolean => {
    const local = relative(workspace, path);
    return (
        local === '' ||
        (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))
    );
};

const terminalSummary = (value: string): string =>
    Array.from(value)
        .map(character => {
            const code = character.codePointAt(0)!;
            return code < 0x20 || (code >= 0x7f && code <= 0x9f)
                ? ' '
                : character;
        })
        .join('')
        .replace(/[\s\u2028\u2029]+/gu, ' ')
        .trim()
        .slice(0, 500);

const bridgeErrorMessage = (
    error: unknown,
    loadedTokens: readonly string[],
): string => {
    let value = error instanceof Error ? error.message : String(error);
    for (const token of loadedTokens) {
        if (token) value = value.replaceAll(token, '[REDACTED]');
    }
    const message = terminalSummary(value);
    return message || 'Goal supervisor TUI operation failed.';
};

const bridgeSuccess = async (
    request: TuiBridgeRequest,
    resolved: ResolvedCliDependencies,
    loadedTokens: string[],
): Promise<TuiBridgeSuccessResponse> => {
    if (request.operation === 'init') {
        const initialized = await resolved.initWorkspaceControl(
            request.workspace,
        );
        loadedTokens.push(initialized.internalTransportAuthToken);
        try {
            return TuiBridgeInitResponseSchema.parse({
                protocol: TUI_BRIDGE_PROTOCOL,
                ok: true,
                operation: 'init',
                workspace: initialized.workspace,
            });
        } finally {
            await initialized.control.close();
        }
    }

    const parsedPlan =
        request.operation === 'launch'
            ? resolved.parseGoalPlanMarkdown(request.planMarkdown)
            : undefined;
    const initialized = await resolved.openWorkspaceControl(request.workspace);
    loadedTokens.push(initialized.internalTransportAuthToken);
    try {
        const authToken = initialized.internalTransportAuthToken;
        if (request.operation === 'list') {
            const goals = initialized.control.list({ authToken });
            return TuiBridgeListResponseSchema.parse({
                protocol: TUI_BRIDGE_PROTOCOL,
                ok: true,
                operation: 'list',
                total: goals.length,
                hasExecuting: goals.some(goal => goal.state === 'executing'),
                goals: goals.slice(0, MAX_TUI_BRIDGE_GOALS).map(goal => ({
                    id: terminalSummary(goal.id),
                    state: goal.state,
                    objective: terminalSummary(goal.objective),
                })),
            });
        }

        if (
            !isAbsolute(request.planPath) ||
            resolve(request.planPath) !== request.planPath ||
            !insideWorkspace(initialized.workspace, request.planPath)
        ) {
            throw new Error(
                'Goal-plan path must be canonical, absolute, and within the workspace.',
            );
        }
        const result = initialized.control.createProposeApproveStart({
            authToken,
            commandId: goalLaunchCommandId(
                initialized.workspace,
                request.planPath,
                parsedPlan!,
                request.actor,
            ),
            planMarkdown: request.planMarkdown,
            actor: request.actor,
        });
        const current = initialized.control.status({
            authToken,
            goalId: result.goal.id,
        });
        return TuiBridgeLaunchResponseSchema.parse({
            protocol: TUI_BRIDGE_PROTOCOL,
            ok: true,
            operation: 'launch',
            goal: { id: current.goal.id, state: current.goal.state },
        });
    } finally {
        await initialized.control.close();
    }
};

/** Runs the private one-request stdio bridge used by the Bun-hosted TUI. */
export const runTuiBridge = async (
    arguments_: readonly string[] = [],
    inputDependencies: TuiBridgeDependencies = {},
): Promise<number> => {
    const resolved = dependencies(inputDependencies);
    const loadedTokens: string[] = [];
    let response: TuiBridgeSuccessResponse | TuiBridgeFailureResponse;
    try {
        if (arguments_.length !== 0) {
            throw new InvalidTuiBridgeRequestError(
                'The TUI bridge accepts no command-line arguments.',
            );
        }
        const request = await readTuiBridgeRequest(resolved.stdin);
        response = await bridgeSuccess(request, resolved, loadedTokens);
    } catch (error) {
        const invalid = error instanceof InvalidTuiBridgeRequestError;
        response = TuiBridgeFailureResponseSchema.parse({
            protocol: TUI_BRIDGE_PROTOCOL,
            ok: false,
            error: {
                code: invalid ? 'invalid-request' : 'operation-failed',
                message: invalid
                    ? 'Invalid TUI bridge request.'
                    : bridgeErrorMessage(error, loadedTokens),
            },
        });
    }
    resolved.stdout.write(`${JSON.stringify(response)}\n`);
    return response.ok ? 0 : 1;
};

const shellArgument = (value: string): string =>
    `'${value.replaceAll("'", `'"'"'`)}'`;

const auth = (initialized: InitializedWorkspaceControl) =>
    initialized.internalTransportAuthToken;

const withControl = async <Result>(
    parsed: ParsedCliArguments,
    resolved: ResolvedCliDependencies,
    callback: (
        initialized: InitializedWorkspaceControl,
    ) => Promise<Result> | Result,
): Promise<Result> => {
    const initialized = await resolved.initWorkspaceControl(parsed.workspace);
    try {
        return await callback(initialized);
    } finally {
        await initialized.control.close();
    }
};

const parsePlanFile = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'plan' }>,
    resolved: ResolvedCliDependencies,
): Promise<ControlPlanInput> => {
    let value: unknown;
    try {
        value = JSON.parse(await resolved.readFile(parsed.file, 'utf8'));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Plan file is not valid JSON: ${error.message}`, {
                cause: error,
            });
        }
        throw error;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Plan file must contain one JSON object.');
    }
    const transportKeys = new Set([
        'authToken',
        'commandId',
        'goalId',
        'workspace',
        'internalTransportAuthToken',
        'tokenHash',
    ]);
    const transportKey = (input: unknown): string | undefined => {
        if (Array.isArray(input)) {
            return input.map(transportKey).find(key => key !== undefined);
        }
        if (typeof input !== 'object' || input === null) return undefined;
        for (const [key, nested] of Object.entries(input)) {
            if (transportKeys.has(key)) return key;
            const found = transportKey(nested);
            if (found) return found;
        }
        return undefined;
    };
    const forbiddenKey = transportKey(value);
    if (forbiddenKey) {
        throw new Error(
            `Plan file must not contain transport field ${forbiddenKey}.`,
        );
    }
    // The control boundary remains the authoritative plan schema validator.
    return value as ControlPlanInput;
};

const executePlan = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'plan' }>,
    plan: ControlPlanInput,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    await withControl(parsed, resolved, initialized => {
        const authToken = auth(initialized);
        const goal = parsed.objective
            ? initialized.control.create({
                  authToken,
                  commandId: resolved.randomUUID(),
                  objective: parsed.objective,
              })
            : undefined;
        const goalId = parsed.goalId ?? goal!.id;
        const proposed = initialized.control.plan({
            authToken,
            commandId: resolved.randomUUID(),
            goalId,
            plan,
        });
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'plan',
                workspace: initialized.workspace,
                ...(goal ? { createdGoal: goal } : {}),
                plan: proposed,
            });
        } else {
            if (goal) {
                resolved.stdout.write(`Created goal ${goal.id}.\n`);
            }
            resolved.stdout.write(
                `Proposed plan ${proposed.id} revision ${proposed.revision} for goal ${goalId}.\n`,
            );
        }
    });
};

const executeInit = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'init' }>,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    const initialized = await resolved.initWorkspaceControl(parsed.workspace);
    let installed: WrittenSystemdUserService | undefined;
    try {
        if (parsed.systemd) {
            const systemdUserDirectory = resolve(
                resolved.systemdUserDirectory(),
            );
            installed = await resolved.writeSystemdUserService({
                executablePath: resolved.executablePath,
                cliPath: resolved.cliPath,
                workspace: initialized.workspace,
                openCodeUrl: parsed.openCodeUrl,
                systemdUserDirectory,
                unitPath: join(systemdUserDirectory, DEFAULT_SYSTEMD_UNIT_NAME),
            });
        }
        const databasePath = join(
            initialized.workspace,
            '.opencode',
            'goal-supervisor',
            'goal.db',
        );
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'init',
                workspace: initialized.workspace,
                databasePath,
                tokenPath: initialized.tokenPath,
                ...(installed ? { systemd: installed } : {}),
                nextCommands: installed
                    ? [
                          installed.lifecycleCommands.daemonReload,
                          installed.lifecycleCommands.enable,
                          installed.lifecycleCommands.start,
                          installed.lifecycleCommands.status,
                      ]
                    : [
                          `${executableName} --workspace ${shellArgument(initialized.workspace)} serve --opencode-url ${shellArgument(parsed.openCodeUrl)}`,
                          `${executableName} --workspace ${shellArgument(initialized.workspace)} mcp`,
                      ],
            });
            return;
        }
        resolved.stdout.write(
            `Initialized goal supervisor in ${initialized.workspace}.\n`,
        );
        resolved.stdout.write(`Database: ${databasePath}\n`);
        resolved.stdout.write(`Control token file: ${initialized.tokenPath}\n`);
        if (installed) {
            resolved.stdout.write(
                `Wrote user service ${installed.unitPath}; no systemctl command was run.\n`,
            );
            resolved.stdout.write(
                'Next commands (run only those you choose):\n',
            );
            for (const command of Object.values(installed.lifecycleCommands)) {
                resolved.stdout.write(`${command}\n`);
            }
        } else {
            resolved.stdout.write('Next commands:\n');
            resolved.stdout.write(
                `${executableName} --workspace ${shellArgument(initialized.workspace)} serve --opencode-url ${shellArgument(parsed.openCodeUrl)}\n`,
            );
            resolved.stdout.write(
                `${executableName} --workspace ${shellArgument(initialized.workspace)} mcp\n`,
            );
        }
    } finally {
        await initialized.control.close();
    }
};

const executeStatus = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'status' }>,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    await withControl(parsed, resolved, initialized => {
        const authToken = auth(initialized);
        if (parsed.goalId) {
            const status = initialized.control.status({
                authToken,
                goalId: parsed.goalId,
            });
            if (parsed.json) {
                printJson(resolved.stdout, {
                    command: 'status',
                    workspace: initialized.workspace,
                    status,
                });
            } else {
                resolved.stdout.write(`${formatGoalStatus(status)}\n`);
            }
            return;
        }
        const goals = initialized.control.list({ authToken });
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'status',
                workspace: initialized.workspace,
                goals,
            });
        } else if (goals.length === 0) {
            resolved.stdout.write('No goals.\n');
        } else {
            for (const goal of goals) {
                resolved.stdout.write(
                    `${goal.id}\t${goal.state}\t${concise(goal.objective)}\n`,
                );
            }
        }
    });
};

const executeGoalMutation = async (
    parsed: Extract<
        ParsedCliArguments,
        {
            readonly command:
                | 'start'
                | 'pause'
                | 'resume'
                | 'cancel'
                | 'recover';
        }
    >,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    await withControl(parsed, resolved, initialized => {
        const envelope = {
            authToken: auth(initialized),
            commandId: resolved.randomUUID(),
            goalId: parsed.goalId,
        };
        const goal =
            parsed.command === 'start'
                ? initialized.control.start({
                      ...envelope,
                      approvalToken: parsed.approvalToken,
                  })
                : parsed.command === 'resume'
                  ? initialized.control.resume({
                        ...envelope,
                        approvalToken: parsed.approvalToken,
                    })
                  : parsed.command === 'pause'
                    ? initialized.control.pause({
                          ...envelope,
                          reason: parsed.reason,
                      })
                    : parsed.command === 'cancel'
                      ? initialized.control.cancel({
                            ...envelope,
                            reason: parsed.reason,
                        })
                      : initialized.control.recover({
                            ...envelope,
                            approvalToken: parsed.approvalToken,
                            targetState: parsed.target,
                            decision: parsed.decision,
                        });
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: parsed.command,
                workspace: initialized.workspace,
                goal,
            });
        } else {
            resolved.stdout.write(`Goal ${goal.id}: ${goal.state}.\n`);
        }
    });
};

const approvalScope = (
    action: Exclude<ApprovalAction, 'approve-plan' | 'approve-destructive'>,
    workUnitId?: string,
) => {
    switch (action) {
        case 'issue-start':
            return {
                type: 'goal-action' as const,
                action: 'unattended-start' as const,
            };
        case 'issue-resume':
            return { type: 'goal-action' as const, action: 'resume' as const };
        case 'issue-blocked-resume':
            return {
                type: 'goal-action' as const,
                action: 'blocked-resume' as const,
            };
        case 'issue-recovery':
            return {
                type: 'goal-action' as const,
                action: 'recover-unknown-outcome' as const,
            };
        case 'issue-budget':
            return {
                type: 'goal-action' as const,
                action: 'raise-budget' as const,
            };
        case 'issue-destructive':
            return { type: 'work-unit' as const, workUnitId: workUnitId! };
    }
};

const executeApprove = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'approve' }>,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    await withControl(parsed, resolved, initialized => {
        const envelope = {
            authToken: auth(initialized),
            commandId: resolved.randomUUID(),
            goalId: parsed.goalId,
        };
        if (parsed.action === 'approve-plan') {
            const goal = initialized.control.approvePlan({
                ...envelope,
                planId: parsed.planId!,
                actor: parsed.actor,
            });
            if (parsed.json) {
                printJson(resolved.stdout, {
                    command: 'approve',
                    action: parsed.action,
                    workspace: initialized.workspace,
                    goal,
                });
            } else {
                resolved.stdout.write(`Goal ${goal.id}: ${goal.state}.\n`);
            }
            return;
        }
        if (parsed.action === 'approve-destructive') {
            const workUnit = initialized.control.approveDestructiveUnit({
                ...envelope,
                workUnitId: parsed.workUnitId!,
                approvalToken: parsed.approvalToken!,
            });
            if (parsed.json) {
                printJson(resolved.stdout, {
                    command: 'approve',
                    action: parsed.action,
                    workspace: initialized.workspace,
                    workUnit,
                });
            } else {
                resolved.stdout.write(
                    `Approved destructive work unit ${workUnit.id}.\n`,
                );
            }
            return;
        }
        const issued = initialized.control.issueScopedApproval({
            ...envelope,
            scope: approvalScope(parsed.action, parsed.workUnitId),
            actor: parsed.actor,
            reason: parsed.reason,
            ttlMs: parsed.ttlMs,
        });
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'approve',
                action: parsed.action,
                workspace: initialized.workspace,
                ...issued,
            });
        } else if (issued.actionToken) {
            resolved.stdout.write(
                `Issued ${parsed.action} approval ${issued.approval.id}.\n`,
            );
            resolved.stdout.write(`Approval token: ${issued.actionToken}\n`);
        } else {
            resolved.stdout.write(
                `Approval ${issued.approval.id} already exists; its one-time action token cannot be replayed.\n`,
            );
        }
    });
};

interface PermissionStatus {
    readonly path: string;
    readonly exists: boolean;
    readonly mode?: string;
    readonly ownerOnly: boolean;
    readonly regularFile: boolean;
    readonly symbolicLink: boolean;
}

const permissionStatus = async (path: string): Promise<PermissionStatus> => {
    try {
        const info = await lstat(path);
        const mode = info.mode & 0o777;
        const owned =
            typeof process.getuid !== 'function' ||
            info.uid === process.getuid();
        const symbolicLink = info.isSymbolicLink();
        return {
            path,
            exists: true,
            mode: mode.toString(8).padStart(4, '0'),
            ownerOnly:
                !symbolicLink &&
                owned &&
                (process.platform === 'win32' || mode === 0o600),
            regularFile: !symbolicLink && info.isFile(),
            symbolicLink,
        };
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        ) {
            return {
                path,
                exists: false,
                ownerOnly: false,
                regularFile: false,
                symbolicLink: false,
            };
        }
        throw error;
    }
};

const openCodeHealth = async (
    resolved: ResolvedCliDependencies,
    workspace: string,
    url: string,
): Promise<{
    readonly url: string;
    readonly healthy: boolean;
    readonly detail?: string;
}> => {
    try {
        const adapter = await resolved.createOpenCodeAdapter({
            baseUrl: url,
            directory: workspace,
        });
        const result = await adapter.health(AbortSignal.timeout(5_000));
        return { url, ...result };
    } catch (error) {
        return { url, healthy: false, detail: errorMessage(error) };
    }
};

const daemonStatusText = (status: DaemonServiceStatus): string =>
    status.status === 'running' || status.status === 'stale'
        ? `${status.status} (PID ${status.pid})`
        : status.status === 'invalid'
          ? `invalid (${status.detail})`
          : 'stopped';

const publicDaemonStatus = (
    status: DaemonServiceStatus,
): Omit<DaemonServiceStatus, 'token'> => {
    if (status.status !== 'running' && status.status !== 'stale') return status;
    const { token: _token, ...publicStatus } = status;
    return publicStatus;
};

const executeDoctor = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'doctor' }>,
    resolved: ResolvedCliDependencies,
): Promise<boolean> => {
    let initialized: InitializedWorkspaceControl | undefined;
    try {
        initialized = await resolved.openWorkspaceControl(parsed.workspace);
    } catch (error) {
        const directory = join(
            parsed.workspace,
            '.opencode',
            'goal-supervisor',
        );
        const [database, token, service] = await Promise.all([
            permissionStatus(join(directory, 'goal.db')),
            permissionStatus(join(directory, 'control.token')),
            resolved.inspectDaemonServiceStatus(
                join(directory, 'daemon.lock'),
                {
                    workspace: parsed.workspace,
                },
            ),
        ]);
        const detail = errorMessage(error);
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'doctor',
                healthy: false,
                workspace: parsed.workspace,
                control: { available: false, detail },
                database,
                token,
                service: publicDaemonStatus(service),
                openCode: {
                    url: parsed.openCodeUrl,
                    healthy: false,
                    detail: 'Control state is unavailable.',
                },
            });
        } else {
            resolved.stdout.write('Doctor: issues found\n');
            resolved.stdout.write(`Workspace: ${parsed.workspace}\n`);
            resolved.stdout.write(`Control state: unavailable (${detail})\n`);
            resolved.stdout.write(
                `Database: invalid (${database.mode ?? 'missing'})\n`,
            );
            resolved.stdout.write(
                `Control token: invalid (${token.mode ?? 'missing'})\n`,
            );
            resolved.stdout.write(`Daemon: ${daemonStatusText(service)}\n`);
            resolved.stdout.write('OpenCode: not checked\n');
        }
        return false;
    }
    try {
        const directory = join(
            initialized.workspace,
            '.opencode',
            'goal-supervisor',
        );
        const doctor = initialized.control.doctor({
            authToken: auth(initialized),
            recover: parsed.recover,
            ...(parsed.recover ? { commandId: resolved.randomUUID() } : {}),
        });
        const [database, token, service, openCode] = await Promise.all([
            permissionStatus(join(directory, 'goal.db')),
            permissionStatus(initialized.tokenPath),
            resolved.inspectDaemonServiceStatus(
                join(directory, 'daemon.lock'),
                {
                    workspace: initialized.workspace,
                },
            ),
            openCodeHealth(resolved, initialized.workspace, parsed.openCodeUrl),
        ]);
        const permissionsOk =
            database.exists &&
            database.regularFile &&
            database.ownerOnly &&
            token.exists &&
            token.regularFile &&
            token.ownerOnly;
        const serviceOk =
            service.status !== 'invalid' && service.status !== 'stale';
        const healthy =
            doctor.integrity.ok &&
            doctor.projections.ok &&
            permissionsOk &&
            serviceOk &&
            openCode.healthy;
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'doctor',
                healthy,
                ...doctor,
                database,
                token,
                service: publicDaemonStatus(service),
                openCode,
            });
        } else {
            resolved.stdout.write(
                `Doctor: ${healthy ? 'healthy' : 'issues found'}\n`,
            );
            resolved.stdout.write(`Workspace: ${initialized.workspace}\n`);
            resolved.stdout.write(
                `Database: ${database.ownerOnly && database.regularFile ? 'ok' : 'invalid'} (${database.mode ?? 'missing'})\n`,
            );
            resolved.stdout.write(
                `Control token: ${token.ownerOnly && token.regularFile ? 'ok' : 'invalid'} (${token.mode ?? 'missing'})\n`,
            );
            resolved.stdout.write(`Daemon: ${daemonStatusText(service)}\n`);
            resolved.stdout.write(
                `Integrity: ${doctor.integrity.ok ? 'ok' : 'failed'}\n`,
            );
            resolved.stdout.write(
                `Projections: ${doctor.projections.ok ? 'ok' : 'failed'}\n`,
            );
            if (doctor.recovery) {
                resolved.stdout.write(
                    `Recovery: ${JSON.stringify(doctor.recovery)}\n`,
                );
            }
            resolved.stdout.write(
                `OpenCode: ${openCode.healthy ? 'healthy' : `unhealthy (${concise(openCode.detail ?? 'connection failed')})`}\n`,
            );
        }
        return healthy;
    } finally {
        await initialized?.control.close();
    }
};

const executeServe = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'serve' }>,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    if (parsed.programFileIdentity) {
        const currentIdentity = await resolved.readProgramFileIdentity([
            resolved.executablePath,
            resolved.cliPath,
            ...(parsed.managedOpenCodePath ? [parsed.managedOpenCodePath] : []),
        ]);
        if (currentIdentity !== parsed.programFileIdentity) {
            throw new Error(
                'Managed service program files changed after unit verification.',
            );
        }
    }
    const initialized = await resolved.initWorkspaceControl(parsed.workspace);
    const workspace = initialized.workspace;
    await initialized.control.close();
    let managedOpenCode: ManagedOpenCodeServer | undefined;
    const daemonController = new AbortController();
    try {
        if (parsed.managedOpenCodePath) {
            managedOpenCode = await resolved.startManagedOpenCodeServer({
                executablePath: parsed.managedOpenCodePath,
                workspace,
                writeOutput: value => resolved.stderr.write(value),
            });
        }
        const openCodeUrl = managedOpenCode?.url ?? parsed.openCodeUrl;
        const adapter: OpenCodeSessionAdapter =
            await resolved.createOpenCodeAdapter({
                baseUrl: openCodeUrl,
                directory: workspace,
            });
        if (parsed.json) {
            printJson(resolved.stdout, {
                command: 'serve',
                workspace,
                openCodeUrl,
                managedOpenCode: Boolean(managedOpenCode),
                status: 'starting',
            });
        } else {
            resolved.stdout.write(
                `Serving ${workspace} via ${managedOpenCode ? 'managed ' : ''}OpenCode ${openCodeUrl}.\n`,
            );
        }
        const daemon = resolved.runGoalDaemon({
            workspace,
            adapter,
            globalConcurrency: parsed.globalConcurrency,
            workspaceConcurrency: parsed.workspaceConcurrency,
            dispatchIntervalMs: parsed.dispatchIntervalMs,
            reconciliationIntervalMs: parsed.reconciliationIntervalMs,
            cancellationIntervalMs: parsed.cancellationIntervalMs,
            observationRestartIntervalMs: parsed.observationRestartIntervalMs,
            signal: daemonController.signal,
            ...(parsed.serviceIdentity
                ? { serviceIdentity: parsed.serviceIdentity }
                : {}),
            onError: error => resolved.stderr.write(`${errorMessage(error)}\n`),
        });
        if (!managedOpenCode) {
            await daemon;
            return;
        }
        const completed = await Promise.race([
            daemon.then(() => ({ source: 'daemon' as const })),
            managedOpenCode.exited.then(exit => ({
                source: 'opencode' as const,
                exit,
            })),
        ]);
        if (completed.source === 'opencode') {
            daemonController.abort('managed OpenCode server exited');
            await daemon;
            if (completed.exit.error) throw completed.exit.error;
            throw new Error(
                `Managed OpenCode server exited unexpectedly (${completed.exit.code ?? completed.exit.signal ?? 'unknown'}).`,
            );
        }
    } finally {
        daemonController.abort('serve command finished');
        await managedOpenCode?.close();
    }
};

const executeMcp = async (
    parsed: Extract<ParsedCliArguments, { readonly command: 'mcp' }>,
    resolved: ResolvedCliDependencies,
): Promise<void> => {
    const initialized = await resolved.initWorkspaceControl(parsed.workspace);
    try {
        await resolved.runGoalMcp(initialized.control, auth(initialized));
    } finally {
        await initialized.control.close();
    }
};

export const runCli = async (
    arguments_: readonly string[] = process.argv.slice(2),
    inputDependencies: CliDependencies = {},
): Promise<number> => {
    const resolved = dependencies(inputDependencies);
    if (arguments_[0] === TUI_BRIDGE_COMMAND) {
        return runTuiBridge(arguments_.slice(1), resolved);
    }
    try {
        const parsed = parseCliArguments(arguments_, resolved.cwd());
        if (parsed.command === 'plan') {
            const plan = await parsePlanFile(parsed, resolved);
            await executePlan(parsed, plan, resolved);
        } else if (parsed.command === 'init') {
            await executeInit(parsed, resolved);
        } else if (parsed.command === 'serve') {
            await executeServe(parsed, resolved);
        } else if (parsed.command === 'status') {
            await executeStatus(parsed, resolved);
        } else if (
            parsed.command === 'start' ||
            parsed.command === 'pause' ||
            parsed.command === 'resume' ||
            parsed.command === 'cancel' ||
            parsed.command === 'recover'
        ) {
            await executeGoalMutation(parsed, resolved);
        } else if (parsed.command === 'approve') {
            await executeApprove(parsed, resolved);
        } else if (parsed.command === 'doctor') {
            return (await executeDoctor(parsed, resolved)) ? 0 : 1;
        } else {
            await executeMcp(parsed, resolved);
        }
        return 0;
    } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        return 1;
    }
};

const isEntryPoint = process.argv[1]
    ? await realpath(process.argv[1])
          .then(path => path === fileURLToPath(import.meta.url))
          .catch(() => false)
    : false;
if (isEntryPoint) {
    process.exitCode = await runCli();
}
