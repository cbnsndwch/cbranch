// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    ConnectionStatusIndicator,
    DesktopDisconnectAction,
} from './ConnectionStatusIndicator';
import { TooltipProvider } from './ui/tooltip';

const mocks = vi.hoisted(() => ({
    disconnect: vi.fn(),
    isDesktopSurface: vi.fn(),
    loadDesktopBridge: vi.fn(),
    useConnection: vi.fn(),
    useOptionalConnection: vi.fn(),
}));

vi.mock('../desktop/bridge', () => ({
    isDesktopSurface: mocks.isDesktopSurface,
    loadDesktopBridge: mocks.loadDesktopBridge,
}));

vi.mock('../rpc/connection-provider', () => ({
    useConnection: mocks.useConnection,
    useOptionalConnection: mocks.useOptionalConnection,
}));

describe('ConnectionStatusIndicator', () => {
    beforeEach(() => {
        mocks.disconnect.mockReset();
        mocks.isDesktopSurface.mockReturnValue(true);
        mocks.loadDesktopBridge.mockReset();
        mocks.useConnection.mockReturnValue({ status: 'connected' });
        mocks.useOptionalConnection.mockReturnValue({
            endpoint: { httpBaseUrl: 'http://127.0.0.1:7420' },
            disconnect: mocks.disconnect,
        });
    });

    afterEach(cleanup);

    test('only renders a stale-data notice while reconnecting', () => {
        const { container, rerender } = render(<ConnectionStatusIndicator />);

        expect(container.firstChild).toBeNull();

        mocks.useConnection.mockReturnValue({ status: 'reconnecting' });
        rerender(<ConnectionStatusIndicator />);

        expect(screen.getByRole('status').textContent).toBe(
            'Reconnecting to cBranch. Data may be stale.',
        );
    });

    test('disconnects the desktop tunnel before the React connection', async () => {
        let completeDisconnect: (() => void) | undefined;
        mocks.loadDesktopBridge.mockResolvedValue({
            disconnect: () =>
                new Promise<void>(resolve => {
                    completeDisconnect = resolve;
                }),
        });

        render(
            <TooltipProvider>
                <DesktopDisconnectAction />
            </TooltipProvider>,
        );

        const action = screen.getByRole('button', {
            name: 'Disconnect from cBranch server',
        });
        fireEvent.click(action);

        expect(action.getAttribute('aria-label')).toBe(
            'Disconnecting from cBranch server',
        );
        expect((action as HTMLButtonElement).disabled).toBe(true);
        expect(mocks.disconnect).not.toHaveBeenCalled();

        await waitFor(() => expect(completeDisconnect).toBeTypeOf('function'));
        completeDisconnect?.();

        await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledOnce());
    });
});
