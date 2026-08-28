import { randomUUID } from 'node:crypto';
import {
    access,
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ProcessIdentity } from './process-identity.js';

import {
    defaultSystemdUserDirectory,
    escapeSystemdPathDirective,
    generateSystemdUserService,
    inspectDaemonServiceStatus,
    quoteSystemdArgument,
    systemdServiceIdentity,
    writeSystemdUserService,
} from './systemd.js';

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), 'goal-systemd-'));
    directories.push(directory);
    return directory;
};

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
        directories
            .splice(0)
            .map(directory => rm(directory, { recursive: true, force: true })),
    );
});

describe('systemd unit generation', () => {
    test('quotes spaces, percent specifiers, dollars, and hardened settings', () => {
        const unit = generateSystemdUserService({
            executablePath: '/opt/Node Runtime/node',
            cliPath: '/opt/cbranch%N/$release/cli.js',
            workspace: '/home/operator/work trees/goal%W',
            openCodeUrl: 'http://127.0.0.1:4096/api%2Fv1',
            restartSec: 7,
        });

        expect(unit).toContain(
            'ExecStart="/opt/Node Runtime/node" "/opt/cbranch%%N/$$release/cli.js" "serve"',
        );
        expect(unit).toContain('goal%%W');
        expect(unit).toContain('api%%2Fv1');
        expect(unit).toContain('Type=simple');
        expect(unit).toContain('Restart=on-failure');
        expect(unit).toContain('RestartSec=7s');
        expect(unit).toContain('UMask=0077');
        expect(unit).toContain('NoNewPrivileges=true');
        expect(unit).toContain('PrivateTmp=true');
        expect(unit).toContain('ProtectSystem=strict');
        expect(unit).toContain(
            'WorkingDirectory=/home/operator/work\\x20trees/goal%%W',
        );
        expect(unit).toContain(
            'ReadWritePaths=/home/operator/work\\x20trees/goal%%W',
        );
        expect(unit).toContain('Environment="PATH=');
        expect(unit).toContain(
            'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
        );
        expect(unit).toContain('WantedBy=default.target');
        const identity = systemdServiceIdentity({
            executablePath: '/opt/Node Runtime/node',
            cliPath: '/opt/cbranch%N/$release/cli.js',
            workspace: '/home/operator/work trees/goal%W',
            openCodeUrl: 'http://127.0.0.1:4096/api%2Fv1',
            restartSec: 7,
        });
        expect(unit).toContain(`"--internal-service-identity" "${identity}"`);
        expect(unit).not.toContain('systemctl');
    });

    test('derives deterministic normalized service identities', () => {
        const input = {
            executablePath: '/usr/bin/node',
            cliPath: '/opt/cbranch/cli.js',
            workspace: '/home/operator/project',
            openCodeUrl: 'http://127.0.0.1:4096',
        };
        expect(systemdServiceIdentity(input)).toBe(
            systemdServiceIdentity({
                ...input,
                openCodeUrl: 'http://127.0.0.1:4096/',
            }),
        );
        expect(
            systemdServiceIdentity({
                ...input,
                openCodeUrl: 'http://127.0.0.1:5000',
            }),
        ).not.toBe(systemdServiceIdentity(input));
        expect(
            systemdServiceIdentity({
                ...input,
                programFileIdentity: 'node:file-identity|cli:file-identity',
            }),
        ).not.toBe(systemdServiceIdentity(input));
    });

    test.each([
        ['/usr/bin/node\nmalicious', '/opt/cli.js', '/tmp/work'],
        ['/usr/bin/node', '/opt/cli.js\0malicious', '/tmp/work'],
        ['/usr/bin/node', '/opt/cli.js', 'relative/work'],
    ])(
        'rejects control injection and relative paths',
        (executable, cli, workspace) => {
            expect(() =>
                generateSystemdUserService({
                    executablePath: executable,
                    cliPath: cli,
                    workspace,
                    openCodeUrl: 'http://127.0.0.1:4096',
                }),
            ).toThrow();
        },
    );

    test('quotes embedded quotes and backslashes', () => {
        expect(quoteSystemdArgument('/tmp/a"b\\c')).toBe('"/tmp/a\\"b\\\\c"');
        expect(escapeSystemdPathDirective('/tmp/a"b\\c d%')).toBe(
            '/tmp/a\\x22b\\x5cc\\x20d%%',
        );
    });

    test('generates a self-contained managed OpenCode command', () => {
        vi.stubEnv('XDG_DATA_HOME', '/srv/cbranch/$data');
        vi.stubEnv('XDG_CACHE_HOME', '/srv/cbranch/cache');
        vi.stubEnv('XDG_CONFIG_HOME', '/srv/cbranch/config');
        vi.stubEnv('XDG_STATE_HOME', '/srv/cbranch/state');
        const unit = generateSystemdUserService({
            executablePath: '/usr/bin/node',
            cliPath: '/opt/cbranch/cli.js',
            workspace: '/home/operator/project',
            openCodeUrl: 'http://opencode.internal/',
            managedOpenCodePath: '/home/operator/.opencode/bin/opencode',
            programFileIdentity: 'node:file|cli:file|opencode:file',
        });
        expect(unit).toContain(
            '"--internal-managed-opencode" "/home/operator/.opencode/bin/opencode"',
        );
        expect(unit).not.toContain('"--opencode-url"');
        expect(unit).toContain(
            '"--internal-program-file-identity" "node:file|cli:file|opencode:file"',
        );
        expect(unit).toContain('ReadWritePaths=-');
        expect(unit).toContain('/srv/cbranch/\\x24data/opencode');
        expect(unit).toContain(
            'Environment="XDG_DATA_HOME=/srv/cbranch/$data"',
        );
        expect(unit).toContain(
            'Environment="XDG_CACHE_HOME=/srv/cbranch/cache"',
        );
        expect(unit).toContain(
            'Environment="XDG_CONFIG_HOME=/srv/cbranch/config"',
        );
        expect(unit).toContain(
            'Environment="XDG_STATE_HOME=/srv/cbranch/state"',
        );
        expect(unit).not.toContain('XDG_DATA_HOME=/srv/cbranch/$$data');
    });
});

describe('systemd unit installation', () => {
    test('creates managed OpenCode XDG directories before installation', async () => {
        const root = await temporaryDirectory();
        const userDirectory = join(root, 'systemd', 'user');
        const xdgDirectories = {
            XDG_CONFIG_HOME: join(root, 'config'),
            XDG_DATA_HOME: join(root, 'data'),
            XDG_CACHE_HOME: join(root, 'cache'),
            XDG_STATE_HOME: join(root, 'state'),
        };
        for (const [name, value] of Object.entries(xdgDirectories)) {
            vi.stubEnv(name, value);
        }

        await writeSystemdUserService({
            executablePath: '/usr/bin/node',
            cliPath: '/opt/cbranch/cli.js',
            workspace: root,
            openCodeUrl: 'http://opencode.internal/',
            managedOpenCodePath: '/opt/opencode',
            systemdUserDirectory: userDirectory,
            unitPath: join(userDirectory, 'cbranch-goal-supervisor.service'),
        });

        await Promise.all(
            Object.values(xdgDirectories).map(async directory => {
                const info = await lstat(join(directory, 'opencode'));
                expect(info.isDirectory()).toBe(true);
                if (process.platform !== 'win32') {
                    expect(info.mode & 0o777).toBe(0o700);
                }
            }),
        );
    });

    test('atomically writes owner-only files and returns operator commands', async () => {
        const root = await temporaryDirectory();
        const userDirectory = join(root, '.config', 'systemd', 'user');
        const unitPath = join(userDirectory, 'cbranch-goal-supervisor.service');

        const result = await writeSystemdUserService({
            executablePath: '/usr/bin/node',
            cliPath: '/opt/cbranch/cli.js',
            workspace: '/home/operator/project',
            openCodeUrl: 'http://127.0.0.1:4096',
            systemdUserDirectory: userDirectory,
            unitPath,
        });

        expect(result.unitPath).toBe(unitPath);
        expect(result.changed).toBe(true);
        expect(result.serviceIdentity).toBe(
            systemdServiceIdentity({
                executablePath: '/usr/bin/node',
                cliPath: '/opt/cbranch/cli.js',
                workspace: '/home/operator/project',
                openCodeUrl: 'http://127.0.0.1:4096',
            }),
        );
        expect((await lstat(userDirectory)).mode & 0o777).toBe(0o700);
        expect((await lstat(unitPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(unitPath, 'utf8')).toContain('ExecStart=');
        expect(result.lifecycleCommands).toEqual({
            daemonReload: 'systemctl --user daemon-reload',
            enable: 'systemctl --user enable cbranch-goal-supervisor.service',
            start: 'systemctl --user start cbranch-goal-supervisor.service',
            status: 'systemctl --user status cbranch-goal-supervisor.service',
            stop: 'systemctl --user stop cbranch-goal-supervisor.service',
            disable: 'systemctl --user disable cbranch-goal-supervisor.service',
        });

        const installed = await lstat(unitPath);
        const repeated = await writeSystemdUserService({
            executablePath: '/usr/bin/node',
            cliPath: '/opt/cbranch/cli.js',
            workspace: '/home/operator/project',
            openCodeUrl: 'http://127.0.0.1:4096',
            systemdUserDirectory: userDirectory,
            unitPath,
        });
        expect(repeated.changed).toBe(false);
        expect((await lstat(unitPath)).ino).toBe(installed.ino);
    });

    test('uses only an absolute XDG_CONFIG_HOME for the default directory', () => {
        vi.stubEnv('XDG_CONFIG_HOME', '/tmp/cbranch-xdg');
        expect(defaultSystemdUserDirectory()).toBe(
            '/tmp/cbranch-xdg/systemd/user',
        );

        vi.stubEnv('XDG_CONFIG_HOME', 'relative/config');
        expect(defaultSystemdUserDirectory()).not.toContain('relative/config');
    });

    test.runIf(process.platform !== 'win32')(
        'accepts a standard owner-controlled 0755 user unit directory',
        async () => {
            const root = await temporaryDirectory();
            const userDirectory = join(root, 'units');
            await mkdir(userDirectory, { mode: 0o755 });
            await chmod(userDirectory, 0o755);

            await expect(
                writeSystemdUserService({
                    executablePath: '/usr/bin/node',
                    cliPath: '/opt/cbranch/cli.js',
                    workspace: '/home/operator/project',
                    openCodeUrl: 'http://127.0.0.1:4096',
                    systemdUserDirectory: userDirectory,
                    unitPath: join(
                        userDirectory,
                        'cbranch-goal-supervisor.service',
                    ),
                }),
            ).resolves.toMatchObject({
                unitPath: join(
                    userDirectory,
                    'cbranch-goal-supervisor.service',
                ),
            });
        },
    );

    test('rejects destinations outside the explicit user unit directory', async () => {
        const root = await temporaryDirectory();
        await expect(
            writeSystemdUserService({
                executablePath: '/usr/bin/node',
                cliPath: '/opt/cbranch/cli.js',
                workspace: '/home/operator/project',
                openCodeUrl: 'http://127.0.0.1:4096',
                systemdUserDirectory: join(root, 'units'),
                unitPath: join(root, 'outside.service'),
            }),
        ).rejects.toThrow('direct child');
        await expect(
            access(join(root, 'outside.service')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('rejects a unit nested below the configured directory', async () => {
        const root = await temporaryDirectory();
        const userDirectory = join(root, 'units');
        await expect(
            writeSystemdUserService({
                executablePath: '/usr/bin/node',
                cliPath: '/opt/cbranch/cli.js',
                workspace: '/home/operator/project',
                openCodeUrl: 'http://127.0.0.1:4096',
                systemdUserDirectory: userDirectory,
                unitPath: join(
                    userDirectory,
                    'nested',
                    'cbranch-goal-supervisor.service',
                ),
            }),
        ).rejects.toThrow('direct child');
        await expect(access(userDirectory)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    test.runIf(process.platform !== 'win32')(
        'rejects a group-writable user unit directory',
        async () => {
            const root = await temporaryDirectory();
            const userDirectory = join(root, 'units');
            await mkdir(userDirectory, { mode: 0o775 });
            await chmod(userDirectory, 0o775);

            await expect(
                writeSystemdUserService({
                    executablePath: '/usr/bin/node',
                    cliPath: '/opt/cbranch/cli.js',
                    workspace: '/home/operator/project',
                    openCodeUrl: 'http://127.0.0.1:4096',
                    systemdUserDirectory: userDirectory,
                    unitPath: join(
                        userDirectory,
                        'cbranch-goal-supervisor.service',
                    ),
                }),
            ).rejects.toThrow('writable by group or other users');
            expect((await lstat(userDirectory)).mode & 0o777).toBe(0o775);
        },
    );

    test.runIf(process.platform !== 'win32')(
        'rejects a symbolic-link user unit directory',
        async () => {
            const root = await temporaryDirectory();
            const realDirectory = join(root, 'real-units');
            const userDirectory = join(root, 'units');
            await mkdir(realDirectory, { mode: 0o700 });
            await symlink(realDirectory, userDirectory);

            await expect(
                writeSystemdUserService({
                    executablePath: '/usr/bin/node',
                    cliPath: '/opt/cbranch/cli.js',
                    workspace: '/home/operator/project',
                    openCodeUrl: 'http://127.0.0.1:4096',
                    systemdUserDirectory: userDirectory,
                    unitPath: join(
                        userDirectory,
                        'cbranch-goal-supervisor.service',
                    ),
                }),
            ).rejects.toThrow('real directory');
            await expect(
                access(join(realDirectory, 'cbranch-goal-supervisor.service')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        },
    );
});

describe('daemon service status', () => {
    const ownerProcessIdentity =
        'linux:00000000-0000-4000-8000-000000000000:1' as ProcessIdentity;
    test('fails closed for identity-less legacy ownership records', async () => {
        const root = await temporaryDirectory();
        const lockPath = join(root, 'daemon.lock');
        const owner = {
            pid: process.pid,
            token: randomUUID(),
            workspace: root,
            createdAt: new Date().toISOString(),
        };
        await writeFile(lockPath, `${JSON.stringify(owner)}\n`);
        await writeFile(
            `${lockPath}.ready`,
            `${JSON.stringify({
                pid: owner.pid,
                workspace: owner.workspace,
                token: owner.token,
                readyAt: new Date().toISOString(),
            })}\n`,
        );

        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
            }),
        ).resolves.toMatchObject({ status: 'invalid' });
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => false,
            }),
        ).resolves.toMatchObject({ status: 'stale', ready: false });
    });

    test('does not mistake a reused PID for a ready daemon owner', async () => {
        const root = await temporaryDirectory();
        const lockPath = join(root, 'daemon.lock');
        const owner = {
            pid: process.pid,
            processIdentity: ownerProcessIdentity,
            token: randomUUID(),
            workspace: root,
            createdAt: new Date().toISOString(),
        };
        await writeFile(lockPath, `${JSON.stringify(owner)}\n`);
        await writeFile(
            `${lockPath}.ready`,
            `${JSON.stringify({
                token: owner.token,
                processIdentity: owner.processIdentity,
                readyAt: new Date().toISOString(),
            })}\n`,
        );

        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
                processIdentity: () =>
                    'linux:00000000-0000-4000-8000-000000000000:2' as ProcessIdentity,
            }),
        ).resolves.toMatchObject({ status: 'stale', ready: false });
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
                processIdentity: () => undefined,
            }),
        ).resolves.toMatchObject({ status: 'invalid' });
    });

    test('reports stopped, running, stale, and invalid without deleting locks', async () => {
        const root = await temporaryDirectory();
        const lockPath = join(root, 'daemon.lock');

        await expect(
            inspectDaemonServiceStatus(lockPath, { workspace: root }),
        ).resolves.toEqual({ status: 'stopped', lockPath });

        await writeFile(`${lockPath}.recovery`, 'interrupted recovery', {
            mode: 0o600,
        });
        await expect(
            inspectDaemonServiceStatus(lockPath, { workspace: root }),
        ).resolves.toMatchObject({
            status: 'invalid',
            detail: expect.stringContaining('interrupted'),
        });
        await rm(`${lockPath}.recovery`);

        const ownerIdentity = `sha256:${'b'.repeat(64)}` as const;
        const owner = {
            pid: process.pid,
            processIdentity: ownerProcessIdentity,
            token: randomUUID(),
            workspace: root,
            createdAt: new Date().toISOString(),
            serviceIdentity: ownerIdentity,
        };
        await writeFile(lockPath, `${JSON.stringify(owner)}\n`, {
            mode: 0o600,
        });
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
                processIdentity: () => ownerProcessIdentity,
            }),
        ).resolves.toMatchObject({
            status: 'running',
            pid: process.pid,
            token: owner.token,
            ready: false,
            serviceIdentity: ownerIdentity,
        });
        await writeFile(
            `${lockPath}.ready`,
            `${JSON.stringify({
                pid: owner.pid,
                workspace: owner.workspace,
                token: randomUUID(),
                processIdentity: owner.processIdentity,
                readyAt: new Date().toISOString(),
            })}\n`,
        );
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
                processIdentity: () => owner.processIdentity as ProcessIdentity,
            }),
        ).resolves.toMatchObject({ status: 'running', ready: false });
        await writeFile(
            `${lockPath}.ready`,
            `${JSON.stringify({
                pid: owner.pid,
                workspace: owner.workspace,
                token: owner.token,
                processIdentity: owner.processIdentity,
                readyAt: new Date().toISOString(),
                serviceIdentity: `sha256:${'c'.repeat(64)}`,
            })}\n`,
        );
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
                processIdentity: () => owner.processIdentity as ProcessIdentity,
            }),
        ).resolves.toMatchObject({
            status: 'running',
            ready: false,
            serviceIdentity: ownerIdentity,
        });
        await writeFile(
            `${lockPath}.ready`,
            `${JSON.stringify({
                pid: owner.pid,
                workspace: owner.workspace,
                token: owner.token,
                processIdentity: owner.processIdentity,
                readyAt: new Date().toISOString(),
                serviceIdentity: ownerIdentity,
            })}\n`,
        );
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => true,
                processIdentity: () => owner.processIdentity as ProcessIdentity,
            }),
        ).resolves.toMatchObject({
            status: 'running',
            ready: true,
            serviceIdentity: ownerIdentity,
        });
        await expect(
            inspectDaemonServiceStatus(lockPath, {
                workspace: root,
                isPidAlive: () => false,
            }),
        ).resolves.toMatchObject({
            status: 'stale',
            pid: process.pid,
            ready: false,
        });
        await expect(access(lockPath)).resolves.toBeUndefined();

        await writeFile(
            lockPath,
            `${JSON.stringify({ ...owner, token: 'not-a-daemon-token' })}\n`,
        );
        await expect(
            inspectDaemonServiceStatus(lockPath, { workspace: root }),
        ).resolves.toMatchObject({ status: 'invalid' });
        await expect(access(lockPath)).resolves.toBeUndefined();
    });

    test.runIf(process.platform !== 'win32')(
        'does not follow a symbolic-link lock',
        async () => {
            const root = await temporaryDirectory();
            const target = join(root, 'target.lock');
            const lockPath = join(root, 'daemon.lock');
            await writeFile(target, '{}');
            await symlink(target, lockPath);

            await expect(
                inspectDaemonServiceStatus(lockPath, { workspace: root }),
            ).resolves.toMatchObject({ status: 'invalid' });
            expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
        },
    );
});
