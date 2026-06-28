// The persistent bisect banner (docs/spec/09 REQ-P5-BS-002..007).
//
// Shown at the top of the shell whenever a bisect session is active (driven by the
// machine-derived BisectStatus, so a pre-existing session shows on repo open). It states
// the detached-HEAD testing state (REQ-P5-BS-007), the current revision under test and
// the estimated revisions/steps left, and offers good/bad/skip + Reset. On conclusion it
// prominently shows the first bad commit with a "View commit"; when skips can't isolate it
// reports the ambiguous candidate set. After a successful mark the graph follows the next
// checked-out revision (REQ-P5-BS-003).

import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";
import { toast } from "sonner";

import { shortOid } from "../lib/format";
import { useBisectMark, useBisectReset, useBisectStatus } from "../rpc/hooks";
import { DestructiveConfirmDialog } from "./DestructiveConfirmDialog";
import { Button } from "./ui/button";

const errorMessage = (error: unknown): string =>
  error != null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : "Bisect operation failed.";

export function BisectBanner({
  repoId,
  onSelectOid,
}: {
  repoId: RepoId;
  onSelectOid: (oid: Oid) => void;
}) {
  const status = useBisectStatus(repoId);
  const mark = useBisectMark(repoId);
  const reset = useBisectReset(repoId);
  const [confirmReset, setConfirmReset] = useState(false);

  const data = status.data;
  if (data === undefined || data.state === "inactive") return null;

  const busy = mark.isPending || reset.isPending;

  const doMark = (m: "good" | "bad" | "skip") =>
    mark.mutate(m, {
      onSuccess: (s) => {
        // Follow the next revision git checked out (REQ-P5-BS-003) — only while still
        // bisecting with a current commit; skip when concluded/unbisectable.
        if (s.state === "bisecting" && s.current) onSelectOid(s.current.oid);
      },
      onError: (e) => toast.error(errorMessage(e)),
    });

  return (
    <div
      role="status"
      className="border-status-behind/40 bg-status-behind/10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs"
    >
      <span className="font-semibold">Bisecting</span>
      <span className="text-muted-foreground">
        detached HEAD — branch operations are unavailable until you reset.
      </span>

      {data.state === "bisecting" && (
        <>
          <span className="font-mono">
            {data.current
              ? `${shortOid(data.current.oid)} ${data.current.subject}`
              : "seeding — mark good/bad to begin"}
          </span>
          {data.revisionsRemaining !== undefined && (
            <span className="text-muted-foreground">
              ~{data.revisionsRemaining} revisions
              {data.stepsRemaining !== undefined
                ? `, ${data.stepsRemaining} steps`
                : ""}{" "}
              left
            </span>
          )}
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => doMark("good")}
              disabled={busy}
            >
              Good
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-xs"
              onClick={() => doMark("bad")}
              disabled={busy}
            >
              Bad
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => doMark("skip")}
              disabled={busy}
            >
              Skip
            </Button>
          </div>
        </>
      )}

      {data.state === "concluded" && data.firstBad && (
        <>
          <span className="font-semibold">First bad commit:</span>
          <span className="font-mono">
            {shortOid(data.firstBad.oid)} {data.firstBad.subject}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => onSelectOid(data.firstBad!.oid)}
          >
            View commit
          </Button>
        </>
      )}

      {data.state === "unbisectable" && (
        <span className="text-status-behind ml-auto" role="alert">
          Skips prevent isolating a single commit —{" "}
          {data.candidates?.length ?? 0} candidates remain.
        </span>
      )}

      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        onClick={() => setConfirmReset(true)}
        disabled={reset.isPending}
      >
        Reset
      </Button>

      <DestructiveConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="End the bisect session?"
        description="Reset ends the bisect session and returns HEAD to its original branch/commit."
        confirmLabel="Reset bisect"
        onConfirm={() =>
          reset.mutate(undefined, {
            onError: (e) => toast.error(errorMessage(e)),
          })
        }
      />
    </div>
  );
}
