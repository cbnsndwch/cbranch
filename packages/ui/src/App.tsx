import { useEffect } from 'react';
import { Toaster } from 'sonner';

import { AppShell } from './components/AppShell';
import { useKeybindings } from './hooks/use-keybindings';
import { useAppSettings } from './rpc/hooks';
import { useUiStore } from './state/store';

// The action map the keybinding dispatcher runs (commandId → handler). Store getters
// keep it stable; opening a repo-scoped dialog with no repo is a harmless no-op (the
// dialog renders null). Defined at module scope so it never re-installs the listener.
const KEYBINDING_ACTIONS: Readonly<Record<string, () => void>> = {
    'view.commandPalette': () =>
        useUiStore.getState().setCommandPaletteOpen(true),
    'view.repoSwitcher': () => useUiStore.getState().setRepoSwitcherOpen(true),
    'commands.commit': () => useUiStore.getState().setCommitDialogOpen(true),
    'history.find': () => useUiStore.getState().setFindOpen(true),
    'navigate.goto': () => useUiStore.getState().setGoToDialogOpen(true),
};

// Root view: the browse shell (which mounts the command palette + repo switcher
// overlays, AppShell.tsx). Global shortcuts (⌘/Ctrl-K commands, ⌘/Ctrl-O repo switcher,
// ⌘/Ctrl-Shift-Enter commit, ⌘/Ctrl-F find) are dispatched centrally from
// user-remappable keybindings (REQ-P5-CFG-006 / NF-A11Y-6).
export function App() {
    useKeybindings(KEYBINDING_ACTIONS);

    // Theme the toasts to follow the resolved light/dark root (NF-ERR-2 / NF-THEME-2).
    const theme = useUiStore(s => s.theme);
    const setTheme = useUiStore(s => s.setTheme);

    // Reconcile the pre-paint localStorage theme cache with the host's persisted
    // preference once app settings load (config.json is the source of truth, REQ-P5-CFG-006).
    const appSettings = useAppSettings();
    const hostTheme = appSettings.data?.theme;
    useEffect(() => {
        if (
            hostTheme !== undefined &&
            hostTheme !== useUiStore.getState().theme
        )
            setTheme(hostTheme);
    }, [hostTheme, setTheme]);

    return (
        <>
            <AppShell />
            <Toaster
                theme={theme}
                position="bottom-right"
                closeButton
                richColors
            />
        </>
    );
}
