import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdtempSync,
    mkdirSync,
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
});
