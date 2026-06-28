// The reflog viewer (docs/spec/09 REQ-P5-RL-001..006).
//
// A routed view (not in-progress-gated): a ref Select (HEAD or any local branch) over a
// newest-first, cursor-paginated list. Each row shows the selector, target short-hash,
// action label, and message, with a per-row menu offering the only mutations — create a
// branch at the entry, reset the current branch to it (soft/mixed direct; --hard behind a
// consequence-naming confirm), and a read-only "View commit" that navigates the graph.
// Recovery writes target the entry's RESOLVED oid via the shipped BranchCreate/ResetTo.

import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { shortOid } from "../lib/format";
import {
  useBranchCreate,
  useBranchList,
  useReflog,
  useResetTo,
} from "../rpc/hooks";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const errorMessage = (error: unknown): string =>
  error != null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : "Operation failed.";

export function ReflogPanel({
  repoId,
  onSelectOid,
}: {
  repoId: RepoId;
  onSelectOid: (oid: Oid) => void;
}) {
  const [ref, setRef] = useState("HEAD");
  const branches = useBranchList(repoId);
  const reflog = useReflog(repoId, ref);
  const branchCreate = useBranchCreate(repoId);
  const resetTo = useResetTo(repoId);

  const [branchFrom, setBranchFrom] = useState<Oid | null>(null);
  const [branchName, setBranchName] = useState("");
  const [hardReset, setHardReset] = useState<Oid | null>(null);

  const refOptions = useMemo(
    () => ["HEAD", ...(branches.data?.localBranches.map((b) => b.name) ?? [])],
    [branches.data],
  );
  const entries = useMemo(
    () => reflog.data?.pages.flatMap((p) => p.entries) ?? [],
    [reflog.data],
  );

  const reset = (oid: Oid, mode: "soft" | "mixed" | "hard") =>
    resetTo.mutate(
      { mode, target: oid },
      {
        onSuccess: () => toast.success(`Reset (${mode}) to ${shortOid(oid)}`),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  const createBranch = () => {
    const name = branchName.trim();
    if (name === "" || branchFrom === null) return;
    branchCreate.mutate(
      { name, startPoint: branchFrom, switchAfter: false },
      {
        onSuccess: () => {
          toast.success(`Created branch ${name}`);
          setBranchFrom(null);
          setBranchName("");
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span id="reflog-ref-label" className="text-xs font-medium">
          Reflog of
        </span>
        <Select value={ref} onValueChange={(value) => setRef(value ?? "HEAD")}>
          <SelectTrigger aria-labelledby="reflog-ref-label" className="w-48">
            <SelectValue>{(value: string) => value}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {refOptions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {reflog.isLoading ? (
          <p className="text-muted-foreground px-3 py-4 text-xs">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-xs">
            No reflog entries for {ref}.
          </p>
        ) : (
          <ul>
            {entries.map((e) => (
              <li
                key={e.selector}
                className="hover:bg-accent group flex items-center gap-2 border-b px-3 py-1.5 text-xs"
              >
                <span className="w-20 shrink-0 font-mono text-muted-foreground">
                  {e.selector}
                </span>
                <button
                  type="button"
                  onClick={() => onSelectOid(e.oid)}
                  className="w-16 shrink-0 text-left font-mono hover:underline"
                >
                  {shortOid(e.oid)}
                </button>
                <Badge tone="muted">{e.action}</Badge>
                <span className="flex-1 truncate">{e.message}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Actions for ${e.selector}`}
                    className="hover:bg-accent flex size-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100 data-popup-open:opacity-100"
                  >
                    …
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="bottom" align="end">
                    <DropdownMenuItem onClick={() => setBranchFrom(e.oid)}>
                      Create branch here…
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => reset(e.oid, "soft")}>
                      Reset (soft) to here
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => reset(e.oid, "mixed")}>
                      Reset (mixed) to here
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setHardReset(e.oid)}>
                      Reset (hard) to here…
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onSelectOid(e.oid)}>
                      View commit
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}

        {reflog.hasNextPage && (
          <div className="p-2 text-center">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void reflog.fetchNextPage()}
              disabled={reflog.isFetchingNextPage}
            >
              {reflog.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </div>

      {/* Create-branch-from-entry (REQ-P5-RL-003) */}
      <Dialog
        open={branchFrom !== null}
        onOpenChange={(next: boolean) => {
          if (!next) {
            setBranchFrom(null);
            setBranchName("");
          }
        }}
      >
        <DialogContent style={{ width: "min(440px, 92vw)" }}>
          <div className="flex flex-col gap-3 p-4">
            <DialogTitle>Create branch from reflog entry</DialogTitle>
            <DialogDescription>
              New branch at{" "}
              <span className="font-mono">
                {branchFrom !== null ? shortOid(branchFrom) : ""}
              </span>
              .
            </DialogDescription>
            <input
              type="text"
              aria-label="Branch name"
              value={branchName}
              onChange={(ev) => setBranchName(ev.target.value)}
              placeholder="new-branch-name"
              className="h-8 w-full border px-2 text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBranchFrom(null);
                  setBranchName("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={createBranch}
                disabled={branchName.trim() === "" || branchCreate.isPending}
              >
                Create
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* --hard reset is the only confirmation-gated reset (REQ-P5-RL-004) */}
      <DestructiveConfirmDialog
        open={hardReset !== null}
        onOpenChange={(next) => {
          if (!next) setHardReset(null);
        }}
        title="Hard reset to this entry?"
        description={`A hard reset moves the current branch to ${
          hardReset !== null ? shortOid(hardReset) : ""
        } and PERMANENTLY DISCARDS all uncommitted working-tree and index changes. This cannot be undone.`}
        confirmLabel="Hard reset"
        onConfirm={() => {
          if (hardReset !== null) reset(hardReset, "hard");
        }}
      />
    </div>
  );
}
