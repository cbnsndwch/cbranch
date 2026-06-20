// Ephemeral UI state (docs/spec/15 §7/§8 — Zustand, per-tab, never synced).
//
// React Query owns all SYNCED repository data (keyed `[repoId, domain, …]`); this
// store holds only transient, per-tab UI state: which repo/commit is active, whether
// the command palette is open, and the theme preference. Selection resets when the
// active repository changes (P1-OPEN-4 / P1-X-4).

import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { create } from "zustand";

import { type DiffView, readDiffView, writeDiffView } from "../lib/diff";
import { emptyFilters, type LogFilters } from "../lib/filters";
import { type DateMode, readDateMode, writeDateMode } from "../lib/format";
import { applyTheme, readThemePref, type ThemePref } from "../theme/theme";

export type DetailTab = "changes" | "commit" | "diff" | "filetree" | "gpg" | "console" | "output";

export interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  signoff: boolean;
}

const DEFAULT_DRAFT: CommitDraft = { subject: "", body: "", amend: false, signoff: false };

export interface UiState {
  /** The single active repository (cbranch is one-repo-at-a-time, P1-OPEN-4). */
  readonly activeRepoId: RepoId | null;
  /** The selected commit, driving the details panel + diff (P1-HIST-5). */
  readonly selectedOid: Oid | null;
  /** Whether the cmdk command palette / repo switcher is open (P1-UI-OPEN-1). */
  readonly paletteOpen: boolean;
  /** Light/dark/system preference (NF-THEME-2). */
  readonly theme: ThemePref;
  /** Active history filters (P1-FILT-*); reset when the repository changes. */
  readonly filters: LogFilters;
  /** Relative/absolute date display preference (P1-HIST-8). */
  readonly dateMode: DateMode;
  /** Inline/side-by-side diff presentation preference (P1-DIFF-3). */
  readonly diffView: DiffView;
  readonly detailTab: DetailTab;
  readonly setDetailTab: (tab: DetailTab) => void;
  readonly knownRefStrings: ReadonlyArray<string>;
  readonly setKnownRefStrings: (refs: ReadonlyArray<string>) => void;
  readonly setActiveRepoId: (id: RepoId | null) => void;
  readonly setSelectedOid: (oid: Oid | null) => void;
  readonly setPaletteOpen: (open: boolean) => void;
  readonly setTheme: (theme: ThemePref) => void;
  readonly setFilters: (filters: LogFilters) => void;
  readonly setDateMode: (mode: DateMode) => void;
  readonly setDiffView: (view: DiffView) => void;
  // ── P2: commit draft ────────────────────────────────────────────────────────
  readonly commitDraft: CommitDraft;
  readonly updateCommitDraft: (patch: Partial<CommitDraft>) => void;
  readonly resetCommitDraft: () => void;
  // ── P2: file selection (staged / unstaged panels) ───────────────────────────
  readonly stagedSelection: ReadonlySet<string>;
  readonly unstagedSelection: ReadonlySet<string>;
  readonly toggleStagedSelection: (path: string) => void;
  readonly toggleUnstagedSelection: (path: string) => void;
  readonly setStagedSelection: (paths: ReadonlyArray<string>) => void;
  readonly setUnstagedSelection: (paths: ReadonlyArray<string>) => void;
  readonly clearSelection: () => void;
  // ── P2: which file the WorkingDiffPanel shows ───────────────────────────────
  readonly selectedDiffFile: { path: string; staged: boolean } | null;
  readonly setSelectedDiffFile: (f: { path: string; staged: boolean } | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeRepoId: null,
  selectedOid: null,
  paletteOpen: false,
  theme: readThemePref(),
  filters: emptyFilters,
  dateMode: readDateMode(),
  diffView: readDiffView(),
  detailTab: "commit",
  knownRefStrings: [],
  commitDraft: DEFAULT_DRAFT,
  stagedSelection: new Set(),
  unstagedSelection: new Set(),
  selectedDiffFile: null,
  // Switching repositories supersedes the old selection and filters (P1-OPEN-4 / P1-X-4).
  setActiveRepoId: (activeRepoId) =>
    set({
      activeRepoId,
      selectedOid: null,
      filters: emptyFilters,
      stagedSelection: new Set(),
      unstagedSelection: new Set(),
      selectedDiffFile: null,
    }),
  setSelectedOid: (selectedOid) => set({ selectedOid }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
  setFilters: (filters) => set({ filters }),
  setDateMode: (dateMode) => {
    writeDateMode(dateMode);
    set({ dateMode });
  },
  setDiffView: (diffView) => {
    writeDiffView(diffView);
    set({ diffView });
  },
  setDetailTab: (detailTab) => set({ detailTab }),
  setKnownRefStrings: (knownRefStrings) => set({ knownRefStrings }),
  updateCommitDraft: (patch) => set((s) => ({ commitDraft: { ...s.commitDraft, ...patch } })),
  resetCommitDraft: () => set({ commitDraft: DEFAULT_DRAFT }),
  toggleStagedSelection: (path) =>
    set((s) => {
      const next = new Set(s.stagedSelection);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { stagedSelection: next };
    }),
  toggleUnstagedSelection: (path) =>
    set((s) => {
      const next = new Set(s.unstagedSelection);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { unstagedSelection: next };
    }),
  setStagedSelection: (paths) => set({ stagedSelection: new Set(paths) }),
  setUnstagedSelection: (paths) => set({ unstagedSelection: new Set(paths) }),
  clearSelection: () => set({ stagedSelection: new Set(), unstagedSelection: new Set() }),
  setSelectedDiffFile: (selectedDiffFile) => set({ selectedDiffFile }),
}));
