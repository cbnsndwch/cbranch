import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { Button } from '../components/ui/button';
import { APP_INFO } from '../lib/app-info';
import { useUiStore } from '../state/store';
import { isDesktopSurface } from './bridge';

export type DesktopUpdateState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'checking' }
    | { readonly kind: 'downloading'; readonly progress?: number }
    | { readonly kind: 'ready' }
    | { readonly kind: 'installing' }
    | { readonly kind: 'error' };

const UPDATE_CHECK_EVENT = 'cbranch:check-for-updates';
const UPDATE_INSTALL_EVENT = 'cbranch:install-update';
let updateState: DesktopUpdateState = { kind: 'idle' };
const updateStateListeners = new Set<() => void>();

const readUpdateState = () => updateState;
const subscribeToUpdateState = (listener: () => void) => {
    updateStateListeners.add(listener);
    return () => updateStateListeners.delete(listener);
};
const setUpdateState = (next: DesktopUpdateState) => {
    updateState = next;
    for (const listener of updateStateListeners) listener();
};

/** Read the mounted desktop updater's current state from any app surface. */
export const useDesktopUpdateState = (): DesktopUpdateState =>
    useSyncExternalStore(
        subscribeToUpdateState,
        readUpdateState,
        readUpdateState,
    );

/** Ask the mounted desktop updater to run a user-initiated update check. */
export const requestDesktopUpdateCheck = (): void => {
    if (typeof window !== 'undefined')
        window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
};

/** Install the downloaded signed update and restart the desktop app. */
export const requestDesktopUpdateInstall = (): void => {
    if (typeof window !== 'undefined')
        window.dispatchEvent(new Event(UPDATE_INSTALL_EVENT));
};

/** Download a signed desktop update in the background and restart only on user action. */
export function DesktopUpdater() {
    const state = useDesktopUpdateState();
    const aboutDialogOpen = useUiStore(s => s.aboutDialogOpen);
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
            setUpdateState({ kind: 'ready' });
            if (manual) toast('An update is ready to install.');
            return;
        }

        checkingRef.current = true;
        setUpdateState({ kind: 'checking' });
        try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const update = await check();
            if (!mountedRef.current) return;
            useUiStore.getState().setLastUpdateCheckAt(Date.now());
            if (!update) {
                setUpdateState({ kind: 'idle' });
                if (manual) toast.success(`${APP_INFO.name} is up to date.`);
                return;
            }
            updateRef.current = update;
            let total = 0;
            let downloaded = 0;
            setUpdateState({ kind: 'downloading' });
            await update.download(event => {
                if (!mountedRef.current) return;
                if (event.event === 'Started') {
                    total = event.data.contentLength ?? 0;
                    downloaded = 0;
                }
                if (event.event === 'Progress') {
                    downloaded += event.data.chunkLength;
                    setUpdateState({
                        kind: 'downloading',
                        progress:
                            total > 0
                                ? Math.round((downloaded / total) * 100)
                                : undefined,
                    });
                }
            });
            if (mountedRef.current) setUpdateState({ kind: 'ready' });
        } catch {
            if (mountedRef.current) setUpdateState({ kind: 'error' });
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
        const onUpdateInstall = () => void restart();
        window.addEventListener(UPDATE_CHECK_EVENT, onUpdateCheck);
        window.addEventListener(UPDATE_INSTALL_EVENT, onUpdateInstall);
        return () => {
            mountedRef.current = false;
            window.removeEventListener(UPDATE_CHECK_EVENT, onUpdateCheck);
            window.removeEventListener(UPDATE_INSTALL_EVENT, onUpdateInstall);
        };
    }, []);

    const restart = async () => {
        const update = updateRef.current;
        if (!update) return;
        setUpdateState({ kind: 'installing' });
        try {
            await update.install();
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
        } catch {
            setUpdateState({ kind: 'error' });
            toast.error('Could not install the update.');
        }
    };

    if (
        state.kind === 'idle' ||
        state.kind === 'checking' ||
        state.kind === 'error' ||
        aboutDialogOpen
    )
        return null;
    return (
        <div className="bg-primary text-primary-foreground fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-32px)] items-center gap-3 border px-3 py-2 text-sm shadow-lg">
            <span>
                {state.kind === 'downloading'
                    ? `Downloading update${state.progress === undefined ? '…' : ` (${state.progress}%)`}`
                    : state.kind === 'installing'
                      ? 'Installing update…'
                      : 'Update ready'}
            </span>
            {state.kind === 'ready' && (
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void restart()}
                >
                    Install and restart
                </Button>
            )}
        </div>
    );
}
