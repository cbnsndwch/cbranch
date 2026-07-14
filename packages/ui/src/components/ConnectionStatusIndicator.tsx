import { LoaderCircle, Unplug } from 'lucide-react';
import { useState } from 'react';

import { isDesktopSurface, loadDesktopBridge } from '../desktop/bridge';
import {
    useConnection,
    useOptionalConnection,
} from '../rpc/connection-provider';
import { cn } from '../lib/cn';
import { Button } from './ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

/** Compact desktop-only control for closing the SSH tunnel and RPC connection. */
export function DesktopDisconnectAction({
    className,
}: {
    readonly className?: string;
}) {
    const connection = useOptionalConnection();
    const [disconnecting, setDisconnecting] = useState(false);
    if (!isDesktopSurface() || connection?.endpoint === undefined) return null;

    const disconnectDesktop = async () => {
        setDisconnecting(true);
        try {
            await (await loadDesktopBridge()).disconnect();
        } finally {
            connection.disconnect();
            setDisconnecting(false);
        }
    };
    const serverUrl = connection.endpoint.httpBaseUrl;

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn('shrink-0', className)}
                        aria-label={
                            disconnecting
                                ? 'Disconnecting from cBranch server'
                                : 'Disconnect from cBranch server'
                        }
                        disabled={disconnecting}
                        onClick={() => void disconnectDesktop()}
                    >
                        {disconnecting ? (
                            <LoaderCircle
                                className="size-4 animate-spin"
                                aria-hidden="true"
                            />
                        ) : (
                            <Unplug className="size-4" aria-hidden="true" />
                        )}
                    </Button>
                }
            />
            <TooltipContent>Disconnect from {serverUrl}</TooltipContent>
        </Tooltip>
    );
}

/** Non-blocking liveness state for the active Git workspace. */
export function ConnectionStatusIndicator() {
    const { status } = useConnection();
    if (status !== 'reconnecting') return null;

    return (
        <div
            role="status"
            aria-live="polite"
            className="bg-muted flex shrink-0 items-center border-b px-3 py-1 text-xs"
        >
            Reconnecting to cBranch. Data may be stale.
        </div>
    );
}
