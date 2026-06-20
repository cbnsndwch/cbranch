import { type WorktreeInfo, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { useWorktreeAdd, useWorktreeList, useWorktreePrune, useWorktreeRemove } from "../rpc/hooks";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

interface WorktreesPanelProps {
  repoId: RepoId;
}

type AddMode = "new" | "existing";

export function WorktreesPanel({ repoId }: WorktreesPanelProps) {
  const { data: worktrees, isLoading } = useWorktreeList(repoId);
  const addMut = useWorktreeAdd(repoId);
  const removeMut = useWorktreeRemove(repoId);
  const pruneMut = useWorktreePrune(repoId);

  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const [addPath, setAddPath] = useState("");
  const [addMode, setAddMode] = useState<AddMode>("new");
  const [addBranch, setAddBranch] = useState("");
  const [addStart, setAddStart] = useState("");

  const handlePrune = () => {
    pruneMut.mutate(undefined, {
      onSuccess: () => toast.success("Worktrees pruned"),
      onError: (err) => toast.error(String(err)),
    });
  };

  const handleAdd = () => {
    const path = addPath.trim();
    const branch = addBranch.trim();
    if (!path) return;
    const opts =
      addMode === "new"
        ? { newBranch: branch || undefined, startPoint: addStart.trim() || undefined }
        : { branch: branch || undefined };
    addMut.mutate(
      { path, ...opts },
      {
        onSuccess: () => {
          toast.success("Worktree added");
          setAddOpen(false);
          setAddPath("");
          setAddBranch("");
          setAddStart("");
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleRemove = () => {
    if (!removeTarget) return;
    removeMut.mutate(
      { path: removeTarget },
      {
        onSuccess: () => {
          toast.success("Worktree removed");
          setRemoveTarget(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const list = worktrees ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">Worktrees</h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handlePrune}
            disabled={pruneMut.isPending}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px] disabled:opacity-40"
          >
            Prune
          </button>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
          >
            + Add
          </button>
        </div>
      </div>

      {/* Worktree list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <div className="text-muted-foreground px-3 py-4 text-sm">Loading worktrees…</div>}
        {!isLoading && list.length === 0 && (
          <div className="text-muted-foreground px-3 py-4 text-sm">No worktrees found.</div>
        )}
        {list.map((wt) => (
          <WorktreeRow key={wt.path} wt={wt} onRemove={(path) => setRemoveTarget(path)} />
        ))}
      </div>

      {/* Add worktree dialog */}
      <AlertDialog open={addOpen} onOpenChange={setAddOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add Worktree</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Path</span>
              <input
                type="text"
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                placeholder="/path/to/new-worktree"
                className="h-8 w-full border px-2 text-sm"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Mode</span>
              <select
                value={addMode}
                onChange={(e) => setAddMode(e.target.value as AddMode)}
                className="h-8 border px-1 text-sm"
              >
                <option value="new">New branch</option>
                <option value="existing">Existing branch</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">{addMode === "new" ? "New branch name" : "Branch name"}</span>
              <input
                type="text"
                value={addBranch}
                onChange={(e) => setAddBranch(e.target.value)}
                placeholder={addMode === "new" ? "feat/my-feature" : "main"}
                className="h-8 w-full border px-2 text-sm"
              />
            </label>
            {addMode === "new" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Start point (optional)</span>
                <input
                  type="text"
                  value={addStart}
                  onChange={(e) => setAddStart(e.target.value)}
                  placeholder="HEAD"
                  className="h-8 w-full border px-2 text-sm"
                />
              </label>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setAddOpen(false)}>Cancel</AlertDialogClose>
            <AlertDialogAction
              onClick={handleAdd}
              disabled={!addPath.trim() || addMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {addMut.isPending ? "Adding…" : "Add"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove confirm dialog */}
      <DestructiveConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove worktree"
        description={"Remove worktree at " + (removeTarget ?? "") + "? The directory will be deleted."}
        confirmLabel="Remove"
        onConfirm={handleRemove}
      />
    </div>
  );
}

interface WorktreeRowProps {
  wt: WorktreeInfo;
  onRemove: (path: string) => void;
}

function WorktreeRow({ wt, onRemove }: WorktreeRowProps) {
  const shortOid = wt.headOid ? wt.headOid.slice(0, 7) : "—";
  const branchLabel = wt.isDetached ? "detached" : wt.branch ? wt.branch.replace("refs/heads/", "") : "—";
  const badge = wt.isMain ? "main" : wt.isBare ? "bare" : "linked";

  const copyPath = () => {
    void navigator.clipboard.writeText(wt.path);
    toast.success("Path copied");
  };

  return (
    <div className="group hover:bg-accent/50 flex items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs" title={wt.path}>
            {wt.path}
          </span>
          <span className="text-muted-foreground shrink-0 rounded border px-1 text-[9px]">{badge}</span>
          {wt.isLocked && (
            <span
              className="shrink-0 rounded border border-orange-400 px-1 text-[9px] text-orange-600"
              title={wt.lockReason ?? "locked"}
            >
              locked
            </span>
          )}
        </div>
        <div className="text-muted-foreground mt-0.5 flex gap-3 text-[10px]">
          <span>{branchLabel}</span>
          <span className="font-mono">{shortOid}</span>
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="hover:bg-accent flex h-5 w-5 shrink-0 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
          aria-label="Worktree actions"
        >
          …
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          <DropdownMenuItem onClick={copyPath}>Copy path</DropdownMenuItem>
          {!wt.isMain && (
            <DropdownMenuItem variant="destructive" onClick={() => onRemove(wt.path)}>
              Remove
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
