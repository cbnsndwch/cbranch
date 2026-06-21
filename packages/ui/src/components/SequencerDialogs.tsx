// Cherry-pick / revert / empty-result dialogs (P4 UI-C; REQ-UX-001/002/008).
//
// Launched from a commit's context menu or detail view, these dialogs summarize the
// target commit(s) and expose the cherry-pick / revert options, then dispatch the result
// through {@link planSequencerAction}: a clean apply toasts and closes, a conflict routes
// into the Conflicts view, and an empty pick opens the follow-up Skip / Commit-anyway
// prompt (REQ-CP-006 / REQ-EDGE-005). All three render through one host, <PickDialogs>,
// driven by `store.pickDialog`; only one is open at a time.

import { type RepoId } from "@cbranch/rpc-contract";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { shortOid } from "../lib/format";
import {
  planSequencerAction,
  type SequencerAction,
} from "../lib/sequencer-outcome";
import {
  useCherryPick,
  useCommitDetail,
  useOpContinue,
  useOpSkip,
  useRevert,
} from "../rpc/hooks";
import { type PickCommit, useUiStore } from "../state/store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const NL = String.fromCharCode(10);

/** Git's default single-commit revert message, referencing the subject + SHA (REQ-RV-001). */
const defaultRevertMessage = (subject: string, oid: string): string =>
  `Revert "${subject}"${NL}${NL}This reverts commit ${oid}.`;

/**
 * Perform the side effects of a {@link SequencerAction}: toast, navigate, or re-prompt.
 * `message` (a custom revert message) is threaded into the empty prompt so "Commit anyway"
 * records the empty commit with the text the user typed, not git's default (REQ-RV-001).
 */
function useSequencerDispatch(mode: "cherryPick" | "revert") {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPickDialog = useUiStore((s) => s.setPickDialog);
  return (action: SequencerAction, message?: string) => {
    switch (action.kind) {
      case "success":
        toast.success(action.message);
        setPickDialog(null);
        break;
      case "conflicts":
        toast.message(action.message);
        setActiveView("solveConflicts");
        setPickDialog(null);
        break;
      case "empty":
        setPickDialog({
          kind: "empty",
          mode,
          currentOid: action.currentOid,
          currentSubject: action.currentSubject,
          message,
        });
        break;
    }
  };
}

/**
 * Shared target derivation + merge-mainline gate for the cherry-pick / revert dialogs.
 * The merge check comes from the commit's parents, so a single commit must wait for its
 * detail to LOAD SUCCESSFULLY before submit is allowed — an errored fetch leaves merge-ness
 * unknown and must not count as ready, or the mainline gate (AC-3/AC-5) would be skipped.
 */
function usePickTarget(repoId: RepoId, commits: ReadonlyArray<PickCommit>) {
  const single = commits.length === 1 ? commits[0]! : null;
  const detail = useCommitDetail(repoId, single ? single.oid : null);
  const parents = detail.data?.parents ?? [];
  return {
    single,
    parents,
    isMerge: parents.length >= 2,
    ready: single === null || detail.isSuccess,
    failed: single !== null && detail.isError,
    subject: single ? (detail.data?.subject ?? single.subject) : "",
  };
}

// ─── Shared layout ────────────────────────────────────────────────────────────

function DialogShell({
  title,
  busy,
  onClose,
  children,
  footer,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(next: boolean) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        style={{ width: "min(460px, 92vw)" }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <DialogTitle>{title}</DialogTitle>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="hover:bg-accent flex size-6 items-center justify-center rounded-none border disabled:opacity-40"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-3 py-3 text-xs">{children}</div>
        <div className="flex shrink-0 justify-end gap-2 border-t px-3 py-2">
          {footer}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CommitSummaryList({
  commits,
  subjectOverride,
}: {
  commits: ReadonlyArray<PickCommit>;
  /** Authoritative subject from the fetched detail, for the single-commit case. */
  subjectOverride?: string;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {commits.map((c) => (
        <li key={c.oid} className="flex items-baseline gap-2">
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {shortOid(c.oid)}
          </span>
          <span className="truncate">
            {commits.length === 1 ? (subjectOverride ?? c.subject) : c.subject}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MainlineSelect({
  parents,
  value,
  onChange,
}: {
  parents: ReadonlyArray<string>;
  value: number | null;
  onChange: (n: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="pick-mainline" className="font-medium">
        Mainline parent
      </label>
      <p className="text-muted-foreground text-[11px]">
        This is a merge commit; pick which parent line of history to treat as
        the mainline.
      </p>
      <select
        id="pick-mainline"
        value={value === null ? "" : String(value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
        className="border-input h-7 w-full rounded-none border bg-transparent px-1 text-xs focus:outline-none"
      >
        <option value="" disabled>
          Select a parent…
        </option>
        {parents.map((oid, i) => (
          <option key={oid} value={String(i + 1)}>
            Parent {i + 1} — {shortOid(oid)}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  // Label via aria-label on the control itself (not a `<label htmlFor>`): Base UI's
  // checkbox renders a hidden form input alongside the button, and a for/id label would
  // associate both, leaving two same-named nodes for a11y + tests to disambiguate.
  return (
    <div className="flex items-center gap-2 select-none">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        aria-label={label}
      />
      <span>{label}</span>
    </div>
  );
}

/** Shown when the commit's detail could not be loaded, so its parents are unknown. */
function LoadFailedNote() {
  return (
    <p className="text-destructive text-[11px]" role="alert">
      Could not load this commit&apos;s details. Reopen the dialog to try again.
    </p>
  );
}

// ─── Cherry-pick ──────────────────────────────────────────────────────────────

function CherryPickDialog({
  repoId,
  commits,
}: {
  repoId: RepoId;
  commits: ReadonlyArray<PickCommit>;
}) {
  const setPickDialog = useUiStore((s) => s.setPickDialog);
  const dispatch = useSequencerDispatch("cherryPick");
  const pickMut = useCherryPick(repoId);

  const { parents, isMerge, ready, failed, subject } = usePickTarget(
    repoId,
    commits,
  );

  const [recordOrigin, setRecordOrigin] = useState(false);
  const [noCommit, setNoCommit] = useState(false);
  const [mainline, setMainline] = useState<number | null>(null);

  const close = () => {
    if (!pickMut.isPending) setPickDialog(null);
  };
  // A merge commit must have a mainline before the pick can run (AC-3(08)); `ready` also
  // blocks until the commit's parents are known, so the gate is never silently skipped.
  const canSubmit =
    !pickMut.isPending && ready && (!isMerge || mainline !== null);

  const submit = () =>
    pickMut.mutate(
      {
        commits: commits.map((c) => c.oid),
        recordOrigin: recordOrigin || undefined,
        mainline: isMerge && mainline !== null ? mainline : undefined,
        noCommit: noCommit || undefined,
      },
      {
        onSuccess: (r) => dispatch(planSequencerAction(r, "Cherry-pick")),
        onError: (e) => toast.error(String(e)),
      },
    );

  return (
    <DialogShell
      title={commits.length > 1 ? "Cherry-pick commits" : "Cherry-pick commit"}
      busy={pickMut.isPending}
      onClose={close}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={close}
            disabled={pickMut.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            {noCommit ? "Stage changes" : "Cherry-pick"}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">
        Apply {commits.length > 1 ? "these commits" : "this commit"} onto the
        current branch:
      </p>
      <CommitSummaryList commits={commits} subjectOverride={subject} />
      {failed && <LoadFailedNote />}
      {isMerge && (
        <MainlineSelect
          parents={parents}
          value={mainline}
          onChange={setMainline}
        />
      )}
      <CheckboxField
        label="Record source — append “(cherry picked from commit …)”"
        checked={recordOrigin}
        onChange={setRecordOrigin}
      />
      <CheckboxField
        label="Do not commit (stage changes only)"
        checked={noCommit}
        onChange={setNoCommit}
      />
    </DialogShell>
  );
}

// ─── Revert ───────────────────────────────────────────────────────────────────

function RevertDialog({
  repoId,
  commits,
}: {
  repoId: RepoId;
  commits: ReadonlyArray<PickCommit>;
}) {
  const setPickDialog = useUiStore((s) => s.setPickDialog);
  const dispatch = useSequencerDispatch("revert");
  const revertMut = useRevert(repoId);

  const { single, parents, isMerge, ready, failed, subject } = usePickTarget(
    repoId,
    commits,
  );

  const [noCommit, setNoCommit] = useState(false);
  const [mainline, setMainline] = useState<number | null>(null);
  // `null` = untouched, so the textarea tracks git's default until the user edits it.
  const [message, setMessage] = useState<string | null>(null);
  const effectiveMessage =
    message ?? (single ? defaultRevertMessage(subject, single.oid) : "");
  // A custom message only applies to a single commit that is actually committed.
  const showMessage = single !== null && !noCommit;
  const customMessage = showMessage
    ? effectiveMessage.trim() || undefined
    : undefined;

  const close = () => {
    if (!revertMut.isPending) setPickDialog(null);
  };
  const canSubmit =
    !revertMut.isPending && ready && (!isMerge || mainline !== null);

  const submit = () =>
    revertMut.mutate(
      {
        commits: commits.map((c) => c.oid),
        mainline: isMerge && mainline !== null ? mainline : undefined,
        noCommit: noCommit || undefined,
        message: customMessage,
      },
      {
        // Thread the typed message into the empty prompt so "Commit anyway" keeps it.
        onSuccess: (r) =>
          dispatch(planSequencerAction(r, "Revert"), customMessage),
        onError: (e) => toast.error(String(e)),
      },
    );

  return (
    <DialogShell
      title={commits.length > 1 ? "Revert commits" : "Revert commit"}
      busy={revertMut.isPending}
      onClose={close}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={close}
            disabled={revertMut.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit}>
            {noCommit ? "Stage changes" : "Revert"}
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">
        Create{" "}
        {commits.length > 1 ? "commits that undo" : "a commit that undoes"} the
        changes of:
      </p>
      <CommitSummaryList commits={commits} subjectOverride={subject} />
      {failed && <LoadFailedNote />}
      {isMerge && (
        <MainlineSelect
          parents={parents}
          value={mainline}
          onChange={setMainline}
        />
      )}
      {showMessage && (
        <div className="flex flex-col gap-1">
          <label htmlFor="revert-message" className="font-medium">
            Commit message
          </label>
          <textarea
            id="revert-message"
            value={effectiveMessage}
            onChange={(e) => setMessage(e.target.value)}
            className="border-input h-20 w-full resize-none rounded-none border bg-transparent px-2 py-1 text-xs focus:outline-none"
          />
        </div>
      )}
      <CheckboxField
        label="Do not commit (stage changes only)"
        checked={noCommit}
        onChange={setNoCommit}
      />
    </DialogShell>
  );
}

// ─── Empty result ─────────────────────────────────────────────────────────────

function EmptyPickDialog({
  repoId,
  mode,
  currentOid,
  currentSubject,
  message,
}: {
  repoId: RepoId;
  mode: "cherryPick" | "revert";
  currentOid?: string;
  currentSubject?: string;
  message?: string;
}) {
  const setPickDialog = useUiStore((s) => s.setPickDialog);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const dispatch = useSequencerDispatch(mode);
  const skipMut = useOpSkip(repoId);
  const continueMut = useOpContinue(repoId);
  const opLabel = mode === "cherryPick" ? "Cherry-pick" : "Revert";
  const busy = skipMut.isPending || continueMut.isPending;

  // The operation is still in progress here; dismissing without a choice surfaces the
  // in-progress banner (Continue / Abort) rather than silently leaving a stuck repo.
  const close = () => {
    if (busy) return;
    setActiveView("solveConflicts");
    setPickDialog(null);
  };
  const onResult = (r: Parameters<typeof planSequencerAction>[0]) =>
    dispatch(planSequencerAction(r, opLabel));

  const skip = () =>
    skipMut.mutate(undefined, {
      onSuccess: onResult,
      onError: (e) => toast.error(String(e)),
    });
  const commitEmpty = () =>
    continueMut.mutate(
      { allowEmpty: true, message },
      { onSuccess: onResult, onError: (e) => toast.error(String(e)) },
    );

  return (
    <DialogShell
      title="Nothing to apply"
      busy={busy}
      onClose={close}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="outline" size="sm" onClick={skip} disabled={busy}>
            Skip this commit
          </Button>
          <Button size="sm" onClick={commitEmpty} disabled={busy}>
            Commit anyway
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground">
        This {opLabel.toLowerCase()} produced no changes — the commit is already
        applied or empty.
      </p>
      {currentOid && (
        <div className="flex items-baseline gap-2">
          <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
            {shortOid(currentOid)}
          </span>
          <span className="truncate">{currentSubject}</span>
        </div>
      )}
      <p className="text-muted-foreground text-[11px]">
        Skip it to move on, or record an empty commit to keep it in the history.
      </p>
    </DialogShell>
  );
}

// ─── Host ─────────────────────────────────────────────────────────────────────

/** Renders the active cherry-pick / revert / empty dialog from `store.pickDialog`. */
export function PickDialogs() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const pick = useUiStore((s) => s.pickDialog);
  if (repoId === null || pick === null) return null;
  switch (pick.kind) {
    case "cherryPick":
      return <CherryPickDialog repoId={repoId} commits={pick.commits} />;
    case "revert":
      return <RevertDialog repoId={repoId} commits={pick.commits} />;
    case "empty":
      return (
        <EmptyPickDialog
          repoId={repoId}
          mode={pick.mode}
          currentOid={pick.currentOid}
          currentSubject={pick.currentSubject}
          message={pick.message}
        />
      );
  }
}
