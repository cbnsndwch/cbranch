// The repository-maintenance (gc) dialog (docs/spec/09 REQ-P5-GC-001..004).
//
// A small blocking modal: an "aggressive" Checkbox + a prune Select, a Run button, and a
// busy → result flow. While the gc RPC is in flight the dialog is non-dismissable
// (REQ-P5-GC-003) and the captured stdout/stderr is shown on completion; a mid-operation
// repo state (rebase/merge/bisect) is surfaced as a WARN-ONLY alert, never a block (git gc
// is safe mid-operation). The `useGc` hook invalidates `refs`+`commits` on settle
// (REQ-P5-GC-004) — a pure object repack emits no fs-watcher events.

import { type GcPrune, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { useGc, useRepoState } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const PRUNE_LABEL: Record<GcPrune, string> = {
  default: "Default expiry",
  now: "Prune now",
};

const errorMessage = (error: unknown): string =>
  error != null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : "Maintenance failed.";

export function GcDialog() {
  const repoId = useUiStore((s) => s.activeRepoId);
  if (repoId === null) return null;
  // Key by repoId so switching repos remounts the body, discarding the previous
  // repo's captured gc stdout/stderr (held in the useGc mutation's local state).
  return <GcDialogBody key={repoId} repoId={repoId} />;
}

function GcDialogBody({ repoId }: { repoId: RepoId }) {
  const open = useUiStore((s) => s.gcDialogOpen);
  const setOpen = useUiStore((s) => s.setGcDialogOpen);

  const [aggressive, setAggressive] = useState(false);
  const [prune, setPrune] = useState<GcPrune>("default");

  const repoStateQuery = useRepoState(repoId);
  const gc = useGc(repoId);

  const inProgress = repoStateQuery.data?.inProgress ?? "none";
  const midOp = inProgress !== "none";
  const pending = gc.isPending;
  const result = gc.data;
  const error = gc.error;
  const output = [result?.stdout ?? "", result?.stderr ?? ""]
    .filter((s) => s.trim() !== "")
    .join("\n")
    .trim();

  // While a gc RPC is in flight the dialog is non-dismissable (REQ-P5-GC-003).
  const requestClose = () => {
    if (!pending) {
      gc.reset();
      setOpen(false);
    }
  };

  const run = () =>
    gc.mutate(
      { aggressive, prune },
      { onSuccess: () => toast.success("Repository maintenance complete") },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (next) setOpen(true);
        else requestClose();
      }}
    >
      <DialogContent style={{ width: "min(560px, 92vw)" }}>
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>Run maintenance (gc)</DialogTitle>
          <DialogDescription>
            Optimize the repository with{" "}
            <span className="font-mono">git gc</span>. Objects are repacked and
            unreachable ones may be pruned; tracked content is never removed.
          </DialogDescription>

          {midOp && (
            <div
              role="alert"
              className="border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs"
            >
              A {inProgress} is in progress. Maintenance is usually safe but
              discouraged mid-operation — consider finishing or aborting it
              first.
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              aria-label="Aggressive"
              checked={aggressive}
              onCheckedChange={(checked) => setAggressive(checked === true)}
              disabled={pending}
            />
            Aggressive (slower, more thorough repack)
          </label>

          <div className="flex items-center gap-2 text-sm">
            <span id="gc-prune-label">Prune</span>
            <Select
              value={prune}
              onValueChange={(value) => setPrune(value as GcPrune)}
            >
              <SelectTrigger
                aria-labelledby="gc-prune-label"
                disabled={pending}
                className="w-44"
              >
                <SelectValue>
                  {(value: GcPrune) =>
                    PRUNE_LABEL[value] ?? PRUNE_LABEL.default
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default expiry</SelectItem>
                <SelectItem value="now">Prune now</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error != null && (
            <div
              role="alert"
              className="border border-destructive/50 bg-destructive/10 px-2 py-1 text-xs text-destructive"
            >
              {errorMessage(error)}
            </div>
          )}

          {result != null && (
            <pre className="max-h-48 overflow-auto border bg-muted/30 p-2 text-xs whitespace-pre-wrap">
              {output || "Maintenance complete (no output)."}
            </pre>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={requestClose}
              disabled={pending}
            >
              {result != null || error != null ? "Close" : "Cancel"}
            </Button>
            <Button size="sm" onClick={run} disabled={pending}>
              {pending ? "Running…" : "Run maintenance"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
