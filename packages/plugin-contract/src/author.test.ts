import { describe, expect, test } from 'vitest';

import type { PluginFactory } from './author';

describe('plugin author contract', () => {
    test('types the v1 trusted-ESM factory surface', async () => {
        const plugin: PluginFactory = ({ directory, log }) => ({
            commands: {
                'com.example.hello.run': (input, { repoId }) => ({
                    directory,
                    input,
                    repoId,
                }),
            },
            commandExecuted: command => log('info', command),
        });

        const hooks = await plugin({
            directory: '/plugin',
            log: () => undefined,
        });
        const result = await hooks.commands?.['com.example.hello.run']?.(
            'input',
            { repoId: 'repo' },
        );

        expect(result).toEqual({
            directory: '/plugin',
            input: 'input',
            repoId: 'repo',
        });
    });
});
