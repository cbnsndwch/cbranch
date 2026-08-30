// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { check, relaunch, toastSuccess } = vi.hoisted(() => ({
    check: vi.fn(),
    relaunch: vi.fn(),
    toastSuccess: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));
vi.mock('./bridge', () => ({ isDesktopSurface: () => true }));
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn() }),
}));

import { useUiStore } from '../state/store';
import { DesktopUpdater, requestDesktopUpdateCheck } from './DesktopUpdater';

beforeEach(() => {
    check.mockResolvedValue(undefined);
    useUiStore.setState({ aboutDialogOpen: false });
});
afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

test('runs a user-requested update check and reports when already up to date', async () => {
    render(<DesktopUpdater />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());

    act(requestDesktopUpdateCheck);

    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(toastSuccess).toHaveBeenCalledWith('cBranch is up to date.');
});

test('installs and relaunches from the ready update CTA', async () => {
    const user = userEvent.setup();
    const install = vi.fn();
    check.mockResolvedValue({
        download: vi.fn(async callback => {
            callback({
                event: 'Started',
                data: { contentLength: 100 },
            });
            callback({ event: 'Progress', data: { chunkLength: 100 } });
        }),
        install,
    });

    render(<DesktopUpdater />);
    await user.click(
        await screen.findByRole('button', { name: 'Install and restart' }),
    );

    await waitFor(() => expect(install).toHaveBeenCalledOnce());
    expect(relaunch).toHaveBeenCalledOnce();
});

test('hides the floating update CTA while the About dialog is open', async () => {
    check.mockResolvedValue({
        download: vi.fn(),
        install: vi.fn(),
    });
    render(<DesktopUpdater />);
    await screen.findByRole('button', { name: 'Install and restart' });

    act(() => useUiStore.setState({ aboutDialogOpen: true }));

    await waitFor(() =>
        expect(
            screen.queryByRole('button', { name: 'Install and restart' }),
        ).toBeNull(),
    );
});
