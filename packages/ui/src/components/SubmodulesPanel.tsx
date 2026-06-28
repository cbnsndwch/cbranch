import {
  type RepoId,
  type SubmoduleInfo,
  type SubmoduleStatus,
} from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { useNavigation } from "../state/navigation";
import {
  useOpenRepo,
  useSubmoduleAdd,
  useSubmoduleRemove,
  useSubmodules,
  useSubmoduleSync,
  useSubmoduleUpdate,
} from "../rpc/hooks";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

const short = (oid: string | undefined): string =>
  oid ? oid.slice(0, 7) : "—";

const STATUS_STYLE: Record<SubmoduleStatus, { label: string; cls: string }> = {
  upToDate: { label: "up to date", cls: "border-border text-muted-foreground" },
  uninitialized: {
    label: "uninitialized",
    cls: "border-border text-muted-foreground",
  },
  outOfSync: { label: "out of sync", cls: "border-orange-400 text-orange-600" },
  conflicted: { label: "conflicted", cls: "border-red-400 text-red-600" },
};

function SubmoduleStatusBadge({ status }: { status: SubmoduleStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`rounded border px-1 text-[9px] ${s.cls}`}>{s.label}</span>
  );
}

interface SubmodulesPanelProps {
  repoId: RepoId;
}

export function SubmodulesPanel({ repoId }: SubmodulesPanelProps) {
  const { data: submodules, isLoading } = useSubmodules(repoId);
  const updateMut = useSubmoduleUpdate(repoId);
  const syncMut = useSubmoduleSync(repoId);
  const addMut = useSubmoduleAdd(repoId);
  const removeMut = useSubmoduleRemove(repoId);
  const openMut = useOpenRepo();
  const { openRepo } = useNavigation();

  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [addPath, setAddPath] = useState("");
  const [addBranch, setAddBranch] = useState("");
  const [forceTarget, setForceTarget] = useState<SubmoduleInfo | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const list = submodules ?? [];

  const runUpdate = (sub: SubmoduleInfo, force: boolean) => {
    updateMut.mutate(
      {
        paths: [sub.path],
        init: sub.status === "uninitialized",
        force,
      },
      {
        onSuccess: () =>
          toast.success(
            force ? "Submodule force-updated" : "Submodule updated",
          ),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleSync = (sub: SubmoduleInfo) => {
    syncMut.mutate(
      { paths: [sub.path] },
      {
        onSuccess: () => toast.success("Submodule synchronized"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleOpen = (sub: SubmoduleInfo) => {
    openMut.mutate(sub.absPath, {
      onSuccess: (handle) => openRepo(handle.repoId),
      onError: (err) => toast.error(String(err)),
    });
  };

  const handleUpdateAll = () => {
    updateMut.mutate(
      { init: true },
      {
        onSuccess: () => toast.success("All submodules updated"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleSyncAll = () => {
    syncMut.mutate(
      {},
      {
        onSuccess: () => toast.success("All submodules synchronized"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleAdd = () => {
    const url = addUrl.trim();
    const path = addPath.trim();
    const branch = addBranch.trim();
    if (!url || !path) return;
    addMut.mutate(
      { url, path, branch: branch || undefined },
      {
        onSuccess: () => {
          toast.success("Submodule added");
          setAddOpen(false);
          setAddUrl("");
          setAddPath("");
          setAddBranch("");
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
          toast.success("Submodule removed");
          setRemoveTarget(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">Submodules</h2>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handleUpdateAll}
            disabled={updateMut.isPending}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px] disabled:opacity-40"
          >
            Update all
          </button>
          <button
            type="button"
            onClick={handleSyncAll}
            disabled={syncMut.isPending}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px] disabled:opacity-40"
          >
            Sync all
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

      {/* Submodule table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            Loading submodules…
          </div>
        )}
        {!isLoading && list.length === 0 && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            No submodules.
          </div>
        )}
        {!isLoading && list.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Submodule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Recorded</TableHead>
                <TableHead>Checked out</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((sub) => (
                <SubmoduleRow
                  key={sub.path}
                  sub={sub}
                  onUpdate={(s) => runUpdate(s, false)}
                  onForceUpdate={(s) => setForceTarget(s)}
                  onSync={handleSync}
                  onOpen={handleOpen}
                  onRemove={(s) => setRemoveTarget(s.path)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Add submodule dialog */}
      <AlertDialog open={addOpen} onOpenChange={setAddOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add Submodule</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Repository URL</span>
              <input
                type="text"
                value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)}
                placeholder="https://example.com/lib.git"
                className="h-8 w-full border px-2 text-sm"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Path</span>
              <input
                type="text"
                value={addPath}
                onChange={(e) => setAddPath(e.target.value)}
                placeholder="vendor/lib"
                className="h-8 w-full border px-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Branch (optional)</span>
              <input
                type="text"
                value={addBranch}
                onChange={(e) => setAddBranch(e.target.value)}
                placeholder="main"
                className="h-8 w-full border px-2 text-sm"
              />
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setAddOpen(false)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={handleAdd}
              disabled={!addUrl.trim() || !addPath.trim() || addMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {addMut.isPending ? "Adding…" : "Add"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force-update confirm dialog */}
      <AlertDialog
        open={forceTarget !== null}
        onOpenChange={(open) => {
          if (!open) setForceTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force update submodule</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="py-2 text-sm">
            Force-updating{" "}
            <span className="font-mono">{forceTarget?.path}</span> overwrites
            any local changes in the submodule's working tree.
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setForceTarget(null)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={() => {
                const t = forceTarget;
                setForceTarget(null);
                if (t) runUpdate(t, true);
              }}
            >
              Force update
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
        title="Remove submodule"
        description={
          "Remove submodule at " +
          (removeTarget ?? "") +
          "? It will be deinitialized and removed from the working tree and .gitmodules."
        }
        confirmLabel="Remove"
        onConfirm={handleRemove}
      />
    </div>
  );
}

interface SubmoduleRowProps {
  sub: SubmoduleInfo;
  onUpdate: (sub: SubmoduleInfo) => void;
  onForceUpdate: (sub: SubmoduleInfo) => void;
  onSync: (sub: SubmoduleInfo) => void;
  onOpen: (sub: SubmoduleInfo) => void;
  onRemove: (sub: SubmoduleInfo) => void;
}

function SubmoduleRow({
  sub,
  onUpdate,
  onForceUpdate,
  onSync,
  onOpen,
  onRemove,
}: SubmoduleRowProps) {
  // Open/Sync need a checked-out tree; an uninitialized submodule has neither.
  const initialized = sub.status === "upToDate" || sub.status === "outOfSync";

  return (
    <TableRow className="group">
      <TableCell>
        <div className="flex flex-col">
          <span className="truncate font-mono text-xs" title={sub.path}>
            {sub.path}
          </span>
          {sub.name && sub.name !== sub.path && (
            <span className="text-muted-foreground text-[10px]">
              {sub.name}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell>
        <SubmoduleStatusBadge status={sub.status} />
      </TableCell>
      <TableCell className="font-mono text-[11px]">
        {short(sub.recordedOid)}
      </TableCell>
      <TableCell className="font-mono text-[11px]">
        {short(sub.checkedOutOid)}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="hover:bg-accent flex h-5 w-5 shrink-0 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
            aria-label="Submodule actions"
          >
            …
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="end">
            <DropdownMenuItem onClick={() => onUpdate(sub)}>
              Update
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onForceUpdate(sub)}>
              Force update…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!initialized}
              onClick={() => onSync(sub)}
            >
              Sync
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!initialized}
              onClick={() => onOpen(sub)}
            >
              Open
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onRemove(sub)}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
