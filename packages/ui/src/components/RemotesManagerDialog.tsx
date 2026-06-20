import { type RemoteInfo, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { useRemoteAdd, useRemoteList, useRemoteRemove, useRemoteRename, useRemoteSetUrl } from "../rpc/hooks";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

interface RemotesManagerDialogProps {
  repoId: RepoId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type EditState =
  | { kind: "renaming"; remoteName: string; value: string }
  | { kind: "editUrl"; remoteName: string; value: string }
  | null;

export function RemotesManagerDialog({ repoId, open, onOpenChange }: RemotesManagerDialogProps) {
  const { data: remotes } = useRemoteList(repoId);
  const addMut = useRemoteAdd(repoId);
  const renameMut = useRemoteRename(repoId);
  const setUrlMut = useRemoteSetUrl(repoId);
  const removeMut = useRemoteRemove(repoId);

  const [editState, setEditState] = useState<EditState>(null);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  const handleAdd = () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) return;
    addMut.mutate(
      { name, url },
      {
        onSuccess: () => {
          toast.success("Remote added");
          setNewName("");
          setNewUrl("");
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleRenameStart = (remote: RemoteInfo) => {
    setEditState({ kind: "renaming", remoteName: remote.name, value: remote.name });
  };

  const handleRenameConfirm = () => {
    if (editState?.kind !== "renaming") return;
    const newNameVal = editState.value.trim();
    if (!newNameVal || newNameVal === editState.remoteName) {
      setEditState(null);
      return;
    }
    renameMut.mutate(
      { oldName: editState.remoteName, newName: newNameVal },
      {
        onSuccess: () => {
          toast.success("Remote renamed");
          setEditState(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleEditUrlStart = (remote: RemoteInfo) => {
    setEditState({ kind: "editUrl", remoteName: remote.name, value: remote.fetchUrl });
  };

  const handleEditUrlConfirm = () => {
    if (editState?.kind !== "editUrl") return;
    const url = editState.value.trim();
    if (!url) {
      setEditState(null);
      return;
    }
    setUrlMut.mutate(
      { name: editState.remoteName, url },
      {
        onSuccess: () => {
          toast.success("Remote URL updated");
          setEditState(null);
        },
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const handleRemove = (name: string) => {
    removeMut.mutate(
      { name },
      {
        onSuccess: () => toast.success("Remote removed"),
        onError: (err) => toast.error(String(err)),
      },
    );
  };

  const list = remotes ?? [];

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Manage Remotes</AlertDialogTitle>
          <AlertDialogDescription>Add, rename, or remove Git remotes for this repository.</AlertDialogDescription>
        </AlertDialogHeader>

        {/* Remote list */}
        <div className="my-2 overflow-auto">
          {list.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">No remotes configured.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs font-medium">
                  <th className="pr-2 pb-1">Name</th>
                  <th className="pr-2 pb-1">Fetch URL</th>
                  <th className="pb-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((remote) => (
                  <tr key={remote.name} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">
                      {editState?.kind === "renaming" && editState.remoteName === remote.name ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={editState.value}
                            onChange={(e) => setEditState({ ...editState, value: e.target.value })}
                            className="h-7 w-28 border px-1 text-xs"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRenameConfirm();
                              if (e.key === "Escape") setEditState(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleRenameConfirm}
                            className="h-7 border px-1.5 text-xs"
                            disabled={renameMut.isPending}
                          >
                            OK
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditState(null)}
                            className="h-7 border px-1.5 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="font-mono text-xs">{remote.name}</span>
                      )}
                    </td>
                    <td className="max-w-[260px] py-1.5 pr-2">
                      {editState?.kind === "editUrl" && editState.remoteName === remote.name ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={editState.value}
                            onChange={(e) => setEditState({ ...editState, value: e.target.value })}
                            className="h-7 min-w-0 flex-1 border px-1 text-xs"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleEditUrlConfirm();
                              if (e.key === "Escape") setEditState(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleEditUrlConfirm}
                            className="h-7 shrink-0 border px-1.5 text-xs"
                            disabled={setUrlMut.isPending}
                          >
                            OK
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditState(null)}
                            className="h-7 shrink-0 border px-1.5 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="block truncate font-mono text-xs" title={remote.fetchUrl}>
                          {remote.fetchUrl}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => handleEditUrlStart(remote)}
                          disabled={editState !== null}
                          className="h-6 border px-1.5 text-[10px] disabled:opacity-40"
                        >
                          Edit URL
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRenameStart(remote)}
                          disabled={editState !== null}
                          className="h-6 border px-1.5 text-[10px] disabled:opacity-40"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemove(remote.name)}
                          disabled={removeMut.isPending}
                          className="text-destructive h-6 border px-1.5 text-[10px] disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Add remote form */}
        <div className="border-t pt-3">
          <p className="mb-2 text-xs font-medium">Add remote</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name (e.g. origin)"
              className="h-8 w-28 border px-2 text-sm"
            />
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="URL"
              className="h-8 min-w-0 flex-1 border px-2 text-sm"
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={!newName.trim() || !newUrl.trim() || addMut.isPending}
              className="bg-primary text-primary-foreground h-8 shrink-0 border px-3 text-sm disabled:opacity-40"
            >
              {addMut.isPending ? "Adding…" : "Add"}
            </button>
          </div>
        </div>

        <AlertDialogFooter className="mt-3">
          <AlertDialogClose onClick={() => onOpenChange(false)}>Close</AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
