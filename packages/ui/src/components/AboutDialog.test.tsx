// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useUiStore } from '../state/store';

const updater = vi.hoisted(() => ({
    state: { kind: 'idle' } as { kind: string; progress?: number },
    requestDesktopUpdateCheck: vi.fn(),
    requestDesktopUpdateInstall: vi.fn(),
}));
vi.mock('../desktop/DesktopUpdater', () => ({
    requestDesktopUpdateCheck: updater.requestDesktopUpdateCheck,
    requestDesktopUpdateInstall: updater.requestDesktopUpdateInstall,
    useDesktopUpdateState: () => updater.state,
}));
vi.mock('../lib/app-info', () => ({
    APP_INFO: {
        name: 'cBranch Canary',
        version: '0.2.2-rc.9',
        isCanary: true,
    },
}));
vi.mock('../desktop/bridge', () => ({
    isDesktopSurface: () => true,
    loadDesktopBridge: async () => ({
        diagnostics: async () => ({
            desktopVersion: '0.2.0',
            profile: {
                id: 'work',
                name: 'Work server',
                host: 'git.example.test',
                user: 'serge',
                sshPort: 22,
                remotePort: 7420,
            },
            tunnelState: 'connected',
            endpoint: 'http://127.0.0.1:7420',
            recentErrors: [],
        }),
    }),
}));

import { AboutDialog } from './AboutDialog';

beforeEach(() => {
    updater.state = { kind: 'idle' };
    useUiStore.setState({
        aboutDialogOpen: true,
        lastUpdateCheckAt: Date.UTC(2026, 6, 15, 4, 0, 0),
    });
});
afterEach(() => vi.clearAllMocks());

test('shows desktop and connection details from the Help menu dialog', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);

    expect(screen.getByRole('dialog').textContent).toContain('cBranch Canary');
    expect(screen.getByRole('dialog').textContent).toContain(
        'Copyright 2026 cbranch contributors.',
    );
    await waitFor(() =>
        expect(screen.getByRole('dialog').textContent).toContain('v0.2.2-rc.9'),
    );
    expect(screen.getByRole('dialog').textContent).toContain(
        'Tunnel connected',
    );
    expect(screen.getByRole('dialog').textContent).toContain('Work server');

    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(updater.requestDesktopUpdateCheck).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().aboutDialogOpen).toBe(false);
});

test('replaces the update check with an install CTA when an update is ready', async () => {
    updater.state = { kind: 'ready' };
    const user = userEvent.setup();
    render(<AboutDialog />);

    expect(
        screen.queryByRole('button', { name: 'Check for updates' }),
    ).toBeNull();
    await user.click(
        screen.getByRole('button', { name: 'Install update and restart' }),
    );
    expect(updater.requestDesktopUpdateInstall).toHaveBeenCalledOnce();
});

test('shows download progress in place of the update check', () => {
    updater.state = { kind: 'downloading', progress: 42 };
    render(<AboutDialog />);

    expect(
        screen
            .getByRole('button', { name: 'Downloading update (42%)' })
            .hasAttribute('disabled'),
    ).toBe(true);
});
