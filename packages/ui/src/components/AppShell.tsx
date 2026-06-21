import { useEffect, useState } from "react";

import { cn } from "../lib/cn";
import { useRepoState } from "../rpc/hooks";
import { useInvalidationBus } from "../rpc/use-invalidation-bus";
import { useNavigation } from "../state/navigation";
import { type ActiveView, useUiStore } from "../state/store";
import { BlamePanel } from "./BlamePanel";
import { BranchesPanel } from "./BranchesPanel";
import { CommandPalette } from "./CommandPalette";
import { CommitDetailsTabs } from "./CommitDetailsTabs";
import { CommitDialog } from "./CommitDialog";
import { CommitTab } from "./CommitTab";
import { ConflictsPanel } from "./ConflictsPanel";
import { DiffPanel } from "./DiffPanel";
import { DocumentTitle } from "./DocumentTitle";
import { HistoryPane } from "./HistoryPane";
import { HistoryStatusStrip } from "./HistoryStatusStrip";
import { MergeEditor } from "./MergeEditor";
import { MenuBar } from "./MenuBar";
import { RepositorySidebar } from "./RepositorySidebar";
import { PickDialogs } from "./SequencerDialogs";
import { StashPanel } from "./StashPanel";
import { TagsPanel } from "./TagsPanel";
import { Toolbar } from "./Toolbar";
import { Button } from "./ui/button";
import { Placeholder } from "./ui/placeholder";
import { WorktreesPanel } from "./WorktreesPanel";

const VIEWS: ReadonlyArray<readonly [ActiveView, string]> = [
  ["history", "History"],
  ["branches", "Branches"],
  ["worktrees", "Worktrees"],
  ["stash", "Stash"],
  ["tags", "Tags"],
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
  const setCommitDialogOpen = useUiStore((s) => s.setCommitDialogOpen);
  const blameTarget = useUiStore((s) => s.blameTarget);
  const setBlameTarget = useUiStore((s) => s.setBlameTarget);
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

  // Global shortcut to open the commit dialog (docs/design/commit-surface.md §6:
  // Ctrl/Cmd+Shift+Enter). Ctrl/Cmd+Enter is reserved for committing inside the dialog.
  useEffect(() => {
    if (!repoId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        setCommitDialogOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [repoId, setCommitDialogOpen]);

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
      default:
        return (
          <div className="grid min-h-0 grid-rows-[46px_minmax(200px,55%)_6px_28px_1fr]">
            {/* Status strip */}
            <HistoryStatusStrip repoId={repoId} />
            {/* History list */}
            <div className="min-h-0 overflow-hidden">
              <HistoryPane
                repoId={repoId}
                selectedOid={selectedOid}
                onSelectOid={selectOid}
              />
            </div>
            {/* Splitter visual */}
            <div className="border-t" />
            {/* Detail tabs */}
            <CommitDetailsTabs />
            {/* Detail content */}
            <div className="min-h-0 overflow-hidden">{detailContent}</div>
          </div>
        );
    }
  })();

  return (
    <>
      <CommandPalette />
      <CommitDialog />
      <PickDialogs />
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

      {/* Headless: reflects the active branch in the browser window title (no in-app title bar). */}
      <DocumentTitle />

      <div className="grid h-dvh grid-rows-[24px_auto_28px_1fr] overflow-hidden">
        {/* Row 1: Menu bar */}
        <MenuBar />

        {/* Row 2: Toolbar */}
        <Toolbar />

        {/* Row 3: View nav tabs */}
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
        {/* Row 4: Main split */}
        <div className="grid min-h-0 grid-cols-[265px_1fr]">
          {/* Left: Repository sidebar */}
          <RepositorySidebar repoId={repoId} />
          {/* Right: View content */}
          {mainContent}
        </div>
      </div>
    </>
  );
}
