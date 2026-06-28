// Ephemeral UI state (docs/spec/15 §7/§8 — Zustand, per-tab, never synced).
//
// React Query owns all SYNCED repository data (keyed `[repoId, domain, …]`); this
// store holds only transient, per-tab UI state: which repo/commit is active, whether
// the command palette is open, and the theme preference. Selection resets when the
// active repository changes (P1-OPEN-4 / P1-X-4).

import {
  type CommitSummary,
  type Oid,
  type RepoId,
} from "@cbranch/rpc-contract";
import { create } from "zustand";

import {
  readCommitSplit,
  readKeepOpen,
  writeCommitSplit,
  writeKeepOpen,
} from "../lib/commit-ui";
import { type DiffView, readDiffView, writeDiffView } from "../lib/diff";
import { emptyFilters, type LogFilters } from "../lib/filters";
import { type DateMode, readDateMode, writeDateMode } from "../lib/format";
import { readHistorySplit, writeHistorySplit } from "../lib/layout";
import { applyTheme, readThemePref, type ThemePref } from "../theme/theme";

export type DetailTab =
  | "changes"
  | "commit"
  | "diff"
  | "filetree"
  | "gpg"
  | "console"
  | "output";

export type ActiveView =
  | "history"
  | "branches"
  | "worktrees"
  | "stash"
  | "tags"
  | "reflog"
  | "solveConflicts";

/** A commit targeted by a cherry-pick / revert dialog (P4 UI-C, REQ-UX-001). */
export interface PickCommit {
  readonly oid: Oid;
  readonly subject: string;
}

/**
 * The file + revision the blame overlay is open on (P4 UI-D; REQ-UX-009/012). `null` = no
 * blame view. `rev` is a concrete oid (resolved for cacheability — spec 15 §8), `path` the
 * file at that revision; the blame-previous back-stack lives inside the panel, seeded here.
 */
export interface BlameTarget {
  readonly rev: string;
  readonly path: string;
}

/**
 * The file the history overlay is open on (P4 UI-E; REQ-FH-001/005, REQ-UX-010/012). `null` =
 * no history view. `startRev`, when set, is a concrete oid to start the `--follow` walk from
 * (the revision whose diff the user opened history from), so the listing is cacheable; absent
 * = the current branch tip. Per-revision actions (diff / file-at-rev / blame) live in the panel.
 */
export interface HistoryTarget {
  readonly path: string;
  readonly startRev?: string;
}

/**
 * The cherry-pick / revert / empty-result dialog surface (P4 UI-C). `null` = no dialog
 * open. The `cherryPick`/`revert` forms carry the target commit(s) in application order;
 * the `empty` form is the follow-up prompt git stops on when a pick produces no changes
 * (REQ-UX-008), carrying the offending commit so it can be skipped or committed empty.
 *
 * `commits` is an array for the multi-commit listing of REQ-UX-001, but every UI-C launch
 * point (context menu / detail view / menu) targets a single commit; range cherry-pick /
 * multi-revert (REQ-CP-002 / REQ-RV-004) await a multi-select source in a later slice.
 */
export type PickDialogState =
  | { readonly kind: "cherryPick"; readonly commits: ReadonlyArray<PickCommit> }
  | { readonly kind: "revert"; readonly commits: ReadonlyArray<PickCommit> }
  | {
      readonly kind: "empty";
      readonly mode: "cherryPick" | "revert";
      readonly currentOid?: Oid;
      readonly currentSubject?: string;
      /** A user-edited revert message to preserve on "Commit anyway" (REQ-RV-001). */
      readonly message?: string;
    }
  | null;

export interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  signoff: boolean;
  /** Explicit opt-in to record an empty commit (no staged changes). */
  allowEmpty: boolean;
  /** Reset author to the committer on amend (`--reset-author`); only valid while amending. */
  resetAuthor: boolean;
  /** Cryptographically sign the commit; honors `gpg.format` (never silently unsigned). */
  sign: boolean;
  signFormat: "gpg" | "ssh";
  /** Override the recorded author identity (collapsible "author override" control). */
  authorOverride: boolean;
  authorName: string;
  authorEmail: string;
}

const DEFAULT_DRAFT: CommitDraft = {
  subject: "",
  body: "",
  amend: false,
  signoff: false,
  allowEmpty: false,
  resetAuthor: false,
  sign: false,
  signFormat: "gpg",
  authorOverride: false,
  authorName: "",
  authorEmail: "",
};

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
  // ── P2: commit dialog surface (docs/design/commit-surface.md) ────────────────
  /** Whether the dedicated stage-&-commit modal dialog is open (§2). */
  readonly commitDialogOpen: boolean;
  readonly setCommitDialogOpen: (open: boolean) => void;
  /** "Keep open after commit" toggle — default ON, persisted per session (§5). */
  readonly keepOpenAfterCommit: boolean;
  readonly setKeepOpenAfterCommit: (value: boolean) => void;
  /** The dialog body's changes|diff split fraction (0..1), persisted (§2/§3). */
  readonly commitSplit: number;
  readonly setCommitSplit: (fraction: number) => void;
  /** History view's list|details split fraction (0..1), persisted (lib/layout.ts). */
  readonly historySplit: number;
  readonly setHistorySplit: (fraction: number) => void;
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
  readonly setSelectedDiffFile: (
    f: { path: string; staged: boolean } | null,
  ) => void;
  // ── P2: optimistic history ───────────────────────────────────────────────────
  /**
   * Locally-created commits shown at the top of the log instantly, before the
   * restarted log stream re-snapshots the real history (the stream is not a query, so
   * it can't be set optimistically the way React Query caches can). Reconciled by oid:
   * each entry is dropped once the streamed history confirms it, and the whole channel
   * is cleared whenever the log is re-scoped (repo/filter change).
   */
  readonly optimisticCommits: ReadonlyArray<CommitSummary>;
  readonly addOptimisticCommit: (commit: CommitSummary) => void;
  /** Drop optimistic rows the streamed history has now confirmed (by oid). */
  readonly confirmOptimisticCommits: (oids: ReadonlyArray<string>) => void;
  readonly clearOptimisticCommits: () => void;
  // ── P3: main view switching ──────────────────────────────────────────────────
  readonly activeView: ActiveView;
  readonly setActiveView: (view: ActiveView) => void;
  // ── P4: cherry-pick / revert / empty-result dialog ───────────────────────────
  readonly pickDialog: PickDialogState;
  readonly setPickDialog: (state: PickDialogState) => void;
  // ── P4: blame overlay ────────────────────────────────────────────────────────
  readonly blameTarget: BlameTarget | null;
  readonly setBlameTarget: (target: BlameTarget | null) => void;
  // ── P4: file-history overlay ─────────────────────────────────────────────────
  readonly historyTarget: HistoryTarget | null;
  readonly setHistoryTarget: (target: HistoryTarget | null) => void;
  // ── P5: repository maintenance (gc) dialog ───────────────────────────────────
  /** Whether the run-maintenance (gc) modal is open (REQ-P5-GC-001). */
  readonly gcDialogOpen: boolean;
  readonly setGcDialogOpen: (open: boolean) => void;
  // ── P5: clean working directory dialog ───────────────────────────────────────
  /** Whether the clean-working-directory modal is open (REQ-P5-CL-001). */
  readonly cleanDialogOpen: boolean;
  readonly setCleanDialogOpen: (open: boolean) => void;
  // ── P5: archive export dialog ────────────────────────────────────────────────
  /**
   * The archive-export dialog, or `null` when closed. `treeish` is the pre-seeded
   * target — empty when launched from the menu (user types a ref), or the commit's oid
   * when launched from a commit's "Archive revision…" (REQ-P5-AR-001).
   */
  readonly archiveDialog: { readonly treeish: string } | null;
  readonly setArchiveDialog: (state: { treeish: string } | null) => void;
  // ── P5: bisect start dialog ──────────────────────────────────────────────────
  /**
   * The start-bisect dialog, or `null` when closed. `bad` pre-seeds the known-bad
   * commit (the selected commit when launched from "Bisect from here"). REQ-P5-BS-001.
   */
  readonly bisectStartDialog: { readonly bad?: Oid } | null;
  readonly setBisectStartDialog: (state: { bad?: Oid } | null) => void;
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
  commitDialogOpen: false,
  keepOpenAfterCommit: readKeepOpen(),
  commitSplit: readCommitSplit(),
  historySplit: readHistorySplit(),
  stagedSelection: new Set(),
  unstagedSelection: new Set(),
  selectedDiffFile: null,
  optimisticCommits: [],
  activeView: "history",
  pickDialog: null,
  blameTarget: null,
  historyTarget: null,
  gcDialogOpen: false,
  cleanDialogOpen: false,
  archiveDialog: null,
  bisectStartDialog: null,
  // Switching repositories supersedes the old selection and filters (P1-OPEN-4 / P1-X-4).
  setActiveRepoId: (activeRepoId) =>
    set({
      activeRepoId,
      selectedOid: null,
      filters: emptyFilters,
      stagedSelection: new Set(),
      unstagedSelection: new Set(),
      selectedDiffFile: null,
      optimisticCommits: [],
      pickDialog: null,
      blameTarget: null,
      historyTarget: null,
      gcDialogOpen: false,
      cleanDialogOpen: false,
      archiveDialog: null,
      bisectStartDialog: null,
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
  updateCommitDraft: (patch) =>
    set((s) => ({ commitDraft: { ...s.commitDraft, ...patch } })),
  resetCommitDraft: () => set({ commitDraft: DEFAULT_DRAFT }),
  setCommitDialogOpen: (commitDialogOpen) => set({ commitDialogOpen }),
  setKeepOpenAfterCommit: (keepOpenAfterCommit) => {
    writeKeepOpen(keepOpenAfterCommit);
    set({ keepOpenAfterCommit });
  },
  setCommitSplit: (commitSplit) => {
    writeCommitSplit(commitSplit);
    set({ commitSplit });
  },
  setHistorySplit: (historySplit) => {
    writeHistorySplit(historySplit);
    set({ historySplit });
  },
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
  clearSelection: () =>
    set({ stagedSelection: new Set(), unstagedSelection: new Set() }),
  setSelectedDiffFile: (selectedDiffFile) => set({ selectedDiffFile }),
  addOptimisticCommit: (commit) =>
    set((s) => ({
      optimisticCommits: [
        commit,
        ...s.optimisticCommits.filter((c) => c.oid !== commit.oid),
      ],
    })),
  confirmOptimisticCommits: (oids) =>
    set((s) => {
      if (s.optimisticCommits.length === 0) return s;
      const confirmed = new Set(oids);
      const next = s.optimisticCommits.filter((c) => !confirmed.has(c.oid));
      // Return the same state ref when nothing changed so subscribers don't re-render.
      return next.length === s.optimisticCommits.length
        ? s
        : { optimisticCommits: next };
    }),
  clearOptimisticCommits: () =>
    set((s) =>
      s.optimisticCommits.length === 0 ? s : { optimisticCommits: [] },
    ),
  setActiveView: (activeView) => set({ activeView }),
  setPickDialog: (pickDialog) => set({ pickDialog }),
  setBlameTarget: (blameTarget) => set({ blameTarget }),
  setHistoryTarget: (historyTarget) => set({ historyTarget }),
  setGcDialogOpen: (gcDialogOpen) => set({ gcDialogOpen }),
  setCleanDialogOpen: (cleanDialogOpen) => set({ cleanDialogOpen }),
  setArchiveDialog: (archiveDialog) => set({ archiveDialog }),
  setBisectStartDialog: (bisectStartDialog) => set({ bisectStartDialog }),
}));
