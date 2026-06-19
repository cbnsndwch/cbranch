// Theme handling (docs/spec/12 NF-THEME-2/3/6; BRANDING.md).
//
// The shadcn token block in `styles.css` defines light at `:root` and dark under a
// `.dark` class. This module owns the light/dark/"follow system" preference: it
// persists the choice, resolves it against the OS preference, and toggles the root
// `.dark` class. `applyStoredTheme` runs before first paint (NF-THEME-6, no flash);
// the pure `resolveDark` keeps the light/dark decision unit-testable without a DOM.

export type ThemePref = "light" | "dark" | "system";

const STORAGE_KEY = "cbranch.ui.theme";

/** Read the persisted preference; falls back to `"system"` when absent/unreadable. */
export const readThemePref = (): ThemePref => {
  try {
    if (typeof localStorage === "undefined") return "system";
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
};

const writeThemePref = (pref: ThemePref): void => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore unavailable/again-blocked storage (NF-CFG-3 degrade gracefully)
  }
};

/** Whether the OS currently prefers a dark color scheme. */
export const prefersDark = (): boolean => {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
};

/** Pure: should the root `.dark` class be on, given the preference and OS state? */
export const resolveDark = (pref: ThemePref, systemDark: boolean): boolean =>
  pref === "dark" || (pref === "system" && systemDark);

/** Persist a preference and apply it to the document root. No-op outside the DOM. */
export const applyTheme = (pref: ThemePref): void => {
  writeThemePref(pref);
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveDark(pref, prefersDark()));
};

/** Apply the persisted theme to <html> before first paint (NF-THEME-6). */
export const applyStoredTheme = (): void => {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveDark(readThemePref(), prefersDark()));
};
