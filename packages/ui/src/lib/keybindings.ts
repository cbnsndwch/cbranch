// Keybinding model (docs/spec/09-phase5-power.md REQ-P5-CFG-006/007; D18, S7).
//
// Pure, framework-free: the documented command catalog, the defaults, conflict
// detection, and chord matching/capture. The app-level `useKeybindings` dispatcher
// (hooks/use-keybindings.ts) layers user OVERRIDES (from host config.json) on top via
// `mergeBindings` and installs a single window listener. Chords are normalized strings
// like `Mod+K`, `Mod+Shift+Enter`, `Mod+F` where `Mod` = Ctrl on Windows/Linux, Cmd on
// macOS; modifier order is canonical `Mod+Shift+Alt+<Key>`.

/** A bindable cbranch action (the documented remappable set, REQ-P5-CFG-006). */
export interface KeybindingCommand {
  readonly id: string;
  readonly label: string;
}

/** The documented set of remappable actions (the existing global keyboard shortcuts). */
export const KEYBINDING_COMMANDS: ReadonlyArray<KeybindingCommand> = [
  { id: "view.commandPalette", label: "Open command palette" },
  { id: "commands.commit", label: "Open commit dialog" },
  { id: "history.find", label: "Find in history" },
];

/** Factory-default chord per command id (the shipped shortcuts). */
export const DEFAULT_KEYBINDINGS: Readonly<Record<string, string>> = {
  "view.commandPalette": "Mod+K",
  "commands.commit": "Mod+Shift+Enter",
  "history.find": "Mod+F",
};

/** Reduce the wire `KeyBinding[]` form to the native `Record<commandId, chord>`. */
export const keybindingsToRecord = (
  bindings: ReadonlyArray<{ commandId: string; chord: string }>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const b of bindings) out[b.commandId] = b.chord;
  return out;
};

/** Canonicalize a key token: single letters upper-cased, named keys passed through. */
const normalizeKey = (key: string): string =>
  key.length === 1 ? key.toUpperCase() : key;

interface ParsedChord {
  readonly mod: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

/** Parse a `Mod+Shift+Enter` chord into its modifier flags + final key. */
export const parseChord = (chord: string): ParsedChord => {
  const parts = chord.split("+");
  let mod = false;
  let shift = false;
  let alt = false;
  let key = "";
  for (const part of parts) {
    if (part === "Mod") mod = true;
    else if (part === "Shift") shift = true;
    else if (part === "Alt") alt = true;
    else key = normalizeKey(part);
  }
  return { mod, shift, alt, key };
};

const isModifierKey = (key: string): boolean =>
  key === "Control" || key === "Shift" || key === "Alt" || key === "Meta";

/**
 * Capture the chord a keydown represents, or `null` for a bare modifier press (so the
 * editor can ignore "the user is still holding keys down"). `Mod` collapses Ctrl/Cmd.
 */
export const eventToChord = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null => {
  if (isModifierKey(event.key)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  parts.push(normalizeKey(event.key));
  return parts.join("+");
};

/** Whether a keydown matches a chord (Ctrl and Cmd both satisfy `Mod`). */
export const matchChord = (
  event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  chord: string,
): boolean => {
  if (chord === "") return false;
  const p = parseChord(chord);
  return (
    (event.metaKey || event.ctrlKey) === p.mod &&
    event.shiftKey === p.shift &&
    event.altKey === p.alt &&
    normalizeKey(event.key) === p.key
  );
};

/**
 * Effective bindings = defaults overlaid with user overrides. An override of `""` CLEARS
 * a default (so it no longer fires); any other value remaps it. Overrides for unknown
 * command ids are ignored (defends against stale config).
 */
export const mergeBindings = (
  overrides: Readonly<Record<string, string>>,
): Record<string, string> => {
  const out: Record<string, string> = { ...DEFAULT_KEYBINDINGS };
  for (const [id, chord] of Object.entries(overrides)) {
    if (!(id in DEFAULT_KEYBINDINGS)) continue;
    if (chord === "") delete out[id];
    else out[id] = chord;
  }
  return out;
};

/** A chord bound to two or more commands (REQ-P5-CFG-007). */
export interface KeybindingConflict {
  readonly chord: string;
  readonly commandIds: ReadonlyArray<string>;
}

/** Detect chords bound to more than one command in an EFFECTIVE binding set. */
export const findConflicts = (
  bindings: Readonly<Record<string, string>>,
): ReadonlyArray<KeybindingConflict> => {
  const byChord = new Map<string, string[]>();
  for (const [id, chord] of Object.entries(bindings)) {
    if (chord === "") continue;
    const list = byChord.get(chord) ?? [];
    list.push(id);
    byChord.set(chord, list);
  }
  const conflicts: KeybindingConflict[] = [];
  for (const [chord, commandIds] of byChord)
    if (commandIds.length > 1) conflicts.push({ chord, commandIds });
  return conflicts;
};
