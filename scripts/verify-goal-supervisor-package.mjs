#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = '0.1.0';
const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'goal-supervisor-package-'),
);

const run = (command, arguments_, cwd = root) => {
    const result = spawnSync(command, arguments_, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
        throw new Error(
            [
                `${command} ${arguments_.join(' ')} failed.`,
                result.stdout,
                result.stderr,
            ]
                .filter(Boolean)
                .join('\n'),
        );
    }
    return result.stdout;
};

const runExpectedFailure = (command, arguments_, cwd) => {
    const result = spawnSync(command, arguments_, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status === 0) {
        throw new Error(
            `${command} ${arguments_.join(' ')} unexpectedly succeeded.`,
        );
    }
    return result;
};

try {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    run(pnpm, [
        '--filter',
        '@cbranch/opencode-goal-supervisor',
        'pack',
        '--pack-destination',
        temporaryDirectory,
    ]);
    const tarballName = readdirSync(temporaryDirectory).find(name =>
        name.endsWith('.tgz'),
    );
    if (!tarballName) throw new Error('pnpm pack did not create a tarball.');
    const tarball = join(temporaryDirectory, tarballName);
    run('tar', ['-xzf', tarball, '-C', temporaryDirectory]);
    const packageDirectory = join(temporaryDirectory, 'package');
    const packageJson = JSON.parse(
        readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
    );
    const requiredFiles = [
        'dist/index.js',
        'dist/index.d.ts',
        'dist/cli.js',
        'dist/opencode.js',
        'dist/opencode.d.ts',
        'dist/mcp.js',
        'dist/mcp.d.ts',
        'dist/daemon.js',
        'dist/daemon.d.ts',
        'dist/tui.js',
        'dist/tui.d.ts',
        'dist/tui-daemon.js',
        'dist/tui-daemon.d.ts',
        'dist/tui-protocol.js',
        'dist/tui-protocol.d.ts',
        'dist/opencode-adapter.js',
        'dist/opencode-adapter.d.ts',
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
    ];
    for (const file of requiredFiles) statSync(join(packageDirectory, file));

    const tuiImportClosure = new Set();
    const visitTuiImport = file => {
        const path = join(packageDirectory, 'dist', file);
        if (tuiImportClosure.has(file)) return;
        tuiImportClosure.add(file);
        const source = readFileSync(path, 'utf8');
        if (source.includes('better-sqlite3')) {
            throw new Error(
                `Packed TUI import closure references better-sqlite3 from ${file}.`,
            );
        }
        const imports = source.matchAll(
            /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu,
        );
        for (const match of imports) {
            const specifier = match[1];
            if (specifier === 'better-sqlite3') {
                throw new Error(
                    `Packed TUI import closure imports better-sqlite3 from ${file}.`,
                );
            }
            if (!specifier?.startsWith('.')) continue;
            if (!specifier?.endsWith('.js')) continue;
            visitTuiImport(
                resolve(dirname(path), specifier).slice(
                    join(packageDirectory, 'dist').length + 1,
                ),
            );
        }
    };
    visitTuiImport('tui.js');
    for (const forbidden of ['control.js', 'store.js', 'cli.js', 'index.js']) {
        if (tuiImportClosure.has(forbidden)) {
            throw new Error(
                `Packed TUI import closure reaches forbidden ${forbidden}.`,
            );
        }
    }
    if ((statSync(join(packageDirectory, 'dist/cli.js')).mode & 0o111) === 0) {
        throw new Error('Packed CLI is not executable.');
    }
    if (packageJson.bin?.['cbranch-goal-supervisor'] !== './dist/cli.js') {
        throw new Error('Packed CLI bin entry is invalid.');
    }
    if (packageJson.version !== expectedVersion) {
        throw new Error(
            `Packed version ${packageJson.version} does not match ${expectedVersion}.`,
        );
    }
    if (packageJson.engines?.node !== '>=20') {
        throw new Error('Packed Node.js compatibility declaration is invalid.');
    }
    if (packageJson.dependencies?.['@opencode-ai/sdk'] !== '1.17.18') {
        throw new Error('Packed OpenCode SDK compatibility pin is invalid.');
    }
    if (
        packageJson.peerDependencies?.['@opencode-ai/plugin'] !==
        '>=1.17.18 <1.18.0'
    ) {
        throw new Error(
            'Packed OpenCode plugin compatibility range is invalid.',
        );
    }

    const consumerDirectory = join(temporaryDirectory, 'consumer');
    mkdirSync(consumerDirectory, { mode: 0o700 });
    writeFileSync(
        join(consumerDirectory, 'package.json'),
        `${JSON.stringify(
            {
                name: 'goal-supervisor-package-consumer',
                private: true,
                type: 'module',
                dependencies: {
                    '@cbranch/opencode-goal-supervisor': `file:${tarball}`,
                    '@opencode-ai/plugin': '1.17.18',
                },
            },
            null,
            2,
        )}\n`,
    );
    writeFileSync(
        join(consumerDirectory, 'pnpm-workspace.yaml'),
        `packages:
  - .

onlyBuiltDependencies:
  - better-sqlite3
  - msgpackr-extract

allowBuilds:
  better-sqlite3: true
  msgpackr-extract: true
`,
    );
    const storePath = run(pnpm, ['store', 'path']).trim();
    try {
        run(
            pnpm,
            ['install', '--offline', '--store-dir', storePath],
            consumerDirectory,
        );
    } catch (error) {
        if (!String(error).includes('ERR_PNPM_NO_OFFLINE_TARBALL')) {
            throw error;
        }
        run(
            pnpm,
            ['install', '--prefer-offline', '--store-dir', storePath],
            consumerDirectory,
        );
    }
    writeFileSync(
        join(consumerDirectory, 'verify.mjs'),
        `const root = await import('@cbranch/opencode-goal-supervisor');
const plugin = await import('@cbranch/opencode-goal-supervisor/opencode');
const mcp = await import('@cbranch/opencode-goal-supervisor/mcp');
const daemon = await import('@cbranch/opencode-goal-supervisor/daemon');
const tui = await import('@cbranch/opencode-goal-supervisor/tui');
const tuiDaemon = await import('@cbranch/opencode-goal-supervisor/tui-daemon');
const adapter = await import('@cbranch/opencode-goal-supervisor/opencode-adapter');

for (const name of [
    'GoalStore',
    'GoalSupervisor',
    'GoalControlService',
    'runGoalDaemon',
    'createOpenCodeAdapter',
]) {
    if (!(name in root)) throw new Error('Packed root export ' + name + ' is missing.');
}
if (typeof plugin.default !== 'function') throw new Error('Invalid OpenCode plugin export.');
if (typeof mcp.runGoalMcp !== 'function') throw new Error('Invalid MCP export.');
if (mcp.GOAL_SUPERVISOR_VERSION !== ${JSON.stringify(expectedVersion)}) {
    throw new Error('MCP version does not match the packed package version.');
}
if (root.GOAL_SUPERVISOR_VERSION !== mcp.GOAL_SUPERVISOR_VERSION) {
    throw new Error('Root and MCP versions do not match.');
}
if (typeof daemon.runGoalDaemon !== 'function') throw new Error('Invalid daemon export.');
if (typeof tui.default?.tui !== 'function' || typeof tui.default?.id !== 'string') {
    throw new Error('Invalid TUI-only plugin export.');
}
if (typeof tuiDaemon.createPersistentDaemonManager !== 'function') {
    throw new Error('Invalid persistent TUI daemon export.');
}
if (typeof adapter.createOpenCodeAdapter !== 'function') throw new Error('Invalid adapter export.');

const store = new root.GoalStore(':memory:');
try {
    if (!store.integrityCheck().ok) throw new Error('In-memory packed store is unhealthy.');
} finally {
    store.close();
}
`,
    );
    run(process.execPath, ['verify.mjs'], consumerDirectory);

    const bin = join(
        consumerDirectory,
        'node_modules',
        '.bin',
        process.platform === 'win32'
            ? 'cbranch-goal-supervisor.cmd'
            : 'cbranch-goal-supervisor',
    );
    const failedBin = runExpectedFailure(
        bin,
        ['not-a-command'],
        consumerDirectory,
    );
    const stderr = failedBin.stderr.trim();
    if (
        failedBin.stdout !== '' ||
        !stderr.includes('Unknown command') ||
        stderr.split(/\r?\n/u).length !== 1 ||
        stderr.length > 1_000
    ) {
        throw new Error(
            `Installed CLI failure output was not concise.\nstdout: ${failedBin.stdout}\nstderr: ${failedBin.stderr}`,
        );
    }
    process.stdout.write(
        `Verified ${basename(tarball)} in an isolated consumer (${requiredFiles.length} required files).\n`,
    );
} finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
}
