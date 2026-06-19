// Ephemeral UI state (docs/spec/15 §7/§8 — Zustand, per-tab, never synced).
//
// React Query owns all SYNCED repository data (keyed `[repoId, domain, …]`); this
// store holds only transient, per-tab UI state: which repo/commit is active, whether
// the command palette is open, and the theme preference. Selection resets when the
// active repository changes (P1-OPEN-4 / P1-X-4).

import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { create } from "zustand";

import { applyTheme, readThemePref, type ThemePref } from "../theme/theme";

export interface UiState {
  /** The single active repository (cbranch is one-repo-at-a-time, P1-OPEN-4). */
  readonly activeRepoId: RepoId | null;
  /** The selected commit, driving the details panel + diff (P1-HIST-5). */
  readonly selectedOid: Oid | null;
  /** Whether the cmdk command palette / repo switcher is open (P1-UI-OPEN-1). */
  readonly paletteOpen: boolean;
  /** Light/dark/system preference (NF-THEME-2). */
  readonly theme: ThemePref;
  readonly setActiveRepoId: (id: RepoId | null) => void;
  readonly setSelectedOid: (oid: Oid | null) => void;
  readonly setPaletteOpen: (open: boolean) => void;
  readonly setTheme: (theme: ThemePref) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeRepoId: null,
  selectedOid: null,
  paletteOpen: false,
  theme: readThemePref(),
  // Switching repositories supersedes the old selection (P1-OPEN-4 / P1-X-4).
  setActiveRepoId: (activeRepoId) => set({ activeRepoId, selectedOid: null }),
  setSelectedOid: (selectedOid) => set({ selectedOid }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
