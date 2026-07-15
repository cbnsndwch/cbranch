import { CBRANCH_BACKEND_VERSION } from '@cbranch/rpc-contract';
import { useEffect, useState } from 'react';

import {
    type DesktopDiagnostics,
    isDesktopSurface,
    loadDesktopBridge,
} from '../desktop/bridge';
import { requestDesktopUpdateCheck } from '../desktop/DesktopUpdater';
import { useOptionalConnection } from '../rpc/connection-provider';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';

const connectionLabel: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    disconnected: 'Not connected',
    failed: 'Connection failed',
};

const formatTimestamp = (timestamp: number | null): string =>
    timestamp === null
        ? 'Not checked this session'
        : new Date(timestamp).toLocaleString();

export function AboutDialog() {
    const open = useUiStore(s => s.aboutDialogOpen);
    if (!open) return null;
    return <AboutDialogBody />;
}

function AboutDialogBody() {
    const setOpen = useUiStore(s => s.setAboutDialogOpen);
    const lastUpdateCheckAt = useUiStore(s => s.lastUpdateCheckAt);
    const connection = useOptionalConnection();
    const [diagnostics, setDiagnostics] = useState<DesktopDiagnostics>();
    const [diagnosticsError, setDiagnosticsError] = useState(false);
    const desktop = isDesktopSurface();

    useEffect(() => {
        if (!desktop) return;
        let active = true;
        void loadDesktopBridge()
            .then(bridge => bridge.diagnostics())
            .then(details => {
                if (active) setDiagnostics(details);
            })
            .catch(() => {
                if (active) setDiagnosticsError(true);
            });
        return () => {
            active = false;
        };
    }, [desktop]);

    const serverStatus = connection
        ? connectionLabel[connection.status]
        : diagnostics?.tunnelState === 'connected'
          ? 'Tunnel connected'
          : 'Not connected';
    const version = diagnostics?.desktopVersion ?? CBRANCH_BACKEND_VERSION;

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next) setOpen(false);
            }}
        >
            <DialogContent style={{ width: 'min(500px, 92vw)' }}>
                <div className="grid gap-5 p-5">
                    <div className="grid gap-1">
                        <DialogTitle className="text-xl tracking-tight">
                            cBranch
                        </DialogTitle>
                        <DialogDescription>
                            A desktop-style Git client for connected teams.
                        </DialogDescription>
                    </div>

                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 border-y py-4 text-sm">
                        <dt className="text-muted-foreground">Version</dt>
                        <dd>v{version}</dd>
                        <dt className="text-muted-foreground">Server</dt>
                        <dd>{serverStatus}</dd>
                        {diagnostics?.profile && (
                            <>
                                <dt className="text-muted-foreground">
                                    Profile
                                </dt>
                                <dd>{diagnostics.profile.name}</dd>
                            </>
                        )}
                        <dt className="text-muted-foreground">
                            Last update check
                        </dt>
                        <dd>{formatTimestamp(lastUpdateCheckAt)}</dd>
                    </dl>

                    {diagnosticsError && (
                        <p className="text-destructive text-xs">
                            Desktop diagnostics are unavailable.
                        </p>
                    )}

                    <p className="text-muted-foreground text-xs">
                        Copyright 2026 cbranch contributors. Released under the
                        MIT License.
                    </p>

                    <div className="flex justify-end gap-2">
                        {desktop && (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={requestDesktopUpdateCheck}
                            >
                                Check for updates
                            </Button>
                        )}
                        <Button size="sm" onClick={() => setOpen(false)}>
                            Close
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
