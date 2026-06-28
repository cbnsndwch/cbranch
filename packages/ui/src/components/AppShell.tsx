import { useState } from "react";

import { cn } from "../lib/cn";
import { useRepoState } from "../rpc/hooks";
import { useInvalidationBus } from "../rpc/use-invalidation-bus";
import { useNavigation } from "../state/navigation";
import { type ActiveView, useUiStore } from "../state/store";
import { BlamePanel } from "./BlamePanel";
import { BranchesPanel } from "./BranchesPanel";
import { CommandPalette } from "./CommandPalette";
import { CommitDetailsTabs } from "./CommitDetailsTabs";
import { ArchiveDialog } from "./ArchiveDialog";
import { BisectBanner } from "./BisectBanner";
import { BisectStartDialog } from "./BisectStartDialog";
import { CleanDialog } from "./CleanDialog";
import { ReflogPanel } from "./ReflogPanel";
import { CommitDialog } from "./CommitDialog";
import { GcDialog } from "./GcDialog";
import { CommitTab } from "./CommitTab";
import { ConflictsPanel } from "./ConflictsPanel";
import { DiffPanel } from "./DiffPanel";
import { DocumentTitle } from "./DocumentTitle";
import { FileHistoryPanel } from "./FileHistoryPanel";
import { HistoryPane } from "./HistoryPane";
import { HistoryStatusStrip } from "./HistoryStatusStrip";
import { MergeEditor } from "./MergeEditor";
import { MenuBar } from "./MenuBar";
import { RepositorySidebar } from "./RepositorySidebar";
import { PickDialogs } from "./SequencerDialogs";
import { SettingsDialog } from "./SettingsDialog";
import { StashPanel } from "./StashPanel";
import { SubmodulesPanel } from "./SubmodulesPanel";
import { TagsPanel } from "./TagsPanel";
import { Toolbar } from "./Toolbar";
import { Button } from "./ui/button";
import { Placeholder } from "./ui/placeholder";
import { ResizableSplit } from "./ui/resizable-split";
import { WorktreesPanel } from "./WorktreesPanel";

const VIEWS: ReadonlyArray<readonly [ActiveView, string]> = [
  ["history", "History"],
  ["branches", "Branches"],
  ["worktrees", "Worktrees"],
  ["stash", "Stash"],
  ["tags", "Tags"],
  ["reflog", "Reflog"],
  ["submodules", "Submodules"],
];

// Web layout: menu bar → toolbar → view nav → main split (sidebar + content). There is no
// in-app title bar — <DocumentTitle> reflects the active branch in the browser window title.
export function AppShell() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const selectedOid = useUiStore((s) => s.selectedOid);
  const detailTab = useUiStore((s) => s.detailTab);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openPalette = useUiStore((s) => s.setPaletteOpen);
  const blameTarget = useUiStore((s) => s.blameTarget);
  const setBlameTarget = useUiStore((s) => s.setBlameTarget);
  const historyTarget = useUiStore((s) => s.historyTarget);
  const setHistoryTarget = useUiStore((s) => s.setHistoryTarget);
  const historySplit = useUiStore((s) => s.historySplit);
  const setHistorySplit = useUiStore((s) => s.setHistorySplit);
  // Commit selection writes the URL (D13); the store mirrors it via <SyncRouteToStore>.
  const { selectOid } = useNavigation();

  // The conflicted path open in the 3-way merge editor (UI-B), if any.
  const [editPath, setEditPath] = useState<string | null>(null);

  // Live updates: subscribe to the host invalidation bus for the active repo.
  useInvalidationBus(repoId);

  // Surface the Conflicts view whenever an operation that can leave conflicts is in
  // progress for the active repo (merge / rebase / cherry-pick / revert / am / bisect).
  const inProgress = useRepoState(repoId).data?.inProgress ?? "none";
  const showConflicts = inProgress !== "none";

  // The commit-dialog shortcut (Ctrl/Cmd+Shift+Enter) now rides the central keybinding
  // dispatcher (App → useKeybindings), so AppShell no longer installs its own listener.

  const detailContent = (() => {
    if (!repoId)
      return <Placeholder>Select a commit to see its details.</Placeholder>;
    switch (detailTab) {
      case "commit":
        return (
          <CommitTab
            repoId={repoId}
            oid={selectedOid}
            onSelectOid={selectOid}
          />
        );
      case "diff":
        return <DiffPanel repoId={repoId} oid={selectedOid} />;
      default:
        return (
          <Placeholder>
            {detailTab.charAt(0).toUpperCase() + detailTab.slice(1)} — coming in
            a later milestone.
          </Placeholder>
        );
    }
  })();

  const mainContent = (() => {
    if (!repoId) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3">
          <p className="text-muted-foreground text-sm">
            Open a repository to start browsing.
          </p>
          <Button onClick={() => openPalette(true)}>Open a repository</Button>
        </div>
      );
    }
    switch (activeView) {
      case "solveConflicts":
        return <ConflictsPanel repoId={repoId} onEdit={setEditPath} />;
      case "branches":
        return <BranchesPanel repoId={repoId} />;
      case "worktrees":
        return <WorktreesPanel repoId={repoId} />;
      case "stash":
        return <StashPanel repoId={repoId} />;
      case "tags":
        return <TagsPanel repoId={repoId} />;
      case "reflog":
        return <ReflogPanel repoId={repoId} onSelectOid={selectOid} />;
      case "submodules":
        return <SubmodulesPanel repoId={repoId} />;
      default:
        return (
          <div className="grid min-h-0 grid-rows-[46px_1fr]">
            {/* Status strip */}
            <HistoryStatusStrip repoId={repoId} />
            {/* History list over commit details, divided by a draggable splitter. */}
            <ResizableSplit
              orientation="vertical"
              className="min-h-0"
              fraction={historySplit}
              onFractionChange={setHistorySplit}
              min={0.2}
              max={0.8}
              label="Resize history and commit details"
              left={
                <HistoryPane
                  repoId={repoId}
                  selectedOid={selectedOid}
                  onSelectOid={selectOid}
                />
              }
              right={
                <div className="grid h-full min-h-0 grid-rows-[28px_1fr]">
                  {/* Detail tabs */}
                  <CommitDetailsTabs />
                  {/* Detail content */}
                  <div className="min-h-0 overflow-hidden">{detailContent}</div>
                </div>
              }
            />
          </div>
        );
    }
  })();

  return (
    <>
      <CommandPalette />
      <CommitDialog />
      <PickDialogs />
      <GcDialog />
      <CleanDialog />
      <ArchiveDialog />
      <SettingsDialog />
      {repoId && <BisectStartDialog repoId={repoId} onSelectOid={selectOid} />}
      {repoId && editPath !== null && (
        <MergeEditor
          repoId={repoId}
          path={editPath}
          onClose={() => setEditPath(null)}
        />
      )}
      {repoId && blameTarget !== null && (
        <BlamePanel
          repoId={repoId}
          rev={blameTarget.rev}
          path={blameTarget.path}
          onClose={() => setBlameTarget(null)}
          onOpenCommit={selectOid}
        />
      )}
      {repoId && historyTarget !== null && (
        <FileHistoryPanel
          repoId={repoId}
          path={historyTarget.path}
          startRev={historyTarget.startRev}
          onClose={() => setHistoryTarget(null)}
          onOpenCommit={selectOid}
          onBlame={setBlameTarget}
        />
      )}

      {/* Headless: reflects the active branch in the browser window title (no in-app title bar). */}
      <DocumentTitle />

      <div className="grid h-dvh grid-rows-[24px_auto_1fr] overflow-hidden">
        {/* Row 1: Menu bar */}
        <MenuBar />

        {/* Row 2: Toolbar */}
        <Toolbar />

        {/* Row 3: Main split — sidebar beside (view nav tabs over content). The
            tabs scope the right-hand graph only, so they live above it rather
            than spanning the full width over the sidebar too. */}
        <div className="flex min-h-0 flex-col">
          {/* Persistent bisect banner (REQ-P5-BS-002), above the sidebar + content. */}
          {repoId && <BisectBanner repoId={repoId} onSelectOid={selectOid} />}
          <div className="grid min-h-0 flex-1 grid-cols-[265px_1fr]">
            {/* Left: Repository sidebar (spans the full content height) */}
            <RepositorySidebar repoId={repoId} />
            {/* Right: view nav tabs over view content */}
            <div className="grid min-h-0 grid-rows-[28px_1fr]">
              {/* View nav tabs */}
              <div className="bg-muted flex items-end border-b">
                {VIEWS.map(([view, label]) => (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setActiveView(view)}
                    className={cn(
                      "px-3 py-0.5 text-[11px]",
                      view === activeView
                        ? "relative -mb-px border border-b-background bg-background font-medium"
                        : "text-muted-foreground hover:bg-accent/50",
                    )}
                  >
                    {label}
                  </button>
                ))}
                {showConflicts && (
                  <button
                    type="button"
                    onClick={() => setActiveView("solveConflicts")}
                    className={cn(
                      "px-3 py-0.5 text-[11px]",
                      activeView === "solveConflicts"
                        ? "relative -mb-px border border-b-background bg-background font-medium"
                        : "text-status-behind hover:bg-accent/50",
                    )}
                  >
                    Conflicts
                  </button>
                )}
              </div>
              {/* View content */}
              {mainContent}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
