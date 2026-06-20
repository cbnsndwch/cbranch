import { cn } from "../lib/cn";
import { useInvalidationBus } from "../rpc/use-invalidation-bus";
import { useNavigation } from "../state/navigation";
import { type ActiveView, useUiStore } from "../state/store";
import { BranchesPanel } from "./BranchesPanel";
import { CommandPalette } from "./CommandPalette";
import { CommitDetailsTabs } from "./CommitDetailsTabs";
import { CommitTab } from "./CommitTab";
import { DiffPanel } from "./DiffPanel";
import { DocumentTitle } from "./DocumentTitle";
import { HistoryPane } from "./HistoryPane";
import { HistoryStatusStrip } from "./HistoryStatusStrip";
import { MenuBar } from "./MenuBar";
import { RepositorySidebar } from "./RepositorySidebar";
import { StagingView } from "./StagingView";
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
  // Commit selection writes the URL (D13); the store mirrors it via <SyncRouteToStore>.
  const { selectOid } = useNavigation();

  // Live updates: subscribe to the host invalidation bus for the active repo.
  useInvalidationBus(repoId);

  const detailContent = (() => {
    if (!repoId)
      return <Placeholder>Select a commit to see its details.</Placeholder>;
    switch (detailTab) {
      case "changes":
        return <StagingView repoId={repoId} />;
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

      {/* Headless: reflects the active branch in the browser window title (no in-app title bar). */}
      <DocumentTitle />

      <div className="grid h-dvh grid-rows-[24px_32px_28px_1fr] overflow-hidden">
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
