import { Group, Panel, Separator } from "react-resizable-panels";

import { useInvalidationBus } from "../rpc/use-invalidation-bus";
import { useUiStore } from "../state/store";
import { DetailsPanel } from "./DetailsPanel";
import { DiffPanel } from "./DiffPanel";
import { HistoryPane } from "./HistoryPane";
import { StatusSummary } from "./StatusSummary";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "./ui/button";

// The read-only browse layout (P1-UI-*): a resizable history pane beside a stacked
// details + diff pane, under a top bar carrying the status summary and the switcher
// trigger. One repository at a time (P1-OPEN-4).
export function AppShell() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const selectedOid = useUiStore((s) => s.selectedOid);
  const setSelectedOid = useUiStore((s) => s.setSelectedOid);
  const openPalette = useUiStore((s) => s.setPaletteOpen);

  // Live updates: subscribe to the host invalidation bus for the active repo (spec 15).
  useInvalidationBus(repoId);

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-3 border-b px-3 py-2">
        <button type="button" onClick={() => openPalette(true)} className="text-sm font-semibold">
          cbranch
        </button>
        {repoId ? (
          <StatusSummary repoId={repoId} />
        ) : (
          <span className="text-muted-foreground text-xs">No repository open</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={() => openPalette(true)}>Open / switch</Button>
          <ThemeToggle />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {repoId ? (
          <Group orientation="horizontal" className="h-full">
            <Panel defaultSize="55%" minSize="30%">
              <HistoryPane repoId={repoId} selectedOid={selectedOid} onSelectOid={setSelectedOid} />
            </Panel>
            <Separator className="bg-border w-px" />
            <Panel defaultSize="45%" minSize="25%">
              <Group orientation="vertical" className="h-full">
                <Panel defaultSize="45%" minSize="20%">
                  <DetailsPanel repoId={repoId} oid={selectedOid} onSelectOid={setSelectedOid} />
                </Panel>
                <Separator className="bg-border h-px" />
                <Panel defaultSize="55%" minSize="20%">
                  <DiffPanel repoId={repoId} oid={selectedOid} />
                </Panel>
              </Group>
            </Panel>
          </Group>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-muted-foreground text-sm">Open a repository to start browsing.</p>
            <Button onClick={() => openPalette(true)}>Open a repository</Button>
          </div>
        )}
      </div>
    </div>
  );
}
