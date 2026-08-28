#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const packageJson = JSON.parse(
    readFileSync(
        resolve(root, 'packages/opencode-goal-supervisor/package.json'),
        'utf8',
    ),
);
const checks = [];

const version = binary => {
    const result = spawnSync(binary, ['--version'], {
        cwd: root,
        encoding: 'utf8',
    });
    if (result.status !== 0) return undefined;
    return (result.stdout || result.stderr).trim().split(/\s+/u)[0];
};

const requireBinary = (name, environment) => {
    const binary = process.env[environment];
    if (!binary && release) {
        throw new Error(
            `${environment} is required in release mode for ${name}.`,
        );
    }
    return binary;
};

const run = (id, command, arguments_, environment = {}) => {
    const result = spawnSync(command, arguments_, {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...environment },
    });
    checks.push({
        id,
        status: result.status === 0 ? 'passed' : 'failed',
        command: [command, ...arguments_].join(' '),
    });
    if (result.status !== 0) {
        throw new Error(
            `${id} failed: ${(result.stderr || result.stdout).trim()}`,
        );
    }
};

const unavailable = (id, reason) => {
    checks.push({ id, status: 'unavailable', reason });
    throw new Error(`${id} is required but unavailable: ${reason}`);
};

let failure;
try {
    const node20 = requireBinary('Node 20', 'CBRANCH_NODE20_BIN');
    const opencode = requireBinary('OpenCode', 'CBRANCH_OPENCODE_BIN');
    const bun = requireBinary('Bun', 'CBRANCH_BUN_BIN');
    const systemd = process.env.CBRANCH_SYSTEMD_QUALIFY === '1';

    if (node20) {
        const node20Version = version(node20);
        if (!node20Version?.startsWith('v20.')) {
            throw new Error(
                `CBRANCH_NODE20_BIN must resolve to Node 20, got ${node20Version}.`,
            );
        }
        run('node20-packed-consumer', node20, [
            'scripts/verify-goal-supervisor-package.mjs',
        ]);
    } else if (release) {
        unavailable(
            'node20-packed-consumer',
            'CBRANCH_NODE20_BIN was not provided',
        );
    }

    run('development-packed-consumer', process.execPath, [
        'scripts/verify-goal-supervisor-package.mjs',
    ]);
    run('package-tests', 'pnpm', [
        '--filter',
        '@cbranch/opencode-goal-supervisor',
        'test',
    ]);
    run('package-typecheck', 'pnpm', [
        '--filter',
        '@cbranch/opencode-goal-supervisor',
        'typecheck',
    ]);
    run('package-test-typecheck', 'pnpm', [
        '--filter',
        '@cbranch/opencode-goal-supervisor',
        'typecheck:test',
    ]);

    if (opencode) {
        run(
            'real-opencode-adapter',
            'pnpm',
            [
                '--filter',
                '@cbranch/opencode-goal-supervisor',
                'test',
                '--',
                '--run',
                'src/opencode-e2e.test.ts',
            ],
            {
                CBRANCH_OPENCODE_E2E: '1',
                CBRANCH_OPENCODE_BIN: opencode,
            },
        );
    } else if (release) {
        unavailable(
            'real-opencode-adapter',
            'CBRANCH_OPENCODE_BIN was not provided',
        );
    }

    if (bun) {
        run('bun-tui-import', bun, [
            '-e',
            "const plugin = await import('./packages/opencode-goal-supervisor/dist/tui.js'); if (typeof plugin.default?.tui !== 'function') throw new Error('Invalid TUI export');",
        ]);
    } else if (release) {
        unavailable('bun-tui-import', 'CBRANCH_BUN_BIN was not provided');
    }

    if (!systemd && release) {
        unavailable(
            'systemd-user-lifecycle',
            'CBRANCH_SYSTEMD_QUALIFY=1 was not provided',
        );
    }
    if (systemd) {
        run('systemd-user-manager', 'systemctl', [
            '--user',
            'is-system-running',
        ]);
    }
    run('repository-gate', 'pnpm', ['gate']);
} catch (error) {
    failure =
        error instanceof Error
            ? error.message.replaceAll(/\s+/gu, ' ').slice(0, 500)
            : String(error);
}

const summary = {
    schemaVersion: 1,
    commit: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
    }).stdout.trim(),
    package: `${packageJson.name}@${packageJson.version}`,
    runtime: {
        node: process.version,
        node20: process.env.CBRANCH_NODE20_BIN
            ? version(process.env.CBRANCH_NODE20_BIN)
            : undefined,
        opencode: process.env.CBRANCH_OPENCODE_BIN
            ? version(process.env.CBRANCH_OPENCODE_BIN)
            : undefined,
        bun: process.env.CBRANCH_BUN_BIN
            ? version(process.env.CBRANCH_BUN_BIN)
            : undefined,
    },
    platform: `${process.platform}-${process.arch}`,
    release,
    checks,
    status: failure ? 'failed' : 'passed',
    ...(failure ? { failure } : {}),
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
process.exitCode = failure ? 1 : 0;
