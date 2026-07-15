import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { loadTrustedPlugin } from './trusted-plugin-host';

describe('trusted plugin host', () => {
    test('loads a reviewed local ESM plugin and exposes only the documented context', async () => {
        const directory = await mkdtemp(
            join(tmpdir(), 'cbranch-trusted-plugin-'),
        );
        const path = join(directory, 'plugin.mjs');
        await writeFile(
            path,
            'export default ({ directory, log }) => ({ commandExecuted: command => log("info", `${directory}:${command}`) });',
            'utf8',
        );
        const log = vi.fn();

        const hooks = await loadTrustedPlugin(path, {
            directory: '/workspace',
            log,
        });
        await hooks.commandExecuted?.('release');

        expect(log).toHaveBeenCalledWith('info', '/workspace:release');
    });

    test('rejects modules that do not export a plugin function', async () => {
        const directory = await mkdtemp(
            join(tmpdir(), 'cbranch-trusted-plugin-'),
        );
        const path = join(directory, 'plugin.mjs');
        await writeFile(path, 'export const value = 1;', 'utf8');

        await expect(
            loadTrustedPlugin(path, { directory: '/', log: vi.fn() }),
        ).rejects.toThrow('default plugin function');
    });
});
