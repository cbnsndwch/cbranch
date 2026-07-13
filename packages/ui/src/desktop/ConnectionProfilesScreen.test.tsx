// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ConnectionProfilesScreen } from './ConnectionProfilesScreen';
import { loadDesktopBridge, probeCbranchServer } from './bridge';

vi.mock('./bridge', () => ({
    loadDesktopBridge: vi.fn(),
    probeCbranchServer: vi.fn(),
}));

const profile = {
    id: 'profile-1',
    name: 'Clerk VM',
    host: 'clerk',
    user: 'ubuntu',
    sshPort: 22,
    remotePort: 7420,
};

const bridge = {
    listProfiles: vi.fn(async () => [profile]),
    saveProfile: vi.fn(),
    deleteProfile: vi.fn(),
    testProfile: vi.fn(),
    setupProfile: vi.fn(async () => ({
        profile: { ...profile, remotePort: 51321 },
        warning: undefined,
    })),
    connectProfile: vi.fn(async () => ({
        profileId: profile.id,
        rpcUrl: 'ws://127.0.0.1:51321/rpc',
        httpBaseUrl: 'http://127.0.0.1:51321',
    })),
    disconnect: vi.fn(async () => undefined),
    diagnosticCommand: vi.fn(),
    diagnostics: vi.fn(),
};

describe('ConnectionProfilesScreen', () => {
    beforeEach(() => {
        vi.mocked(loadDesktopBridge).mockResolvedValue(bridge);
        vi.mocked(probeCbranchServer)
            .mockResolvedValueOnce({ status: 'missing' })
            .mockResolvedValueOnce({ status: 'ready' });
        bridge.listProfiles.mockClear();
        bridge.setupProfile.mockClear();
        bridge.connectProfile.mockClear();
        bridge.disconnect.mockClear();
    });

    test('sets up a missing server and connects with its selected port', async () => {
        const onConnect = vi.fn();
        render(
            <ConnectionProfilesScreen
                onConnect={onConnect}
                onRetry={vi.fn()}
            />,
        );

        fireEvent.click(
            await screen.findByRole('button', { name: /Clerk VM/ }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

        expect(
            await screen.findByRole('heading', {
                name: 'cbranch server not found',
            }),
        ).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Set up cbranch' }));

        await waitFor(() => {
            expect(bridge.setupProfile).toHaveBeenCalledWith(profile.id);
            expect(bridge.connectProfile).toHaveBeenLastCalledWith(profile.id);
            expect(onConnect).toHaveBeenCalledWith({
                rpcUrl: 'ws://127.0.0.1:51321/rpc',
                httpBaseUrl: 'http://127.0.0.1:51321/',
            });
        });
    });
});
