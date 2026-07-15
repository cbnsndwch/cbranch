// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { check, toastSuccess } = vi.hoisted(() => ({
    check: vi.fn(),
    toastSuccess: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
vi.mock('./bridge', () => ({ isDesktopSurface: () => true }));
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), { success: toastSuccess, error: vi.fn() }),
}));

import { DesktopUpdater, requestDesktopUpdateCheck } from './DesktopUpdater';

beforeEach(() => {
    check.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

test('runs a user-requested update check and reports when already up to date', async () => {
    render(<DesktopUpdater />);
    await waitFor(() => expect(check).toHaveBeenCalledOnce());

    act(requestDesktopUpdateCheck);

    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(toastSuccess).toHaveBeenCalledWith('cBranch is up to date.');
});
