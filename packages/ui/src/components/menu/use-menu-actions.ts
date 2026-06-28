// Capability layer for the menu (menu-hierarchy.md §"Implementation notes"). Enablement is
// driven from a single registry of wired command handlers — an item is enabled iff a handler
// exists, so unwired commands grey out without per-item conditionals. As later phases land,
// they register handlers here; the menu model and rendering stay untouched.

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { useApi } from "../../rpc/ApiProvider";
import { useRecentList } from "../../rpc/hooks";
import { repoScopeKey } from "../../rpc/query-keys";
import { useNavigation } from "../../state/navigation";
import { useUiStore } from "../../state/store";

export interface DynamicItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
}

export interface MenuActions {
  /** Run a command by id (no-op if it has no wired handler). */
  readonly run: (id: string) => void;
  /** Whether a command/checkbox id has a wired handler (drives the disabled state). */
  readonly isEnabled: (id: string) => boolean;
  /** Checked state for a checkbox item, or undefined when it is not state-bound. */
  readonly checkboxState: (id: string) => boolean | undefined;
  /** Runtime-populated submenu contents, keyed by the submenu's `dynamic` tag. */
  readonly recent: ReadonlyArray<DynamicItem>;
  readonly favorites: ReadonlyArray<DynamicItem>;
}

export function useMenuActions(): MenuActions {
  const navigate = useNavigate();
  const { openRepo } = useNavigation();
  const queryClient = useQueryClient();
  const repoId = useUiStore((s) => s.activeRepoId);
  const selectedOid = useUiStore((s) => s.selectedOid);
  const dateMode = useUiStore((s) => s.dateMode);
  const recentQuery = useRecentList();
  const api = useApi();

  return useMemo(() => {
    // Only wired commands appear here; everything else greys out automatically.
    const handlers: Record<string, () => void> = {
      "start.open": () => useUiStore.getState().setPaletteOpen(true),
      "start.exit": () => navigate("/"),
      "repository.close": () => navigate("/"),
      "help.about": () =>
        toast("cBranch", {
          description: "A desktop-style git client. MIT licensed.",
        }),
    };
    // Repo-scoped commands need an open repository.
    if (repoId) {
      handlers["repository.refresh"] = () =>
        void queryClient.invalidateQueries({
          queryKey: repoScopeKey(repoId),
        });
      handlers["commands.stageAll"] = () =>
        void api
          .stageFiles(repoId, [], true)
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: [repoId, "status"],
            }),
          )
          .catch(() => {});
      handlers["commands.unstageAll"] = () =>
        void api
          .unstageFiles(repoId, [], true)
          .then(() =>
            queryClient.invalidateQueries({
              queryKey: [repoId, "status"],
            }),
          )
          .catch(() => {});
      // Commands → Commit… opens the dedicated commit dialog (commit-surface.md §9.4).
      handlers["commands.commit"] = () =>
        useUiStore.getState().setCommitDialogOpen(true);
      // Repository → Maintenance → Compress opens the gc dialog (REQ-P5-GC-001).
      handlers["repository.maintenance.compress"] = () =>
        useUiStore.getState().setGcDialogOpen(true);
      // Commands → Clean… opens the clean-working-directory dialog (REQ-P5-CL-001).
      handlers["commands.clean"] = () =>
        useUiStore.getState().setCleanDialogOpen(true);
    }
    // Cherry-pick / revert act on the selected commit (REQ-UX-001); the dialog fetches
    // the commit's subject + parents (for the merge-commit mainline gate).
    if (repoId && selectedOid) {
      handlers["commands.cherryPick"] = () =>
        useUiStore.getState().setPickDialog({
          kind: "cherryPick",
          commits: [{ oid: selectedOid, subject: "" }],
        });
      handlers["commands.revert"] = () =>
        useUiStore.getState().setPickDialog({
          kind: "revert",
          commits: [{ oid: selectedOid, subject: "" }],
        });
    }
    // State-bound checkbox: the date column's relative/absolute mode (P1-HIST-8).
    const checkboxes: Record<string, boolean> = {
      "view.showRelativeDate": dateMode === "relative",
    };
    handlers["view.showRelativeDate"] = () =>
      useUiStore
        .getState()
        .setDateMode(dateMode === "relative" ? "absolute" : "relative");

    const recent: DynamicItem[] = (recentQuery.data ?? []).map((r) => ({
      id: r.repoId,
      label: r.name,
      onSelect: () => openRepo(r.repoId),
    }));

    return {
      run: (id) => handlers[id]?.(),
      isEnabled: (id) => id in handlers,
      checkboxState: (id) => checkboxes[id],
      recent,
      favorites: [],
    };
  }, [
    navigate,
    openRepo,
    queryClient,
    repoId,
    selectedOid,
    dateMode,
    recentQuery.data,
    api,
  ]);
}
