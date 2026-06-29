// The app-wide keybinding dispatcher (docs/spec/09-phase5-power.md REQ-P5-CFG-006).
//
// One window `keydown` listener replaces the ad-hoc per-component listeners. It merges
// the user's overrides (host config.json, via `useAppSettings`) over the defaults and
// runs the action bound to the first matching chord. The caller supplies the action map
// (commandId → handler); a binding with no registered action is inert.

import { useEffect, useRef } from "react";

import {
  keybindingsToRecord,
  matchChord,
  mergeBindings,
  parseChord,
} from "../lib/keybindings";
import { useAppSettings } from "../rpc/hooks";

/** Whether the event originates from a field where typing must not be hijacked. */
const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
};

// While the SettingsDialog is RECORDING a new chord, the global dispatcher must stand down
// entirely: a captured MODIFIER chord (e.g. Mod+K) otherwise ALSO fires its bound global
// action and pops the palette/find over the dialog (the editable-field guard below only
// suppresses BARE keys). The chord-capture input raises this module-level flag for the
// lifetime of its recording; the dispatcher honors it first (REQ-P5-CFG-006/007).
const captureState = { active: false };

/**
 * Suspend (`true`) or resume (`false`) the global keybinding dispatcher. SettingsDialog's
 * chord-capture input calls this while recording a new binding so the keystroke is consumed
 * by the capture, never by the action that chord is (or is about to be) bound to.
 */
export const setKeybindingCaptureActive = (active: boolean): void => {
  captureState.active = active;
};

export const useKeybindings = (
  actions: Readonly<Record<string, () => void>>,
): void => {
  const settings = useAppSettings();
  const bindings = mergeBindings(
    keybindingsToRecord(settings.data?.keybindings ?? []),
  );

  // Keep the latest bindings/actions in a ref so the listener installs ONCE yet always
  // sees current state (avoids re-binding the window listener on every settings change).
  const ref = useRef({ bindings, actions });
  ref.current = { bindings, actions };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A chord-capture field is recording a binding — let it consume the keystroke so
      // capturing a chord never also fires the action that chord is bound to.
      if (captureState.active) return;
      const current = ref.current;
      const editable = isEditableTarget(event.target);
      for (const [commandId, chord] of Object.entries(current.bindings)) {
        const action = current.actions[commandId];
        if (action === undefined || !matchChord(event, chord)) continue;
        // While typing in a field, only fire chords that carry a modifier, so a
        // remapped bare key (e.g. "F") never hijacks text entry.
        if (editable && !parseChord(chord).mod && !parseChord(chord).alt)
          continue;
        event.preventDefault();
        action();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};
