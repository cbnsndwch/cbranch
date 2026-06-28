import { type BranchInfo, type RepoId } from "@cbranch/rpc-contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "../lib/cn";
import { useApi } from "../rpc/ApiProvider";
import {
  useBranchCheckoutDetached,
  useBranchCreate,
  useBranchDelete,
  useBranchList,
  useBranchRename,
  useBranchSetUpstream,
  useBranchSwitch,
  useMergeCreate,
  usePushDeleteRemoteRef,
  useRemoteList,
} from "../rpc/hooks";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
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

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 22;

type Dialog =
  | { kind: "create" }
  | { kind: "rename"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "dirtyTree"; target: string }
  | { kind: "confirmDiscard"; target: string }
  | { kind: "setUpstream"; name: string; current: string }
  | { kind: "deleteRemote"; remote: string; ref: string; label: string }
  | null;

// A branch that tracks a remote — either a remote-tracking ref directly, or a
// local branch with an upstream — can be deleted on the remote (UI-002). The
// remote-side ref name drops the `<remote>/` prefix so the delete-push targets
// the right branch.
function splitRemoteRef(
  branch: BranchInfo,
): { remote: string; ref: string } | null {
  if (branch.isRemote && branch.remoteName) {
    const prefix = branch.remoteName + "/";
    const ref = branch.name.startsWith(prefix)
      ? branch.name.slice(prefix.length)
      : branch.name;
    return { remote: branch.remoteName, ref };
  }
  if (branch.upstream) {
    const idx = branch.upstream.name.indexOf("/");
    if (idx > 0) {
      return {
        remote: branch.upstream.name.slice(0, idx),
        ref: branch.upstream.name.slice(idx + 1),
      };
    }
  }
  return null;
}

interface BranchesPanelProps {
  repoId: RepoId;
}

// The local/remote branch lists are virtualized (UI-001 / NF-PERF-3): only the
// visible window of rows renders, the two groups are collapsible, and tracking
// branches surface their ahead/behind divergence and upstream label inline.
export function BranchesPanel({ repoId }: BranchesPanelProps) {
  const { data: listing, isLoading, error } = useBranchList(repoId);
  const { data: remotes } = useRemoteList(repoId);
  const api = useApi();
  const [dialog, setDialog] = useState<Dialog>(null);

  const createMut = useBranchCreate(repoId);
  const renameMut = useBranchRename(repoId);
  const deleteMut = useBranchDelete(repoId);
  const switchMut = useBranchSwitch(repoId);
  const setUpstreamMut = useBranchSetUpstream(repoId);
  const mergeMut = useMergeCreate(repoId);
  const deleteRemoteMut = usePushDeleteRemoteRef(repoId);
  const detachMut = useBranchCheckoutDetached(repoId);

  const defaultRemote = remotes?.[0]?.name ?? "origin";

  const [remotesOpen, setRemotesOpen] = useState(false);
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const [remoteCollapsed, setRemoteCollapsed] = useState(false);

  const [createName, setCreateName] = useState("");
  const [createStart, setCreateStart] = useState("HEAD");
  const [createSwitch, setCreateSwitch] = useState(true);
  const [createUpstream, setCreateUpstream] = useState(false);
  const [renameNew, setRenameNew] = useState("");
  const [upstreamRef, setUpstreamRef] = useState("");
  const [stashReapply, setStashReapply] = useState(true);

  // A single in-flight streaming sync (push/pull) per panel, mirroring the
  // Toolbar's progress-toast pattern; the subscription is torn down on unmount.
  const syncUnsubRef = useRef<(() => void) | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  useEffect(() => () => syncUnsubRef.current?.(), []);

  const openCreate = (startPoint = "HEAD") => {
    setCreateName("");
    setCreateStart(startPoint);
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

  const openSetUpstream = (branch: BranchInfo) => {
    setUpstreamRef(branch.upstream?.name ?? "");
    setDialog({ kind: "setUpstream", name: branch.name, current: "" });
  };

  const handleSetUpstream = () => {
    if (dialog?.kind !== "setUpstream") return;
    setUpstreamMut.mutate(
      { name: dialog.name, upstream: upstreamRef.trim() || undefined },
      {
        onSuccess: () => {
          toast.success("Upstream updated");
          setDialog(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleMerge = (branch: BranchInfo) => {
    mergeMut.mutate(
      { ref: branch.name, strategy: "ff" },
      {
        onSuccess: () => toast.success("Merged " + branch.name),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const openDeleteRemote = (branch: BranchInfo) => {
    const target = splitRemoteRef(branch);
    if (!target) return;
    setDialog({
      kind: "deleteRemote",
      remote: target.remote,
      ref: target.ref,
      label: target.remote + "/" + target.ref,
    });
  };

  const handleDeleteRemote = () => {
    if (dialog?.kind !== "deleteRemote") return;
    deleteRemoteMut.mutate(
      { remote: dialog.remote, ref: dialog.ref, refType: "branch" },
      {
        onSuccess: () => {
          toast.success("Deleted remote branch");
          setDialog(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleDetach = (ref: string) => {
    detachMut.mutate(
      { ref },
      {
        onSuccess: () => toast.success("Checked out " + ref + " (detached)"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleSwitch = (target: string) => {
    switchMut.mutate(
      { target },
      {
        onError: (err) => {
          // The engine machine-detects a dirty-tree refusal and returns a typed
          // `dirtyWorkingTree` (NF-GIT-3) — branch on the error CODE, not git's stderr.
          if ((err as { code?: unknown }).code === "dirtyWorkingTree") {
            setStashReapply(true);
            setDialog({ kind: "dirtyTree", target });
          } else {
            toast.error(String(err));
          }
        },
      },
    );
  };

  const runSwitchStrategy = (
    target: string,
    strategy: "stash" | "carry" | "discard",
  ) => {
    switchMut.mutate(
      {
        target,
        strategy,
        stashAndReapply: strategy === "stash" ? stashReapply : undefined,
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

  // ── streaming push / pull for a single branch (UI-002) ──────────────────────
  const runSync = (
    label: string,
    start: (handlers: {
      onItem: (item: unknown) => void;
      onComplete: () => void;
      onError: (err: unknown) => void;
    }) => () => void,
  ) => {
    if (syncRunning) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    setSyncRunning(true);
    const toastId = "branch-sync";
    toast.loading(label + "…", { id: toastId });
    syncUnsubRef.current = start({
      onItem: (item) => {
        const ev = item as { _tag: string; text?: string };
        if (ev._tag === "progress" && ev.text) {
          toast.loading(ev.text.trim() || label + "…", { id: toastId });
        }
      },
      onComplete: () => {
        setSyncRunning(false);
        syncUnsubRef.current = null;
        toast.success(label + " complete", { id: toastId });
      },
      onError: (err) => {
        setSyncRunning(false);
        syncUnsubRef.current = null;
        toast.error(label + " failed: " + String(err), { id: toastId });
      },
    });
  };

  const handlePush = (branch: BranchInfo) => {
    const remote = splitRemoteRef(branch)?.remote ?? defaultRemote;
    runSync("Pushing " + branch.name, (handlers) =>
      api.pushStream(
        repoId,
        remote,
        { branch: branch.name, setUpstream: !branch.upstream },
        handlers,
      ),
    );
  };

  const handlePull = (branch: BranchInfo) => {
    runSync("Pulling " + branch.name, (handlers) =>
      api.pullStream(repoId, "ff-only", {}, handlers),
    );
  };

  const localBranches = listing?.localBranches ?? [];
  const remoteBranches = listing?.remoteBranches ?? [];

  // Flatten the two groups (plus their headers) into a single virtualized list so
  // a repo with thousands of refs still renders only the visible window.
  type Row =
    | {
        kind: "header";
        group: "local" | "remote";
        label: string;
        count: number;
        collapsed: boolean;
      }
    | { kind: "branch"; branch: BranchInfo }
    | { kind: "empty"; text: string };

  const rows = useMemo<ReadonlyArray<Row>>(() => {
    const out: Row[] = [];
    out.push({
      kind: "header",
      group: "local",
      label: "Local",
      count: localBranches.length,
      collapsed: localCollapsed,
    });
    if (!localCollapsed) {
      if (localBranches.length === 0) {
        out.push({ kind: "empty", text: "No local branches" });
      } else {
        for (const branch of localBranches)
          out.push({ kind: "branch", branch });
      }
    }
    if (remoteBranches.length > 0) {
      out.push({
        kind: "header",
        group: "remote",
        label: "Remote",
        count: remoteBranches.length,
        collapsed: remoteCollapsed,
      });
      if (!remoteCollapsed) {
        for (const branch of remoteBranches)
          out.push({ kind: "branch", branch });
      }
    }
    return out;
  }, [localBranches, remoteBranches, localCollapsed, remoteCollapsed]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      rows[index]?.kind === "branch" ? ROW_HEIGHT : HEADER_HEIGHT,
    overscan: 12,
  });

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
            onClick={() => openCreate()}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
          >
            + New
          </button>
        </div>
      </div>

      {/* Virtualized branch list */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            return (
              <div
                key={item.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === "header" ? (
                  <button
                    type="button"
                    onClick={() =>
                      row.group === "local"
                        ? setLocalCollapsed((v) => !v)
                        : setRemoteCollapsed((v) => !v)
                    }
                    className="bg-muted text-muted-foreground hover:bg-accent flex h-full w-full items-center gap-1 px-2 text-[10px] font-medium tracking-wider uppercase"
                    aria-expanded={!row.collapsed}
                  >
                    {row.collapsed ? (
                      <ChevronRight className="size-3" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="size-3" aria-hidden="true" />
                    )}
                    {row.label} ({row.count})
                  </button>
                ) : row.kind === "empty" ? (
                  <div className="text-muted-foreground px-3 py-2 text-[11px]">
                    {row.text}
                  </div>
                ) : (
                  <BranchRow
                    branch={row.branch}
                    syncDisabled={syncRunning}
                    onSwitch={handleSwitch}
                    onRename={openRename}
                    onDelete={openDelete}
                    onCreateFrom={(name) => openCreate(name)}
                    onSetUpstream={openSetUpstream}
                    onMerge={handleMerge}
                    onDeleteRemote={openDeleteRemote}
                    onPush={handlePush}
                    onPull={handlePull}
                    onDetach={handleDetach}
                  />
                )}
              </div>
            );
          })}
        </div>
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

      {/* Set upstream dialog */}
      <AlertDialog
        open={dialog?.kind === "setUpstream"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Set upstream</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.kind === "setUpstream"
                ? `Track a remote ref for "${dialog.name}"`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">
                Upstream ref (e.g. origin/main)
              </span>
              <input
                type="text"
                value={upstreamRef}
                onChange={(e) => setUpstreamRef(e.target.value)}
                placeholder="origin/main"
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
              onClick={handleSetUpstream}
              disabled={setUpstreamMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {setUpstreamMut.isPending ? "Saving…" : "Save"}
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

      {/* Delete remote branch confirm */}
      <DestructiveConfirmDialog
        open={dialog?.kind === "deleteRemote"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Delete remote branch"
        description={
          dialog?.kind === "deleteRemote"
            ? `Delete "${dialog.label}" on the remote? This pushes a deletion and cannot be undone.`
            : ""
        }
        confirmLabel="Delete remote branch"
        onConfirm={handleDeleteRemote}
      />

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
          <div className="py-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={stashReapply}
                onChange={(e) => setStashReapply(e.target.checked)}
              />
              Re-apply stashed changes after switching
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setDialog(null)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={() =>
                dialog?.kind === "dirtyTree" &&
                runSwitchStrategy(dialog.target, "stash")
              }
              disabled={switchMut.isPending}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/90"
            >
              Stash
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() =>
                dialog?.kind === "dirtyTree" &&
                runSwitchStrategy(dialog.target, "carry")
              }
              disabled={switchMut.isPending}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/90"
            >
              Carry over
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() =>
                dialog?.kind === "dirtyTree" &&
                setDialog({ kind: "confirmDiscard", target: dialog.target })
              }
              disabled={switchMut.isPending}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard requires a second, explicit confirmation (UI-004 / UI-008) */}
      <DestructiveConfirmDialog
        open={dialog?.kind === "confirmDiscard"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Discard local changes?"
        description={
          dialog?.kind === "confirmDiscard"
            ? `Switching to "${dialog.target}" will permanently discard all uncommitted changes. This cannot be undone.`
            : ""
        }
        confirmLabel="Discard and switch"
        onConfirm={() =>
          dialog?.kind === "confirmDiscard" &&
          runSwitchStrategy(dialog.target, "discard")
        }
      />
    </div>
  );
}

interface BranchRowProps {
  branch: BranchInfo;
  syncDisabled: boolean;
  onSwitch: (name: string) => void;
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
  onCreateFrom: (name: string) => void;
  onSetUpstream: (branch: BranchInfo) => void;
  onMerge: (branch: BranchInfo) => void;
  onDeleteRemote: (branch: BranchInfo) => void;
  onPush: (branch: BranchInfo) => void;
  onPull: (branch: BranchInfo) => void;
  onDetach: (ref: string) => void;
}

function BranchRow({
  branch,
  syncDisabled,
  onSwitch,
  onRename,
  onDelete,
  onCreateFrom,
  onSetUpstream,
  onMerge,
  onDeleteRemote,
  onPush,
  onPull,
  onDetach,
}: BranchRowProps) {
  const remoteRef = splitRemoteRef(branch);
  // Local branches (except the active one) get a green chip; remote-tracking branches
  // get a red one. Fixed light-bg/dark-text palette colors so the pill reads the same in
  // light and dark mode. The active branch keeps the plain ● + row highlight.
  const chipTone = branch.isRemote
    ? "bg-red-100 text-red-800"
    : branch.isCurrent
      ? null
      : "bg-green-100 text-green-800";
  return (
    <div
      className={cn(
        "group hover:bg-accent/50 flex h-full items-center px-3",
        branch.isCurrent && "bg-accent/30",
      )}
    >
      <span className="text-primary mr-2 w-2 text-xs">
        {branch.isCurrent ? "●" : ""}
      </span>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "inline-block max-w-full truncate align-middle font-mono text-xs",
            chipTone && "rounded px-1.5 py-0.5",
            chipTone,
          )}
        >
          {branch.name}
        </span>
      </div>
      {branch.upstream && (
        <span
          className="mr-2 flex items-center gap-1 text-[10px]"
          title={"Tracking " + branch.upstream.name}
        >
          <span className="text-muted-foreground max-w-24 truncate">
            {branch.upstream.name}
          </span>
          {branch.upstream.ahead > 0 && (
            <span className="text-green-600">
              {"↑" + String(branch.upstream.ahead)}
            </span>
          )}
          {branch.upstream.behind > 0 && (
            <span className="text-orange-500">
              {"↓" + String(branch.upstream.behind)}
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
          <DropdownMenuItem onClick={() => onCreateFrom(branch.name)}>
            Create branch from here
          </DropdownMenuItem>
          {!branch.isCurrent && (
            <DropdownMenuItem onClick={() => onMerge(branch)}>
              Merge into current
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => onDetach(branch.name)}>
            Checkout detached
          </DropdownMenuItem>
          {!branch.isRemote && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onSetUpstream(branch)}>
                Set / change upstream
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={syncDisabled}
                onClick={() => onPush(branch)}
              >
                Push
              </DropdownMenuItem>
              {branch.isCurrent && (
                <DropdownMenuItem
                  disabled={syncDisabled}
                  onClick={() => onPull(branch)}
                >
                  Pull
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onRename(branch.name)}>
                Rename
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          {!branch.isRemote && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDelete(branch.name)}
            >
              Delete
            </DropdownMenuItem>
          )}
          {remoteRef && (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onDeleteRemote(branch)}
            >
              Delete remote branch
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
