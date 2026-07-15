import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { isDesktopSurface } from './bridge';

type UpdateState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'downloading'; readonly progress?: number }
    | { readonly kind: 'ready' }
    | { readonly kind: 'error' };

/** Download a signed desktop update in the background and restart only on user action. */
export function DesktopUpdater() {
    const [state, setState] = useState<UpdateState>({ kind: 'idle' });
    const updateRef = useRef<{ install(): Promise<void> } | undefined>(
        undefined,
    );

    useEffect(() => {
        if (!isDesktopSurface()) return;
        let cancelled = false;
        void (async () => {
            try {
                const { check } = await import('@tauri-apps/plugin-updater');
                const update = await check();
                if (!update || cancelled) return;
                updateRef.current = update;
                let total = 0;
                let downloaded = 0;
                setState({ kind: 'downloading' });
                await update.download(event => {
                    if (cancelled) return;
                    if (event.event === 'Started') {
                        total = event.data.contentLength ?? 0;
                        downloaded = 0;
                    }
                    if (event.event === 'Progress') {
                        downloaded += event.data.chunkLength;
                        setState({
                            kind: 'downloading',
                            progress:
                                total > 0
                                    ? Math.round((downloaded / total) * 100)
                                    : undefined,
                        });
                    }
                });
                if (!cancelled) setState({ kind: 'ready' });
            } catch {
                if (!cancelled) setState({ kind: 'error' });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const restart = async () => {
        const update = updateRef.current;
        if (!update) return;
        try {
            await update.install();
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
        } catch {
            setState({ kind: 'error' });
        }
    };

    if (state.kind === 'idle' || state.kind === 'error') return null;
    return (
        <div className="bg-primary text-primary-foreground fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-32px)] items-center gap-3 border px-3 py-2 text-sm shadow-lg">
            <span>
                {state.kind === 'downloading'
                    ? `Downloading update${state.progress === undefined ? '…' : ` (${state.progress}%)`}`
                    : 'Update ready'}
            </span>
            {state.kind === 'ready' && (
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void restart()}
                >
                    Restart now
                </Button>
            )}
        </div>
    );
}
