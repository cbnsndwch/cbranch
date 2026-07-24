import { describe, expect, test, vi } from 'vitest';

import { makeGitCredentialStore } from './plugin-credentials';

describe('Git plugin credentials', () => {
    test('uses Git credential operations keyed to the registry HTTPS origin', async () => {
        const run = vi
            .fn()
            .mockResolvedValueOnce('username=token\npassword=from-git\n\n')
            .mockResolvedValue('');
        const store = makeGitCredentialStore(run);

        await expect(
            store.get('https://registry.example.test/plugins/catalog'),
        ).resolves.toBe('from-git');
        await store.replace(
            'https://registry.example.test/plugins/catalog',
            'user-token',
        );
        await store.reject(
            'https://registry.example.test/plugins/catalog',
            'user-token',
        );

        expect(run).toHaveBeenNthCalledWith(
            1,
            'fill',
            'protocol=https\nhost=registry.example.test\nusername=cbranch-plugin-registry\n\n',
        );
        expect(run).toHaveBeenNthCalledWith(
            2,
            'approve',
            'protocol=https\nhost=registry.example.test\nusername=cbranch-plugin-registry\npassword=user-token\n\n',
        );
        expect(run).toHaveBeenNthCalledWith(
            3,
            'reject',
            'protocol=https\nhost=registry.example.test\nusername=cbranch-plugin-registry\npassword=user-token\n\n',
        );
    });

    test('does not accept a credential URL with embedded authentication', async () => {
        const store = makeGitCredentialStore(vi.fn());

        await expect(
            store.get('https://token@registry.example.test/catalog'),
        ).rejects.toThrow('clean HTTPS');
    });

    test('does not allow a token to add fields to Git credential input', async () => {
        const store = makeGitCredentialStore(vi.fn());

        await expect(
            store.replace(
                'https://registry.example.test',
                'token\nurl=https://evil',
            ),
        ).rejects.toThrow('control characters');
    });
});
