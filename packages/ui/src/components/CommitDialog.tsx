// The dedicated stage-&-commit modal dialog (docs/design/commit-surface.md).
//
// This REVERSES the former inline co-resident panels: the full flow — staged/unstaged
// lists, the diff with hunk/line staging, and the message composer — now lives inside
// one blocking modal opened on demand from the toolbar/menu/keyboard. The existing P2
// components are *re-hosted* here, not rebuilt: StatusPanel (changes), WorkingDiffPanel
// (diff + partial staging), and CommitPanel (composer/footer).

import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";
import { useRef } from "react";

import { useRepoState } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { CommitPanel, type CommitPanelHandle } from "./CommitPanel";
import { StatusPanel } from "./StatusPanel";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { ResizableSplit } from "./ui/resizable-split";
import { WorkingDiffPanel } from "./WorkingDiffPanel";

export function CommitDialog() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const open = useUiStore((s) => s.commitDialogOpen);
  const setOpen = useUiStore((s) => s.setCommitDialogOpen);
  const split = useUiStore((s) => s.commitSplit);
  const setSplit = useUiStore((s) => s.setCommitSplit);

  const queryClient = useQueryClient();
  const repoStateQuery = useRepoState(repoId);
  // A mutation in flight (stage/commit/…) blocks dismissal — the only close guard (§2).
  const mutating = useIsMutating() > 0;
  const commitRef = useRef<CommitPanelHandle>(null);

  if (repoId === null) return null;

  const repoState = repoStateQuery.data;
  const branchLabel = repoState?.isDetached
    ? "detached HEAD"
    : (repoState?.currentBranch ?? repoState?.defaultBranch ?? "—");

  const requestClose = () => {
    if (!mutating) setOpen(false);
  };

  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: [repoId, "status"] });
    void queryClient.invalidateQueries({ queryKey: [repoId, "inProgress"] });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      commitRef.current?.commit();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        // Lenient dismissal: no discard prompt (state is durable). Only veto a close
        // while a mutation RPC is in flight (§2).
        if (next) setOpen(true);
        else requestClose();
      }}
    >
      <DialogContent
        onKeyDown={onKeyDown}
        aria-describedby={undefined}
        style={{
          width: "min(1100px, 92vw)",
          height: "min(860px, 88vh)",
          minWidth: "min(720px, 96vw)",
          minHeight: "min(480px, 90vh)",
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <DialogTitle className="truncate">
            Commit — <span className="font-mono">{branchLabel}</span>
          </DialogTitle>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleRefresh}
            aria-label="Refresh status"
            className="hover:bg-accent flex h-6 items-center gap-1 rounded-none border px-1.5 text-[11px]"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            onClick={requestClose}
            disabled={mutating}
            aria-label="Close"
            className="hover:bg-accent flex size-6 items-center justify-center rounded-none border disabled:opacity-40"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Body: changes | diff, resizable (§3) */}
        <ResizableSplit
          className="min-h-0 flex-1"
          fraction={split}
          onFractionChange={setSplit}
          left={
            <div className="h-full overflow-auto border-r">
              <StatusPanel repoId={repoId} />
            </div>
          }
          right={
            <div className="h-full overflow-auto">
              <WorkingDiffPanel repoId={repoId} />
            </div>
          }
        />

        {/* Footer: composer + actions (§3/§4) */}
        <div className="shrink-0 border-t">
          <CommitPanel
            ref={commitRef}
            repoId={repoId}
            autoFocusSubject
            onCommitted={() => setOpen(false)}
            onCancel={requestClose}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
