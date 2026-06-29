import {
  type ConflictClassification,
  type ConflictFile,
  type ConflictResolution,
  type OperationKind,
  type OperationProgress,
  type RebaseStopReason,
  type RepoId,
} from "@cbranch/rpc-contract";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  useConflictList,
  useConflictResolve,
  useOpAbort,
  useOpContinue,
  useOpSkip,
  useRebaseStatus,
} from "../rpc/hooks";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { Badge, type BadgeTone } from "./ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** The operations whose continue/abort/skip verbs cbranch drives (REQ-CN-001). */
const RESUMABLE = new Set<OperationKind>([
  "merge",
  "rebase",
  "cherryPick",
  "revert",
]);

const OP_LABELS: Record<OperationKind, string> = {
  none: "",
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Cherry-pick",
  revert: "Revert",
  am: "Apply",
  bisect: "Bisect",
};

const CLASS_LABELS: Record<ConflictClassification, string> = {
  bothModified: "both modified",
  bothAdded: "both added",
  bothDeleted: "both deleted",
  addedByUs: "added by us",
  addedByThem: "added by them",
  deletedByUs: "deleted by us",
  deletedByThem: "deleted by them",
};

const CLASS_TONE: Record<ConflictClassification, BadgeTone> = {
  bothModified: "default",
  bothAdded: "default",
  bothDeleted: "danger",
  addedByUs: "default",
  addedByThem: "default",
  deletedByUs: "danger",
  deletedByThem: "danger",
};

const isDeleteModify = (c: ConflictClassification): boolean =>
  c === "deletedByUs" || c === "deletedByThem";

/** Rebase stop-reason copy for the banner (REQ-P5-IR-009). `none` has no banner line. */
const REBASE_STOP_COPY: Record<RebaseStopReason, string> = {
  none: "",
  conflict: "Resolve the conflicts below, then Continue.",
  edit: "Stopped to edit this commit — make changes and stage them, then Continue.",
  execFailed:
    "A scripted rebase step failed. Abort and start over — Continue would skip it and drop its change.",
};

interface ConflictsPanelProps {
  repoId: RepoId;
  /** Seam for UI-B: open the 3-way merge editor for a path. */
  onEdit?: (path: string) => void;
}

export function ConflictsPanel({ repoId, onEdit }: ConflictsPanelProps) {
  const { data, isLoading } = useConflictList(repoId);
  const resolveMut = useConflictResolve(repoId);
  const continueMut = useOpContinue(repoId);
  const abortMut = useOpAbort(repoId);
  const skipMut = useOpSkip(repoId);

  const [abortOpen, setAbortOpen] = useState(false);
  const [deletePath, setDeletePath] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const conflicted = data?.conflicted ?? [];
  const operation = data?.operation ?? "none";

  // Rebase carries an extra stop-reason (edit vs conflict vs execFailed) that the generic
  // conflict listing can't express. Kept enabled (not gated on `operation`) so its cache
  // is warm by the time a rebase stop renders — otherwise Continue would briefly enable
  // before the reason loads, allowing a click that skips a failed step (REQ-P5-IR-010/013).
  const rebaseStatus = useRebaseStatus(repoId);
  const rebaseStop =
    operation === "rebase" ? rebaseStatus.data?.stopReason : undefined;

  // "Resolved" is relative to the operation's initial set, which only the client
  // knows (the server can't tell a taken-ours resolution from HEAD). Accumulate every
  // path ever seen conflicted this operation; reset once the operation is gone.
  const seen = useRef<Set<string>>(new Set());
  if (operation === "none") {
    if (seen.current.size > 0) seen.current = new Set();
  } else {
    for (const f of conflicted) seen.current.add(f.path);
  }
  const currentPaths = new Set(conflicted.map((f) => f.path));
  const resolvedCount = [...seen.current].filter(
    (p) => !currentPaths.has(p),
  ).length;

  const resolve = (
    paths: ReadonlyArray<string>,
    resolution: ConflictResolution,
  ) =>
    resolveMut.mutate(
      { paths, resolution },
      { onError: (err) => toast.error(String(err)) },
    );

  const handleContinue = () => {
    const msg = message.trim();
    continueMut.mutate(msg ? { message: msg } : {}, {
      onSuccess: (r) => {
        setMessage("");
        if (r.outcome === "completed") toast.success("Operation completed");
        else if (r.outcome === "conflicts")
          toast.message("More conflicts to resolve");
        else if (r.outcome === "empty")
          toast.message("Nothing to commit — skip or commit an empty change");
      },
      onError: (err) => toast.error(String(err)),
    });
  };

  const handleAbort = () =>
    abortMut.mutate(undefined, {
      onSuccess: () => toast.success("Operation aborted"),
      onError: (err) => toast.error(String(err)),
    });

  const handleSkip = () =>
    skipMut.mutate(undefined, {
      onSuccess: () => toast.success("Commit skipped"),
      onError: (err) => toast.error(String(err)),
    });

  const busy = continueMut.isPending || abortMut.isPending || skipMut.isPending;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {RESUMABLE.has(operation) && (
        <InProgressBanner
          operation={operation}
          progress={data?.progress}
          canContinue={data?.canContinue ?? false}
          canSkip={data?.canSkip ?? false}
          conflictedCount={conflicted.length}
          resolvedCount={resolvedCount}
          rebaseStop={rebaseStop}
          message={message}
          onMessageChange={setMessage}
          onContinue={handleContinue}
          onAbort={() => setAbortOpen(true)}
          onSkip={handleSkip}
          busy={busy}
        />
      )}

      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <h2 className="text-sm font-medium">Conflicts</h2>
        <span className="text-muted-foreground text-[11px]">
          {conflicted.length} conflicted, {resolvedCount} resolved
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            Loading conflicts…
          </div>
        )}
        {!isLoading && conflicted.length === 0 && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            No conflicted files.
          </div>
        )}
        {conflicted.map((f) => (
          <ConflictRow
            key={f.path}
            file={f}
            onResolve={resolve}
            onEdit={onEdit}
            onDeleteFile={setDeletePath}
          />
        ))}
      </div>

      <DestructiveConfirmDialog
        open={abortOpen}
        onOpenChange={setAbortOpen}
        title={`Abort ${(OP_LABELS[operation] || "operation").toLowerCase()}`}
        description="Resolution progress will be discarded and the repository returns to its pre-operation state."
        confirmLabel="Abort"
        onConfirm={handleAbort}
      />

      <DestructiveConfirmDialog
        open={deletePath !== null}
        onOpenChange={(open) => {
          if (!open) setDeletePath(null);
        }}
        title="Delete file"
        description={`${deletePath ?? ""} will be removed from the working tree (git rm) to accept the deletion.`}
        confirmLabel="Delete file"
        onConfirm={() => {
          if (deletePath !== null) resolve([deletePath], "deleteFile");
        }}
      />
    </div>
  );
}

interface BannerProps {
  operation: OperationKind;
  progress: OperationProgress | undefined;
  canContinue: boolean;
  canSkip: boolean;
  conflictedCount: number;
  resolvedCount: number;
  /** Rebase-only stop reason; drives the banner copy + steers `execFailed` to Abort. */
  rebaseStop: RebaseStopReason | undefined;
  message: string;
  onMessageChange: (value: string) => void;
  onContinue: () => void;
  onAbort: () => void;
  onSkip: () => void;
  busy: boolean;
}

function InProgressBanner({
  operation,
  progress,
  canContinue,
  canSkip,
  conflictedCount,
  resolvedCount,
  rebaseStop,
  message,
  onMessageChange,
  onContinue,
  onAbort,
  onSkip,
  busy,
}: BannerProps) {
  const isRebase = operation === "rebase";
  // Rebase Continue passes no message (reword/squash are baked into the todo); a failed
  // scripted step must not be Continued (it would skip the step and drop its change).
  const execFailed = rebaseStop === "execFailed";
  // For a rebase, only allow Continue once the stop reason is KNOWN and safe — `undefined`
  // means the status query hasn't resolved yet, so don't enable a premature Continue.
  const continueBlocked =
    isRebase && (rebaseStop === undefined || rebaseStop === "execFailed");
  const stopCopy = isRebase && rebaseStop ? REBASE_STOP_COPY[rebaseStop] : "";
  return (
    <div className="bg-muted border-b px-3 py-2" role="status">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium">
          <span>{OP_LABELS[operation]} in progress</span>
          {progress && (
            <span className="ml-1">
              — {isRebase ? "step" : "commit"} {progress.current} of{" "}
              {progress.total}
            </span>
          )}
          <span className="text-muted-foreground ml-2 font-normal">
            {conflictedCount} conflicted, {resolvedCount} resolved
          </span>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onContinue}
            disabled={!canContinue || busy || continueBlocked}
            className="bg-primary text-primary-foreground flex h-[22px] items-center px-2 text-[11px] disabled:opacity-40"
          >
            Continue
          </button>
          {canSkip && (
            <button
              type="button"
              onClick={onSkip}
              disabled={busy}
              className="hover:bg-accent flex h-[22px] items-center border px-2 text-[11px] disabled:opacity-40"
            >
              Skip
            </button>
          )}
          <button
            type="button"
            onClick={onAbort}
            disabled={busy}
            className="text-destructive hover:bg-accent flex h-[22px] items-center border px-2 text-[11px] disabled:opacity-40"
          >
            Abort
          </button>
        </div>
      </div>
      {stopCopy !== "" && (
        <p
          className={`mt-1 text-[11px] ${execFailed ? "text-destructive" : "text-muted-foreground"}`}
          role={execFailed ? "alert" : undefined}
        >
          {stopCopy}
        </p>
      )}
      {/* Rebase bakes reword/squash messages into the todo — no message box. */}
      {canContinue && !isRebase && (
        <textarea
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Commit message (optional)…"
          aria-label="Commit message"
          className="mt-2 h-12 w-full border px-2 py-1 text-xs"
        />
      )}
    </div>
  );
}

interface ConflictRowProps {
  file: ConflictFile;
  onResolve: (
    paths: ReadonlyArray<string>,
    resolution: ConflictResolution,
  ) => void;
  onEdit?: (path: string) => void;
  onDeleteFile: (path: string) => void;
}

function ConflictRow({
  file,
  onResolve,
  onEdit,
  onDeleteFile,
}: ConflictRowProps) {
  const deleteModify = isDeleteModify(file.classification);
  const bothDeleted = file.classification === "bothDeleted";
  const canEdit = !file.isBinary && !file.isSubmodule && !deleteModify;
  const pick =
    (resolution: ConflictResolution, enabled = true) =>
    () => {
      if (enabled) onResolve([file.path], resolution);
    };

  return (
    <div className="group hover:bg-accent/50 flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs" title={file.path}>
            {file.path}
          </span>
          <Badge tone={CLASS_TONE[file.classification]}>
            {CLASS_LABELS[file.classification]}
          </Badge>
          {file.isBinary && (
            <span className="text-muted-foreground shrink-0 rounded border px-1 text-[9px]">
              binary
            </span>
          )}
          {file.isSubmodule && (
            <span className="text-muted-foreground shrink-0 rounded border px-1 text-[9px]">
              submodule
            </span>
          )}
        </div>
        {(file.isBinary || file.isSubmodule) && (
          <p className="text-muted-foreground mt-0.5 text-[10px]">
            {file.isSubmodule ? "Submodule reference" : "Binary file"} —
            can&apos;t be merged line-by-line; resolve by taking one whole side.
          </p>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="hover:bg-accent flex h-5 w-5 shrink-0 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
          aria-label="Resolve conflict"
        >
          …
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end">
          {deleteModify && (
            <>
              <DropdownMenuItem onClick={pick("keepFile")}>
                Keep file
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDeleteFile(file.path)}
              >
                Delete file
              </DropdownMenuItem>
            </>
          )}
          {bothDeleted && (
            <>
              <DropdownMenuItem
                disabled={!file.hasBase}
                onClick={pick("base", file.hasBase)}
              >
                Take base
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDeleteFile(file.path)}
              >
                Delete file
              </DropdownMenuItem>
            </>
          )}
          {!deleteModify && !bothDeleted && (
            <>
              <DropdownMenuItem
                disabled={!file.hasOurs}
                onClick={pick("ours", file.hasOurs)}
              >
                Take ours
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!file.hasTheirs}
                onClick={pick("theirs", file.hasTheirs)}
              >
                Take theirs
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!file.hasBase}
                onClick={pick("base", file.hasBase)}
              >
                Take base
              </DropdownMenuItem>
              {canEdit && (
                <DropdownMenuItem onClick={() => onEdit?.(file.path)}>
                  Edit…
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
