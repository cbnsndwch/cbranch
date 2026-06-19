import { useEffect } from "react";
import { Toaster } from "sonner";

import { AppShell } from "./components/AppShell";
import { CommandPalette } from "./components/CommandPalette";
import { useUiStore } from "./state/store";

// Root view: the browse shell plus the global command palette. A global shortcut
// (⌘/Ctrl-K) opens the switcher anywhere (P1-UI-OPEN-1 / NF-A11Y-6).
export function App() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        useUiStore.getState().setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Theme the toasts to follow the resolved light/dark root (NF-ERR-2 / NF-THEME-2).
  const theme = useUiStore((s) => s.theme);

  return (
    <>
      <AppShell />
      <CommandPalette />
      <Toaster theme={theme} position="bottom-right" closeButton richColors />
    </>
  );
}
