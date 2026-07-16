import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../components/ui/button';
import { APP_INFO } from '../lib/app-info';
import { useUiStore } from '../state/store';
import { isDesktopSurface } from './bridge';

type UpdateState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'downloading'; readonly progress?: number }
    | { readonly kind: 'ready' }
    | { readonly kind: 'error' };

const UPDATE_CHECK_EVENT = 'cbranch:check-for-updates';

/** Ask the mounted desktop updater to run a user-initiated update check. */
export const requestDesktopUpdateCheck = (): void => {
    if (typeof window !== 'undefined')
        window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
};

/** Download a signed desktop update in the background and restart only on user action. */
export function DesktopUpdater() {
    const [state, setState] = useState<UpdateState>({ kind: 'idle' });
    const updateRef = useRef<{ install(): Promise<void> } | undefined>(
        undefined,
    );
    const checkingRef = useRef(false);
    const mountedRef = useRef(true);

    const checkForUpdates = useEffectEvent(async (manual: boolean) => {
        if (checkingRef.current) {
            if (manual) toast('An update check is already in progress.');
            return;
        }
        if (updateRef.current) {
            if (manual) toast('An update is ready to install.');
            return;
        }

        checkingRef.current = true;
        try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const update = await check();
            if (!mountedRef.current) return;
            useUiStore.getState().setLastUpdateCheckAt(Date.now());
            if (!update) {
                if (manual) toast.success(`${APP_INFO.name} is up to date.`);
                return;
            }
            updateRef.current = update;
            let total = 0;
            let downloaded = 0;
            setState({ kind: 'downloading' });
            await update.download(event => {
                if (!mountedRef.current) return;
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
            if (mountedRef.current) setState({ kind: 'ready' });
        } catch {
            if (mountedRef.current) setState({ kind: 'error' });
            if (manual && mountedRef.current)
                toast.error('Could not check for updates.');
        } finally {
            checkingRef.current = false;
        }
    });

    useEffect(() => {
        if (!isDesktopSurface()) return;
        mountedRef.current = true;
        void checkForUpdates(false);
        const onUpdateCheck = () => void checkForUpdates(true);
        window.addEventListener(UPDATE_CHECK_EVENT, onUpdateCheck);
        return () => {
            mountedRef.current = false;
            window.removeEventListener(UPDATE_CHECK_EVENT, onUpdateCheck);
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
