import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
    chmod,
    lstat,
    mkdir,
    open,
    realpath,
    rename,
    unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const DEFAULT_SYSTEMD_UNIT_NAME =
    'cbranch-goal-supervisor.service' as const;

const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const unitNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,254}\.service$/u;

const errorCode = (error: unknown): string | undefined =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
        ? error.code
        : undefined;

const hasControlCharacters = (value: string): boolean =>
    Array.from(value).some(character => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });

const safeText = (value: string, label: string): string => {
    if (!value || hasControlCharacters(value)) {
        throw new Error(
            `${label} must be nonempty and contain no control characters.`,
        );
    }
    return value;
};

const absolutePath = (value: string, label: string): string => {
    safeText(value, label);
    if (!isAbsolute(value))
        throw new Error(`${label} must be an absolute path.`);
    return resolve(value);
};

const openCodeUrl = (value: string): string => {
    safeText(value, 'OpenCode URL');
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

/** Quote one systemd command/directive argument without invoking a shell. */
export const quoteSystemdArgument = (value: string): string => {
    safeText(value, 'systemd argument');
    return `"${value
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        .replaceAll('$', '$$$$')
        .replaceAll('%', '%%')}"`;
};

const unitName = (value: string): string => {
    if (!unitNamePattern.test(value)) {
        throw new Error('Systemd unit name must be a simple .service name.');
    }
    return value;
};

const positiveInteger = (
    value: number,
    label: string,
    maximum: number,
): number => {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
        throw new Error(
            `${label} must be an integer from 1 through ${maximum}.`,
        );
    }
    return value;
};

export interface GenerateSystemdUserServiceOptions {
    readonly executablePath: string;
    readonly cliPath: string;
    readonly workspace: string;
    readonly openCodeUrl: string;
    readonly restartSec?: number;
}

export const generateSystemdUserService = (
    options: GenerateSystemdUserServiceOptions,
): string => {
    const executable = absolutePath(options.executablePath, 'Executable path');
    const cli = absolutePath(options.cliPath, 'CLI path');
    const workspace = absolutePath(options.workspace, 'Workspace path');
    const url = openCodeUrl(options.openCodeUrl);
    const restartSec = positiveInteger(
        options.restartSec ?? 5,
        'RestartSec',
        3_600,
    );
    const command = [
        executable,
        cli,
        'serve',
        '--workspace',
        workspace,
        '--opencode-url',
        url,
    ]
        .map(quoteSystemdArgument)
        .join(' ');

    return [
        '[Unit]',
        'Description=cbranch OpenCode goal supervisor',
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${command}`,
        `WorkingDirectory=${quoteSystemdArgument(workspace)}`,
        'Restart=on-failure',
        `RestartSec=${restartSec}s`,
        'UMask=0077',
        'NoNewPrivileges=true',
        'PrivateTmp=true',
        'PrivateDevices=true',
        'ProtectSystem=strict',
        'ProtectControlGroups=true',
        'ProtectKernelModules=true',
        'ProtectKernelTunables=true',
        'RestrictNamespaces=true',
        'RestrictSUIDSGID=true',
        'LockPersonality=true',
        'CapabilityBoundingSet=',
        'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6',
        `ReadWritePaths=${quoteSystemdArgument(workspace)}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
    ].join('\n');
};

export interface SystemdLifecycleCommands {
    readonly daemonReload: string;
    readonly enable: string;
    readonly start: string;
    readonly status: string;
    readonly stop: string;
    readonly disable: string;
}

export const systemdLifecycleCommands = (
    name: string = DEFAULT_SYSTEMD_UNIT_NAME,
): SystemdLifecycleCommands => {
    const validated = unitName(name);
    return {
        daemonReload: 'systemctl --user daemon-reload',
        enable: `systemctl --user enable ${validated}`,
        start: `systemctl --user start ${validated}`,
        status: `systemctl --user status ${validated}`,
        stop: `systemctl --user stop ${validated}`,
        disable: `systemctl --user disable ${validated}`,
    };
};

export interface WriteSystemdUserServiceOptions extends GenerateSystemdUserServiceOptions {
    readonly unitPath: string;
    readonly systemdUserDirectory?: string;
}

export interface WrittenSystemdUserService {
    readonly unitPath: string;
    readonly unitName: string;
    readonly lifecycleCommands: SystemdLifecycleCommands;
}

export const defaultSystemdUserDirectory = (): string =>
    join(homedir(), '.config', 'systemd', 'user');

export const writeSystemdUserService = async (
    options: WriteSystemdUserServiceOptions,
): Promise<WrittenSystemdUserService> => {
    const configuredDirectory = absolutePath(
        options.systemdUserDirectory ?? defaultSystemdUserDirectory(),
        'Systemd user directory',
    );
    const unitPath = absolutePath(options.unitPath, 'Systemd unit path');
    if (dirname(unitPath) !== configuredDirectory) {
        throw new Error(
            'Systemd unit file must be a direct child of the user unit directory.',
        );
    }
    const name = unitName(basename(unitPath));
    const content = generateSystemdUserService(options);

    try {
        await lstat(configuredDirectory);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        await mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') {
            await chmod(configuredDirectory, 0o700);
        }
    }
    const directoryInfo = await lstat(configuredDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new Error('Systemd unit directory must be a real directory.');
    }
    if (
        process.platform !== 'win32' &&
        (directoryInfo.mode & 0o777) !== 0o700
    ) {
        throw new Error(
            'Systemd user unit directory must have owner-only permissions (0700).',
        );
    }
    if (
        process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        directoryInfo.uid !== process.getuid()
    ) {
        throw new Error(
            'Systemd user unit directory must be owned by the current user.',
        );
    }
    const realConfiguredDirectory = await realpath(configuredDirectory);
    if (realConfiguredDirectory !== configuredDirectory) {
        throw new Error(
            'Systemd user unit directory must be canonical and may not traverse symbolic links.',
        );
    }

    const temporaryPath = join(
        realConfiguredDirectory,
        `.${name}.${process.pid}.${randomUUID()}.tmp`,
    );
    const destination = join(realConfiguredDirectory, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
        handle = await open(temporaryPath, 'wx', 0o600);
        await handle.writeFile(content, { encoding: 'utf8' });
        await handle.sync();
        const temporaryInfo = await handle.stat();
        if (!temporaryInfo.isFile()) {
            throw new Error('Temporary systemd unit must be a regular file.');
        }
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, destination);
        const destinationInfo = await lstat(destination);
        if (
            !destinationInfo.isFile() ||
            destinationInfo.isSymbolicLink() ||
            (process.platform !== 'win32' &&
                (destinationInfo.mode & 0o777) !== 0o600) ||
            (process.platform !== 'win32' &&
                typeof process.getuid === 'function' &&
                destinationInfo.uid !== process.getuid())
        ) {
            throw new Error(
                'Installed systemd unit must be an owner-only regular file.',
            );
        }
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }

    return {
        unitPath: destination,
        unitName: name,
        lifecycleCommands: systemdLifecycleCommands(name),
    };
};

export type DaemonServiceStatus =
    | { readonly status: 'stopped'; readonly lockPath: string }
    | {
          readonly status: 'running' | 'stale';
          readonly lockPath: string;
          readonly pid: number;
          readonly workspace: string;
          readonly createdAt: string;
      }
    | {
          readonly status: 'invalid';
          readonly lockPath: string;
          readonly detail: string;
      };

export interface InspectDaemonServiceStatusOptions {
    readonly workspace?: string;
    readonly isPidAlive?: (pid: number) => boolean;
}

const pidIsAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return errorCode(error) !== 'ESRCH';
    }
};

const invalidLock = (
    lockPath: string,
    detail: string,
): DaemonServiceStatus => ({
    status: 'invalid',
    lockPath,
    detail,
});

/** Inspect the daemon lock without following symlinks or removing stale data. */
export const inspectDaemonServiceStatus = async (
    path: string,
    options: InspectDaemonServiceStatusOptions = {},
): Promise<DaemonServiceStatus> => {
    const lockPath = absolutePath(path, 'Daemon lock path');
    const expectedWorkspace = options.workspace
        ? absolutePath(options.workspace, 'Workspace path')
        : undefined;
    try {
        await lstat(`${lockPath}.recovery`);
        return invalidLock(
            lockPath,
            'Daemon stale-lock recovery was interrupted and requires operator inspection.',
        );
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
            return invalidLock(
                lockPath,
                'Daemon stale-lock recovery state could not be inspected safely.',
            );
        }
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        handle = await open(
            lockPath,
            constants.O_RDONLY |
                constants.O_NONBLOCK |
                (constants.O_NOFOLLOW ?? 0),
        );
    } catch (error) {
        if (errorCode(error) === 'ENOENT')
            return { status: 'stopped', lockPath };
        if (errorCode(error) === 'ELOOP') {
            return invalidLock(
                lockPath,
                'Daemon lock may not be a symbolic link.',
            );
        }
        return invalidLock(lockPath, 'Daemon lock could not be read safely.');
    }

    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size <= 0 || info.size > 16_384) {
            return invalidLock(
                lockPath,
                'Daemon lock must be a small regular file.',
            );
        }
        const text = await handle.readFile({ encoding: 'utf8' });
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            return invalidLock(lockPath, 'Daemon lock is not valid JSON.');
        }
        if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value)
        ) {
            return invalidLock(lockPath, 'Daemon lock has an invalid shape.');
        }
        const record = value as Record<string, unknown>;
        if (
            !Number.isSafeInteger(record.pid) ||
            Number(record.pid) <= 0 ||
            typeof record.token !== 'string' ||
            !uuid.test(record.token) ||
            typeof record.workspace !== 'string' ||
            !isAbsolute(record.workspace) ||
            hasControlCharacters(record.workspace) ||
            typeof record.createdAt !== 'string' ||
            Number.isNaN(Date.parse(record.createdAt))
        ) {
            return invalidLock(
                lockPath,
                'Daemon lock has an invalid owner record.',
            );
        }
        const ownerWorkspace = resolve(record.workspace);
        if (expectedWorkspace && ownerWorkspace !== expectedWorkspace) {
            return invalidLock(
                lockPath,
                'Daemon lock belongs to a different workspace.',
            );
        }
        const pid = Number(record.pid);
        return {
            status: (options.isPidAlive ?? pidIsAlive)(pid)
                ? 'running'
                : 'stale',
            lockPath,
            pid,
            workspace: ownerWorkspace,
            createdAt: record.createdAt,
        };
    } catch {
        return invalidLock(lockPath, 'Daemon lock could not be read safely.');
    } finally {
        await handle.close();
    }
};
