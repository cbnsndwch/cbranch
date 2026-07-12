import { useState } from 'react';

import { isDesktopSurface, loadDesktopBridge } from '../desktop/bridge';
import { useConnection } from '../rpc/connection-provider';
import { Button } from './ui/button';

/** Non-blocking liveness state for the active Git workspace. */
export function ConnectionStatusIndicator() {
    const { endpoint, status, disconnect } = useConnection();
    const [disconnecting, setDisconnecting] = useState(false);
    if (status !== 'reconnecting' && !isDesktopSurface()) return null;

    const disconnectDesktop = async () => {
        setDisconnecting(true);
        try {
            await (await loadDesktopBridge()).disconnect();
        } finally {
            disconnect();
            setDisconnecting(false);
        }
    };

    return (
        <div
            role={status === 'reconnecting' ? 'status' : undefined}
            aria-live="polite"
            className="bg-muted flex shrink-0 items-center justify-between gap-3 border-b px-3 py-1 text-xs"
        >
            <span>
                {status === 'reconnecting'
                    ? 'Reconnecting to cbranch. Data may be stale.'
                    : endpoint?.httpBaseUrl}
            </span>
            {isDesktopSurface() && (
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disconnecting}
                    onClick={() => void disconnectDesktop()}
                >
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                </Button>
            )}
        </div>
    );
}
