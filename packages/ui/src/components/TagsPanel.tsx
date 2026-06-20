import { type TagInfo, type TagType, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import {
  useTagCreate,
  useTagDelete,
  useTagDeleteRemote,
  useTagList,
  useTagPush,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface TagsPanelProps {
  repoId: RepoId;
}

export function TagsPanel({ repoId }: TagsPanelProps) {
  const { data: tags, isLoading } = useTagList(repoId);
  const createMut = useTagCreate(repoId);
  const deleteMut = useTagDelete(repoId);
  const pushMut = useTagPush(repoId);
  const deleteRemoteMut = useTagDeleteRemote(repoId);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const [tagName, setTagName] = useState("");
  const [tagType, setTagType] = useState<TagType>("lightweight");
  const [tagTarget, setTagTarget] = useState("HEAD");
  const [tagMessage, setTagMessage] = useState("");
  const [tagForce, setTagForce] = useState(false);

  const list = tags ?? [];

  const handleCreate = () => {
    const name = tagName.trim();
    if (!name) return;
    createMut.mutate(
      {
        name,
        target: tagTarget.trim() || undefined,
        tagType,
        message: tagMessage.trim() || undefined,
        force: tagForce,
      },
      {
        onSuccess: () => {
          toast.success("Tag created");
          setCreateOpen(false);
          setTagName("");
          setTagType("lightweight");
          setTagTarget("HEAD");
          setTagMessage("");
          setTagForce(false);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleDeleteLocal = (name: string) => {
    deleteMut.mutate(
      { name },
      {
        onSuccess: () => {
          toast.success("Tag deleted");
          setDeleteTarget(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handlePush = (name: string) => {
    pushMut.mutate(
      { remote: "origin", name },
      {
        onSuccess: () => toast.success("Tag pushed to origin"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleDeleteRemote = (name: string) => {
    deleteRemoteMut.mutate(
      { remote: "origin", name },
      {
        onSuccess: () => toast.success("Tag deleted from origin"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">Tags ({list.length})</h2>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px]"
        >
          + New Tag
        </button>
      </div>

      {/* Tag list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            Loading tags…
          </div>
        )}
        {!isLoading && list.length === 0 && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            No tags.
          </div>
        )}
        {list.map((tag) => (
          <TagRow
            key={tag.name}
            tag={tag}
            onDeleteLocal={(name) => setDeleteTarget(name)}
            onPush={handlePush}
            onDeleteRemote={handleDeleteRemote}
          />
        ))}
      </div>

      {/* Create tag dialog */}
      <AlertDialog open={createOpen} onOpenChange={setCreateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create tag</AlertDialogTitle>
            <AlertDialogDescription>
              Create a new Git tag at the specified target.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Tag name</span>
              <input
                type="text"
                value={tagName}
                onChange={(e) => setTagName(e.target.value)}
                placeholder="v1.0.0"
                className="h-8 w-full border px-2 text-sm"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Type</span>
              <select
                value={tagType}
                onChange={(e) => setTagType(e.target.value as TagType)}
                className="h-8 border px-1 text-sm"
              >
                <option value="lightweight">Lightweight</option>
                <option value="annotated">Annotated</option>
                <option value="signed">Signed</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium">Target</span>
              <input
                type="text"
                value={tagTarget}
                onChange={(e) => setTagTarget(e.target.value)}
                placeholder="HEAD"
                className="h-8 w-full border px-2 text-sm"
              />
            </label>
            {(tagType === "annotated" || tagType === "signed") && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium">Message</span>
                <input
                  type="text"
                  value={tagMessage}
                  onChange={(e) => setTagMessage(e.target.value)}
                  placeholder="Release v1.0.0"
                  className="h-8 w-full border px-2 text-sm"
                />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={tagForce}
                onChange={(e) => setTagForce(e.target.checked)}
              />
              Force (overwrite existing tag)
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose onClick={() => setCreateOpen(false)}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction
              onClick={handleCreate}
              disabled={!tagName.trim() || createMut.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {createMut.isPending ? "Creating…" : "Create"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete local confirm */}
      <DestructiveConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete tag"
        description={
          'Delete local tag "' +
          (deleteTarget ?? "") +
          '"? This cannot be undone.'
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleteTarget) handleDeleteLocal(deleteTarget);
        }}
      />
    </div>
  );
}

interface TagRowProps {
  tag: TagInfo;
  onDeleteLocal: (name: string) => void;
  onPush: (name: string) => void;
  onDeleteRemote: (name: string) => void;
}

function TagRow({ tag, onDeleteLocal, onPush, onDeleteRemote }: TagRowProps) {
  const shortOid = tag.targetOid ? String(tag.targetOid).slice(0, 7) : "—";
  const dateStr =
    tag.taggerDate && tag.taggerDate > 0
      ? new Date(tag.taggerDate * 1000).toLocaleDateString()
      : "";

  return (
    <div className="group hover:bg-accent/50 flex items-center px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{tag.name}</span>
          <span className="text-muted-foreground rounded border px-1 text-[9px]">
            {tag.isAnnotated ? "annotated" : "lightweight"}
          </span>
        </div>
        <div className="text-muted-foreground mt-0.5 flex gap-3 text-[10px]">
          <span className="font-mono">{shortOid}</span>
          {dateStr && <span>{dateStr}</span>}
          {tag.taggerName && <span>{tag.taggerName}</span>}
        </div>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="hover:bg-accent flex h-5 w-5 shrink-0 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
          aria-label="Tag actions"
        >
          …
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          <DropdownMenuItem onClick={() => onPush(tag.name)}>
            Push to origin
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDeleteLocal(tag.name)}
          >
            Delete local
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onDeleteRemote(tag.name)}
          >
            Delete from origin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
