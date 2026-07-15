import {
    cpSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resource = join(
    root,
    'apps/tauri/src-tauri/resources/cbranch-server.tar.gz',
);
const force = process.argv.includes('--force');

if (existsSync(resource) && !force) process.exit(0);

const desktopPackage = JSON.parse(
    readFileSync(join(root, 'apps/tauri/package.json'), 'utf8'),
);
const staging = mkdtempSync(join(tmpdir(), 'cbranch-server-'));
const server = join(staging, 'cbranch-server');
const archive = `${resource}.next`;

const run = (command, args, env) => {
    const executable =
        process.platform === 'win32' ? `${command}.cmd` : command;
    const result = spawnSync(executable, args, {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${command} ${args.join(' ')} failed.`);
};

try {
    run('pnpm', ['-w', 'build:libs']);
    run('pnpm', ['--filter', '@cbranch/ui', 'build']);
    run('pnpm', ['--filter', '@cbranch/web-server', 'build']);
    run(
        'pnpm',
        [
            '--filter',
            '@cbranch/web-server',
            'deploy',
            '--legacy',
            '--prod',
            '--no-optional',
            server,
        ],
        { npm_config_confirm_modules_purge: 'false' },
    );
    // pnpm's legacy workspace deploy reuses the root virtual store and marks it
    // production-only. Restore the developer/CI workspace before returning.
    run('pnpm', ['install', '--frozen-lockfile'], { CI: 'true' });

    rmSync(join(server, 'public'), { force: true, recursive: true });
    cpSync(join(root, 'packages/ui/build/client'), join(server, 'public'), {
        recursive: true,
    });
    cpSync(
        join(root, 'apps/tauri/server/install.sh'),
        join(server, 'install.sh'),
    );
    writeFileSync(
        join(server, 'cbranch-server.json'),
        `${JSON.stringify({ version: desktopPackage.version })}\n`,
    );
    mkdirSync(dirname(resource), { recursive: true });
    rmSync(archive, { force: true });
    run('tar', ['-C', staging, '-czf', archive, 'cbranch-server']);
    renameSync(archive, resource);
} finally {
    rmSync(staging, { force: true, recursive: true });
    rmSync(archive, { force: true });
}
