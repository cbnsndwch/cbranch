import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
    chmod,
    lstat,
    mkdir,
    open,
    readFile,
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

export type SystemdServiceIdentity = `sha256:${string}`;

/** Identity of the exact service configuration expected to publish readiness. */
export const systemdServiceIdentity = (
    options: GenerateSystemdUserServiceOptions,
): SystemdServiceIdentity => {
    const input = JSON.stringify({
        cliPath: absolutePath(options.cliPath, 'CLI path'),
        executablePath: absolutePath(options.executablePath, 'Executable path'),
        openCodeUrl: openCodeUrl(options.openCodeUrl),
        restartSec: positiveInteger(
            options.restartSec ?? 5,
            'RestartSec',
            3_600,
        ),
        serviceConfigurationVersion: 1,
        workspace: absolutePath(options.workspace, 'Workspace path'),
    });
    return `sha256:${createHash('sha256').update(input).digest('hex')}`;
};

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
    const serviceIdentity = systemdServiceIdentity(options);
    const command = [
        executable,
        cli,
        'serve',
        '--workspace',
        workspace,
        '--opencode-url',
        url,
        '--internal-service-identity',
        serviceIdentity,
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
    readonly changed: boolean;
    readonly serviceIdentity: SystemdServiceIdentity;
    readonly lifecycleCommands: SystemdLifecycleCommands;
}

export const defaultSystemdUserDirectory = (): string => {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const configHome =
        xdgConfigHome &&
        isAbsolute(xdgConfigHome) &&
        !hasControlCharacters(xdgConfigHome)
            ? resolve(xdgConfigHome)
            : join(homedir(), '.config');
    return join(configHome, 'systemd', 'user');
};

const validateInstalledUnit = (info: Stats): void => {
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) ||
        (process.platform !== 'win32' &&
            typeof process.getuid === 'function' &&
            info.uid !== process.getuid())
    ) {
        throw new Error(
            'Installed systemd unit must be an owner-only regular file.',
        );
    }
};

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
    const serviceIdentity = systemdServiceIdentity(options);

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
    if (process.platform !== 'win32' && (directoryInfo.mode & 0o022) !== 0) {
        throw new Error(
            'Systemd user unit directory may not be writable by group or other users.',
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
    try {
        const destinationInfo = await lstat(destination);
        validateInstalledUnit(destinationInfo);
        if ((await readFile(destination, 'utf8')) === content) {
            return {
                unitPath: destination,
                unitName: name,
                changed: false,
                serviceIdentity,
                lifecycleCommands: systemdLifecycleCommands(name),
            };
        }
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
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
        validateInstalledUnit(destinationInfo);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }

    return {
        unitPath: destination,
        unitName: name,
        changed: true,
        serviceIdentity,
        lifecycleCommands: systemdLifecycleCommands(name),
    };
};

export type DaemonServiceStatus =
    | { readonly status: 'stopped'; readonly lockPath: string }
    | {
          readonly status: 'running' | 'stale';
          readonly lockPath: string;
          readonly pid: number;
          readonly token: string;
          readonly workspace: string;
          readonly createdAt: string;
          readonly ready: boolean;
          readonly serviceIdentity?: SystemdServiceIdentity;
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

const inspectReadiness = async (
    lockPath: string,
    token: string,
    ownerServiceIdentity?: SystemdServiceIdentity,
): Promise<{
    readonly ready: boolean;
    readonly serviceIdentity?: SystemdServiceIdentity;
}> => {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
        handle = await open(
            `${lockPath}.ready`,
            constants.O_RDONLY |
                constants.O_NONBLOCK |
                (constants.O_NOFOLLOW ?? 0),
        );
    } catch {
        return { ready: false };
    }
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size <= 0 || info.size > 4_096) {
            return { ready: false };
        }
        const value = JSON.parse(
            await handle.readFile({ encoding: 'utf8' }),
        ) as Record<string, unknown>;
        const ready =
            value.token === token &&
            typeof value.readyAt === 'string' &&
            !Number.isNaN(Date.parse(value.readyAt)) &&
            value.serviceIdentity === ownerServiceIdentity;
        if (!ready) return { ready: false };
        return {
            ready: true,
            ...(typeof value.serviceIdentity === 'string'
                ? {
                      serviceIdentity:
                          value.serviceIdentity as SystemdServiceIdentity,
                  }
                : {}),
        };
    } catch {
        return { ready: false };
    } finally {
        await handle.close();
    }
};

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
            Number.isNaN(Date.parse(record.createdAt)) ||
            (record.serviceIdentity !== undefined &&
                (typeof record.serviceIdentity !== 'string' ||
                    !/^sha256:[a-f0-9]{64}$/u.test(record.serviceIdentity)))
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
        const alive = (options.isPidAlive ?? pidIsAlive)(pid);
        const serviceIdentity = record.serviceIdentity as
            | SystemdServiceIdentity
            | undefined;
        const readiness = alive
            ? await inspectReadiness(lockPath, record.token, serviceIdentity)
            : { ready: false as const };
        return {
            status: alive ? 'running' : 'stale',
            lockPath,
            pid,
            token: record.token,
            workspace: ownerWorkspace,
            createdAt: record.createdAt,
            ready: readiness.ready,
            ...(serviceIdentity ? { serviceIdentity } : {}),
        };
    } catch {
        return invalidLock(lockPath, 'Daemon lock could not be read safely.');
    } finally {
        await handle.close();
    }
};
