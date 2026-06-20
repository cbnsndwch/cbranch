import {
  type DiffFile,
  type StashEntry,
  type RepoId,
} from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import {
  useStashApply,
  useStashClear,
  useStashDrop,
  useStashList,
  useStashPop,
  useStashPush,
  useStashShow,
} from "../rpc/hooks";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
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
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface StashPanelProps {
  repoId: RepoId;
}

export function StashPanel({ repoId }: StashPanelProps) {
  const { data: entries, isLoading } = useStashList(repoId);
  const pushMut = useStashPush(repoId);
  const applyMut = useStashApply(repoId);
  const popMut = useStashPop(repoId);
  const dropMut = useStashDrop(repoId);
  const clearMut = useStashClear(repoId);

  const [newStashOpen, setNewStashOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // The stash whose diff is shown in the preview pane (UI-010). `stash apply` keeps the
  // entry, so its selection survives; every list-mutating op clears it because the
  // `stash@{n}` indices shift underneath a stale ref.
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  const [stashMessage, setStashMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [stagedOnly, setStagedOnly] = useState(false);

  const list = entries ?? [];

  const handlePush = () => {
    pushMut.mutate(
      {
        message: stashMessage.trim() || undefined,
        includeUntracked,
        keepIndex,
        stagedOnly,
      },
      {
        onSuccess: () => {
          toast.success("Changes stashed");
          setNewStashOpen(false);
          setStashMessage("");
          setIncludeUntracked(false);
          setKeepIndex(false);
          setStagedOnly(false);
          setSelectedRef(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleApply = (ref: string) => {
    applyMut.mutate(
      { ref },
      {
        onSuccess: () => toast.success("Stash applied"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handlePop = (ref: string) => {
    popMut.mutate(
      { ref },
      {
        onSuccess: () => {
          toast.success("Stash popped");
          setSelectedRef(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleDrop = (ref: string) => {
    dropMut.mutate(
      { ref },
      {
        onSuccess: () => {
          toast.success("Stash dropped");
          setSelectedRef(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleClear = () => {
    clearMut.mutate(undefined, {
      onSuccess: () => {
        toast.success("All stashes cleared");
        setSelectedRef(null);
      },
      onError: (err) => toast.error(String(err)),
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">Stash ({list.length})</h2>
        <div className="flex gap-1">
          {list.length > 0 && (
            <button
              type="button"
              onClick={() => setClearConfirmOpen(true)}
              className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={() => setNewStashOpen(true)}
            className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
          >
            + Stash
          </button>
        </div>
      </div>

      {/* Stash list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            Loading stashes…
          </div>
        )}
        {!isLoading && list.length === 0 && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            No stash entries.
          </div>
        )}
        {list.map((entry) => (
          <StashRow
            key={entry.ref}
            entry={entry}
            selected={entry.ref === selectedRef}
            onSelect={() => setSelectedRef(entry.ref)}
            onApply={handleApply}
            onPop={handlePop}
            onDrop={handleDrop}
          />
        ))}
      </div>

      {/* Diff preview for the selected stash (UI-010) */}
      {selectedRef !== null && (
        <div className="min-h-0 flex-1 overflow-auto border-t">
          <StashDiffPreview repoId={repoId} stashRef={selectedRef} />
        </div>
      )}

      {/* New stash dialog */}
      <AlertDialog open={newStashOpen} onOpenChange={setNewStashOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stash changes</AlertDialogTitle>
            <AlertDialogDescription>
              Save your current working directory changes to the stash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Message (optional)</span>
              <input
                type="text"
                value={stashMessage}
                onChange={(e) => setStashMessage(e.target.value)}
                placeholder="WIP: my changes"
                className="h-8 w-full border px-2 text-sm"
                autoFocus
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeUntracked}
                onChange={(e) => setIncludeUntracked(e.target.checked)}
              />
              Include untracked files
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepIndex}
                onChange={(e) => setKeepIndex(e.target.checked)}
              />
              Keep index (staged changes stay staged)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={stagedOnly}
                onChange={(e) => setStagedOnly(e.target.checked)}
              />
              Staged only
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setNewStashOpen(false)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={handlePush}
              disabled={pushMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {pushMut.isPending ? "Stashing…" : "Stash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clear all confirm */}
      <DestructiveConfirmDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="Clear all stashes"
        description="This will permanently remove all stash entries. This cannot be undone."
        confirmLabel="Clear all"
        onConfirm={handleClear}
      />
    </div>
  );
}

interface StashRowProps {
  entry: StashEntry;
  selected: boolean;
  onSelect: () => void;
  onApply: (ref: string) => void;
  onPop: (ref: string) => void;
  onDrop: (ref: string) => void;
}

function StashRow({
  entry,
  selected,
  onSelect,
  onApply,
  onPop,
  onDrop,
}: StashRowProps) {
  return (
    <div
      className={
        "group flex items-center px-3 py-1.5 " +
        (selected ? "bg-accent" : "hover:bg-accent/50")
      }
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
            {"stash@{" + String(entry.index) + "}"}
          </span>
          <span className="truncate text-xs">
            {entry.subject || entry.message}
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 text-[10px]">
          {entry.branch}
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="hover:bg-accent flex h-5 w-5 shrink-0 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
          aria-label="Stash actions"
        >
          …
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          <DropdownMenuItem onClick={() => onApply(entry.ref)}>
            Apply
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onPop(entry.ref)}>
            Pop
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDrop(entry.ref)}
          >
            Drop
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface StashDiffPreviewProps {
  repoId: RepoId;
  stashRef: string;
}

// Read-only diff of a stash entry (UI-010). `stash show -p` is summarised server-side
// into `DiffFile[]`; here we render each file's hunks with the same add/delete colouring
// as the working-tree diff, minus the staging controls.
function StashDiffPreview({ repoId, stashRef }: StashDiffPreviewProps) {
  const { data: files, isLoading, isError } = useStashShow(repoId, stashRef);

  if (isLoading) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs">
        Loading diff…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs">
        Failed to load stash diff.
      </div>
    );
  }
  if (!files || files.length === 0) {
    return (
      <div className="text-muted-foreground px-3 py-2 text-xs">
        No changes in this stash.
      </div>
    );
  }

  return (
    <div className="p-2">
      {files.map((file) => (
        <StashFileDiff key={file.newPath || file.oldPath} file={file} />
      ))}
    </div>
  );
}

function StashFileDiff({ file }: { file: DiffFile }) {
  const path =
    file.oldPath && file.oldPath !== file.newPath
      ? file.oldPath + " → " + file.newPath
      : file.newPath || file.oldPath;

  return (
    <div className="mb-2 rounded border font-mono text-xs">
      <div className="bg-muted flex items-center justify-between gap-2 px-2 py-1">
        <span className="truncate" title={path}>
          {path}
        </span>
        <span className="text-muted-foreground shrink-0">
          {file.additions !== null && (
            <span className="text-green-600 dark:text-green-400">
              {"+" + String(file.additions)}
            </span>
          )}{" "}
          {file.deletions !== null && (
            <span className="text-red-600 dark:text-red-400">
              {"-" + String(file.deletions)}
            </span>
          )}
        </span>
      </div>
      {file.isBinary ? (
        <div className="text-muted-foreground px-2 py-1">
          Binary file — no preview.
        </div>
      ) : (
        file.hunks.map((hunk, i) => (
          <pre key={i} className="overflow-x-auto p-1">
            <div className="text-muted-foreground">{hunk.header}</div>
            {hunk.lines.map((line, j) => {
              let prefix = " ";
              let cls = "";
              if (line.kind === "add") {
                prefix = "+";
                cls = "text-green-600 dark:text-green-400";
              } else if (line.kind === "delete") {
                prefix = "-";
                cls = "text-red-600 dark:text-red-400";
              } else if (line.kind === "noNewlineAtEof") {
                prefix = "\\";
                cls = "text-muted-foreground";
              }
              return (
                <div key={j} className={cls}>
                  {prefix}
                  {line.content}
                </div>
              );
            })}
          </pre>
        ))
      )}
    </div>
  );
}
