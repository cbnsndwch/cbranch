import { type BranchInfo, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "../lib/cn";
import {
  useBranchCreate,
  useBranchDelete,
  useBranchList,
  useBranchRename,
  useBranchSwitch,
} from "../rpc/hooks";
import { RemotesManagerDialog } from "./RemotesManagerDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type Dialog =
  | { kind: "create" }
  | { kind: "rename"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "dirtyTree"; target: string }
  | null;

interface BranchesPanelProps {
  repoId: RepoId;
}

export function BranchesPanel({ repoId }: BranchesPanelProps) {
  const { data: listing, isLoading, error } = useBranchList(repoId);
  const [dialog, setDialog] = useState<Dialog>(null);

  const createMut = useBranchCreate(repoId);
  const renameMut = useBranchRename(repoId);
  const deleteMut = useBranchDelete(repoId);
  const switchMut = useBranchSwitch(repoId);

  const [remotesOpen, setRemotesOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createStart, setCreateStart] = useState("HEAD");
  const [createSwitch, setCreateSwitch] = useState(true);
  const [createUpstream, setCreateUpstream] = useState(false);
  const [renameNew, setRenameNew] = useState("");

  const openCreate = () => {
    setCreateName("");
    setCreateStart("HEAD");
    setCreateSwitch(true);
    setCreateUpstream(false);
    setDialog({ kind: "create" });
  };

  const handleCreate = () => {
    createMut.mutate(
      {
        name: createName.trim(),
        startPoint: createStart.trim() || undefined,
        setUpstream: createUpstream,
        switchAfter: createSwitch,
      },
      {
        onSuccess: () => {
          toast.success("Branch created");
          setDialog(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const openRename = (name: string) => {
    setRenameNew(name);
    setDialog({ kind: "rename", name });
  };

  const handleRename = () => {
    if (dialog?.kind !== "rename") return;
    renameMut.mutate(
      { oldName: dialog.name, newName: renameNew.trim() },
      {
        onSuccess: () => {
          toast.success("Branch renamed");
          setDialog(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const openDelete = (name: string) => setDialog({ kind: "delete", name });

  const handleDelete = (force: boolean) => {
    if (dialog?.kind !== "delete") return;
    deleteMut.mutate(
      { name: dialog.name, force },
      {
        onSuccess: () => {
          toast.success("Branch deleted");
          setDialog(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleSwitch = (target: string) => {
    switchMut.mutate(
      { target },
      {
        onError: (err) => {
          const msg = String(err);
          if (
            msg.includes("would be overwritten") ||
            msg.includes("dirtyWorkingTree")
          ) {
            setDialog({ kind: "dirtyTree", target });
          } else {
            toast.error(msg);
          }
        },
      },
    );
  };

  const handleDirtyTreeStrategy = (strategy: "stash" | "carry" | "discard") => {
    if (dialog?.kind !== "dirtyTree") return;
    const target = dialog.target;
    switchMut.mutate(
      {
        target,
        strategy,
        stashAndReapply: strategy === "stash" ? false : undefined,
      },
      {
        onSuccess: () => {
          toast.success("Switched to " + target);
          setDialog(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-muted-foreground text-sm">Loading branches…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-destructive text-sm">
          Failed to load branches
        </span>
      </div>
    );
  }

  const localBranches = listing?.localBranches ?? [];
  const remoteBranches = listing?.remoteBranches ?? [];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">Branches</h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => setRemotesOpen(true)}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
          >
            Remotes
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
          >
            + New
          </button>
        </div>
      </div>

      {/* Branch list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Local branches */}
        <div>
          <div className="bg-muted text-muted-foreground sticky top-0 px-3 py-0.5 text-[10px] font-medium tracking-wider uppercase">
            Local ({localBranches.length})
          </div>
          {localBranches.map((branch) => (
            <BranchRow
              key={branch.fullRef}
              branch={branch}
              onSwitch={handleSwitch}
              onRename={openRename}
              onDelete={openDelete}
            />
          ))}
          {localBranches.length === 0 && (
            <div className="text-muted-foreground px-3 py-2 text-[11px]">
              No local branches
            </div>
          )}
        </div>

        {/* Remote branches */}
        {remoteBranches.length > 0 && (
          <div>
            <div className="bg-muted text-muted-foreground sticky top-0 px-3 py-0.5 text-[10px] font-medium tracking-wider uppercase">
              Remote ({remoteBranches.length})
            </div>
            {remoteBranches.map((branch) => (
              <BranchRow
                key={branch.fullRef}
                branch={branch}
                onSwitch={handleSwitch}
                onRename={openRename}
                onDelete={openDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create dialog */}
      <AlertDialog
        open={dialog?.kind === "create"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New branch</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Branch name</span>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="feature/my-branch"
                className="h-8 w-full border px-2 text-sm"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Start point</span>
              <input
                type="text"
                value={createStart}
                onChange={(e) => setCreateStart(e.target.value)}
                placeholder="HEAD"
                className="h-8 w-full border px-2 text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={createSwitch}
                onChange={(e) => setCreateSwitch(e.target.checked)}
              />
              Switch to this branch
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={createUpstream}
                onChange={(e) => setCreateUpstream(e.target.checked)}
              />
              Set upstream tracking
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setDialog(null)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={handleCreate}
              disabled={!createName.trim() || createMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {createMut.isPending ? "Creating…" : "Create"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename dialog */}
      <AlertDialog
        open={dialog?.kind === "rename"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename branch</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.kind === "rename" ? `Renaming "${dialog.name}"` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">New name</span>
              <input
                type="text"
                value={renameNew}
                onChange={(e) => setRenameNew(e.target.value)}
                className="h-8 w-full border px-2 text-sm"
                autoFocus
              />
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setDialog(null)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={handleRename}
              disabled={!renameNew.trim() || renameMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {renameMut.isPending ? "Renaming…" : "Rename"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm dialog */}
      <AlertDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete branch</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.kind === "delete"
                ? `Delete branch "${dialog.name}"? This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setDialog(null)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={() => handleDelete(false)}
              disabled={deleteMut.isPending}
            >
              Delete
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => handleDelete(true)}
              disabled={deleteMut.isPending}
            >
              Force delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remotes manager dialog */}
      <RemotesManagerDialog
        repoId={repoId}
        open={remotesOpen}
        onOpenChange={setRemotesOpen}
      />

      {/* Dirty tree dialog */}
      <AlertDialog
        open={dialog?.kind === "dirtyTree"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uncommitted changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have local changes. How do you want to handle them when
              switching branches?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setDialog(null)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={() => handleDirtyTreeStrategy("stash")}
              disabled={switchMut.isPending}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/90"
            >
              Stash
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => handleDirtyTreeStrategy("carry")}
              disabled={switchMut.isPending}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/90"
            >
              Carry over
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => handleDirtyTreeStrategy("discard")}
              disabled={switchMut.isPending}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface BranchRowProps {
  branch: BranchInfo;
  onSwitch: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
}

function BranchRow({ branch, onSwitch, onRename, onDelete }: BranchRowProps) {
  return (
    <div
      className={cn(
        "group flex items-center px-3 py-1.5 hover:bg-accent/50",
        branch.isCurrent && "bg-accent/30",
      )}
    >
      <span className="text-primary mr-2 w-2 text-xs">
        {branch.isCurrent ? "●" : ""}
      </span>
      <span className="flex-1 truncate font-mono text-xs">{branch.name}</span>
      {branch.upstream && (
        <span className="mr-2 flex gap-1 text-[10px]">
          {branch.upstream.ahead > 0 && (
            <span className="text-green-600">
              {"+" + String(branch.upstream.ahead)}
            </span>
          )}
          {branch.upstream.behind > 0 && (
            <span className="text-orange-500">
              {"-" + String(branch.upstream.behind)}
            </span>
          )}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          className="hover:bg-accent flex h-5 w-5 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
          aria-label="Branch actions"
        >
          …
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          {!branch.isCurrent && !branch.isRemote && (
            <DropdownMenuItem onClick={() => onSwitch(branch.name)}>
              Switch to
            </DropdownMenuItem>
          )}
          {!branch.isRemote && (
            <>
              <DropdownMenuItem onClick={() => onRename(branch.name)}>
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(branch.name)}
              >
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
