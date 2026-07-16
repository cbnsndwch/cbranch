// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConnectionProfilesScreen } from './ConnectionProfilesScreen';
import {
    listenForSshAuthChallenge,
    loadDesktopBridge,
    probeCbranchServer,
} from './bridge';

vi.mock('./bridge', () => ({
    loadDesktopBridge: vi.fn(),
    listenForSshAuthChallenge: vi.fn(),
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
    saveProfile: vi.fn(async () => profile),
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
    afterEach(cleanup);

    beforeEach(() => {
        vi.mocked(loadDesktopBridge).mockResolvedValue(bridge);
        vi.mocked(listenForSshAuthChallenge).mockResolvedValue(() => undefined);
        vi.mocked(probeCbranchServer)
            .mockResolvedValueOnce({ status: 'missing' })
            .mockResolvedValueOnce({ status: 'ready' });
        bridge.listProfiles.mockClear();
        bridge.saveProfile.mockClear();
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

    test('offers an update for a healthy but older managed server', async () => {
        vi.mocked(probeCbranchServer)
            .mockReset()
            .mockResolvedValueOnce({
                status: 'incompatible',
                protocolVersion: 1,
                version: '0.1.2',
            })
            .mockResolvedValueOnce({ status: 'ready' });
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
                name: 'cbranch server needs an update',
            }),
        ).toBeTruthy();
        expect(screen.getByText(/Server v0.1.2 is older/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Update cbranch' }));

        await waitFor(() => {
            expect(bridge.setupProfile).toHaveBeenCalledWith(profile.id);
            expect(onConnect).toHaveBeenCalled();
        });
    });

    test('clones a selected profile into a new canary-port profile', async () => {
        render(
            <ConnectionProfilesScreen onConnect={vi.fn()} onRetry={vi.fn()} />,
        );

        fireEvent.click(
            await screen.findByRole('button', { name: /Clerk VM/ }),
        );
        fireEvent.click(
            screen.getByRole('button', { name: 'Clone profile for canary' }),
        );

        expect(
            screen.getByRole('heading', { name: 'New connection' }),
        ).toBeTruthy();
        expect(
            (screen.getByLabelText('Profile name') as HTMLInputElement).value,
        ).toBe('Clerk VM Canary');
        expect(
            (screen.getByLabelText('Remote cbranch port') as HTMLInputElement)
                .value,
        ).toBe('7421');
        fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
        await waitFor(() =>
            expect(bridge.saveProfile).toHaveBeenCalledWith({
                name: 'Clerk VM Canary',
                host: 'clerk',
                user: 'ubuntu',
                sshPort: 22,
                remotePort: 7421,
            }),
        );
    });

    test('keeps profile management in header icon controls', async () => {
        render(
            <ConnectionProfilesScreen onConnect={vi.fn()} onRetry={vi.fn()} />,
        );

        fireEvent.click(
            await screen.findByRole('button', { name: /Clerk VM/ }),
        );

        expect(
            screen.getByRole('button', { name: 'Save profile' }),
        ).toBeTruthy();
        expect(
            screen.getByRole('button', { name: 'Delete profile' }),
        ).toBeTruthy();
        expect(
            screen.getByRole('button', { name: 'About and diagnostics' }),
        ).toBeTruthy();
        expect(
            screen.getByRole('button', { name: 'Test tunnel' }),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
    });

    test('shows a Tailscale browser challenge for the selected profile', async () => {
        let onChallenge:
            | ((challenge: {
                  readonly profileId: string;
                  readonly url: string;
              }) => void)
            | undefined;
        vi.mocked(listenForSshAuthChallenge).mockImplementation(
            async callback => {
                onChallenge = callback;
                return () => undefined;
            },
        );
        render(
            <ConnectionProfilesScreen onConnect={vi.fn()} onRetry={vi.fn()} />,
        );

        fireEvent.click(
            await screen.findByRole('button', { name: /Clerk VM/ }),
        );
        await waitFor(() => expect(onChallenge).toBeDefined());
        onChallenge?.({
            profileId: profile.id,
            url: 'https://login.tailscale.com/a/example',
        });

        expect(
            await screen.findByRole('heading', {
                name: 'Authenticate with Tailscale',
            }),
        ).toBeTruthy();
    });
});
