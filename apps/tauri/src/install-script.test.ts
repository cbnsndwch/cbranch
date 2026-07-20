import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const installScript = fileURLToPath(
    new URL('../server/install.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0))
        rmSync(directory, { force: true, recursive: true });
});

function writeExecutable(path: string, contents: string) {
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
}

describe('managed server installer', () => {
    it.skipIf(process.platform !== 'linux')(
        'loads Node from the standard NVM installation',
        () => {
            const root = mkdtempSync(join(tmpdir(), 'cbranch-install-test-'));
            temporaryDirectories.push(root);
            const home = join(root, 'home');
            const bin = join(root, 'bin');
            const nodeBin = join(root, 'node-bin');
            mkdirSync(join(home, '.nvm'), { recursive: true });
            mkdirSync(bin);
            mkdirSync(nodeBin);
            writeFileSync(
                join(home, '.nvm', 'nvm.sh'),
                'PATH="$NVM_BIN:$PATH"\nexport PATH\n',
            );
            writeExecutable(join(nodeBin, 'node'), '#!/bin/sh\nexit 0\n');
            writeExecutable(
                join(bin, 'uname'),
                "#!/bin/sh\ncase \"$1\" in\n  -s) printf '%s' Linux ;;\n  -m) printf '%s' x86_64 ;;\nesac\n",
            );
            writeExecutable(join(bin, 'id'), "#!/bin/sh\nprintf '%s' 1000\n");
            writeExecutable(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n');

            const result = spawnSync(
                '/bin/sh',
                [installScript, '0.1.0', '7420'],
                {
                    encoding: 'utf8',
                    env: { HOME: home, NVM_BIN: nodeBin, PATH: bin },
                },
            );

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(
                'Managed setup requires an active systemd user service manager',
            );
        },
    );

    it.skipIf(process.platform !== 'linux')(
        'writes an unquoted systemd working directory',
        () => {
            const root = mkdtempSync(join(tmpdir(), 'cbranch-install-test-'));
            temporaryDirectories.push(root);
            const home = join(root, 'home');
            const bin = join(root, 'bin');
            const server = join(root, 'cbranch-server');
            mkdirSync(bin);
            mkdirSync(server);
            copyFileSync(installScript, join(server, 'install.sh'));
            writeFileSync(
                join(server, 'cbranch-server.json'),
                '{"version":"0.1.0"}\n',
            );
            writeExecutable(join(bin, 'node'), "#!/bin/sh\nprintf '%s' 7420\n");
            writeExecutable(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
            writeExecutable(join(bin, 'loginctl'), '#!/bin/sh\nprintf yes\n');

            const result = spawnSync(
                '/bin/sh',
                [join(server, 'install.sh'), '0.1.0', '7420'],
                {
                    encoding: 'utf8',
                    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
                },
            );

            expect(result.status).toBe(0);
            const unit = readFileSync(
                join(home, '.config', 'systemd', 'user', 'cbranch.service'),
                'utf8',
            );
            expect(unit).toContain(
                `WorkingDirectory=${join(home, '.local', 'share', 'cbranch', 'current')}`,
            );
            expect(unit).not.toContain('WorkingDirectory="');
        },
    );

    it.skipIf(process.platform !== 'linux')(
        'isolates the Canary service and state paths',
        () => {
            const root = mkdtempSync(join(tmpdir(), 'cbranch-install-test-'));
            temporaryDirectories.push(root);
            const home = join(root, 'home');
            const bin = join(root, 'bin');
            const server = join(root, 'cbranch-server');
            mkdirSync(bin);
            mkdirSync(server);
            copyFileSync(installScript, join(server, 'install.sh'));
            writeFileSync(
                join(server, 'cbranch-server.json'),
                '{"version":"0.1.0"}\n',
            );
            writeExecutable(join(bin, 'node'), "#!/bin/sh\nprintf '%s' 7421\n");
            writeExecutable(join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
            writeExecutable(join(bin, 'loginctl'), '#!/bin/sh\nprintf yes\n');

            const result = spawnSync(
                '/bin/sh',
                [join(server, 'install.sh'), '0.1.0', '7421', 'canary'],
                {
                    encoding: 'utf8',
                    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
                },
            );

            expect(result.status).toBe(0);
            const unit = readFileSync(
                join(
                    home,
                    '.config',
                    'systemd',
                    'user',
                    'cbranch-canary.service',
                ),
                'utf8',
            );
            expect(unit).toContain('Description=cbranch-canary server');
            expect(unit).toContain('Environment=CBRANCH_RELEASE_VERSION=0.1.0');
            expect(unit).toContain(
                `WorkingDirectory=${join(
                    home,
                    '.local',
                    'share',
                    'cbranch-canary',
                    'current',
                )}`,
            );
            expect(unit).toContain(
                `Environment=CBRANCH_CONFIG=${join(
                    home,
                    '.config',
                    'cbranch-canary',
                    'config.json',
                )}`,
            );
        },
    );
});
