// The app-wide keybinding dispatcher (docs/spec/09-phase5-power.md REQ-P5-CFG-006).
//
// One window `keydown` listener replaces the ad-hoc per-component listeners. It merges
// the user's overrides (host config.json, via `useAppSettings`) over the defaults and
// runs the action bound to the first matching chord. The caller supplies the action map
// (commandId → handler); a binding with no registered action is inert.

import { useEffect, useRef } from "react";

import { matchChord, mergeBindings } from "../lib/keybindings";
import { useAppSettings } from "../rpc/hooks";

export const useKeybindings = (
  actions: Readonly<Record<string, () => void>>,
): void => {
  const settings = useAppSettings();

  const overrides: Record<string, string> = {};
  for (const b of settings.data?.keybindings ?? [])
    overrides[b.commandId] = b.chord;
  const bindings = mergeBindings(overrides);

  // Keep the latest bindings/actions in a ref so the listener installs ONCE yet always
  // sees current state (avoids re-binding the window listener on every settings change).
  const ref = useRef({ bindings, actions });
  ref.current = { bindings, actions };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = ref.current;
      for (const [commandId, chord] of Object.entries(current.bindings)) {
        const action = current.actions[commandId];
        if (action !== undefined && matchChord(event, chord)) {
          event.preventDefault();
          action();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};
