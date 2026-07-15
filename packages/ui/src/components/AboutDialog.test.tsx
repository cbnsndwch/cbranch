// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useUiStore } from '../state/store';

const { requestDesktopUpdateCheck } = vi.hoisted(() => ({
    requestDesktopUpdateCheck: vi.fn(),
}));
vi.mock('../desktop/DesktopUpdater', () => ({ requestDesktopUpdateCheck }));
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
    useUiStore.setState({
        aboutDialogOpen: true,
        lastUpdateCheckAt: Date.UTC(2026, 6, 15, 4, 0, 0),
    });
});
afterEach(() => vi.clearAllMocks());

test('shows desktop and connection details from the Help menu dialog', async () => {
    const user = userEvent.setup();
    render(<AboutDialog />);

    expect(screen.getByRole('dialog').textContent).toContain('cBranch');
    expect(screen.getByRole('dialog').textContent).toContain(
        'Copyright 2026 cbranch contributors.',
    );
    await waitFor(() =>
        expect(screen.getByRole('dialog').textContent).toContain('v0.2.0'),
    );
    expect(screen.getByRole('dialog').textContent).toContain(
        'Tunnel connected',
    );
    expect(screen.getByRole('dialog').textContent).toContain('Work server');

    await user.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(requestDesktopUpdateCheck).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().aboutDialogOpen).toBe(false);
});
