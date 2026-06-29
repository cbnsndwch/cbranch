// The interactive-rebase editor (docs/spec/09 REQ-P5-IR-001..008).
//
// A base picker (a branch/ref select feeding `upstream`, plus an optional advanced
// `onto`) drives a live `rebasePlan` query; its commits seed an editable, reorderable
// todo list. Each row picks one action (pick/reword/edit/squash/fixup/drop);
// reword/squash collect their message in the nested RebaseMessageDialog (never a
// terminal editor). A validation note blocks Start while the plan is invalid. On start,
// conflict/edit stops hand off to the shipped in-progress banner + Conflicts view.

import {
  type BranchInfo,
  type Oid,
  type RebaseAction,
  type RebasePlan,
  type RebaseStep as RebaseStepClass,
  type RepoId,
  RebaseStep,
} from "@cbranch/rpc-contract";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  useBranchList,
  useRebasePlan,
  useRebaseStart,
  useStashPush,
} from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

const ACTIONS: ReadonlyArray<RebaseAction> = [
  "pick",
  "reword",
  "edit",
  "squash",
  "fixup",
  "drop",
];
const ACTION_LABEL: Record<RebaseAction, string> = {
  pick: "Pick",
  reword: "Reword",
  edit: "Edit",
  squash: "Squash",
  fixup: "Fixup",
  drop: "Drop",
};

const SELECT_CLASS =
  "border-input rounded-none border bg-transparent px-1 text-xs focus:outline-none";

const shortOid = (oid: string): string => oid.slice(0, 8);

const errorMessage = (error: unknown): string =>
  error != null && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : "Could not start the rebase.";

interface TodoRow {
  readonly oid: Oid;
  readonly subject: string;
  readonly authorName: string;
  readonly body: string;
  readonly action: RebaseAction;
  /** Authored reword text / combined squash message (undefined for other actions). */
  readonly message?: string;
}

const fullMessageOf = (r: { subject: string; body: string }): string =>
  r.body.trim() === "" ? r.subject : `${r.subject}\n\n${r.body}`;

/** The default combined message for a squash: the involved commits' messages joined. */
const defaultSquashMessage = (
  rows: ReadonlyArray<TodoRow>,
  index: number,
): string => {
  // Walk back over the contiguous fixup/squash run to the group's base (pick/reword/edit).
  let base = index;
  while (
    base > 0 &&
    (rows[base - 1].action === "fixup" || rows[base - 1].action === "squash")
  )
    base -= 1;
  base -= 1; // the base row itself
  const start = base >= 0 ? base : index;
  return rows
    .slice(start, index + 1)
    .filter((r) => r.action !== "drop")
    .map(fullMessageOf)
    .join("\n\n");
};

/**
 * The original-row indices whose message the rebase actually applies — one per group:
 * the last squash, or a reword base with no squash follower. Mirrors the engine's
 * `consumedMessageIndices`, so the UI only collects/requires the messages git will use
 * (an absorbed reword and non-last squashes contribute none).
 */
const consumedMessageRows = (rows: ReadonlyArray<TodoRow>): Set<number> => {
  const kept = rows
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.action !== "drop");
  const out = new Set<number>();
  let k = 0;
  while (k < kept.length) {
    let j = k + 1;
    let lastSquash = -1;
    while (
      j < kept.length &&
      (kept[j].r.action === "fixup" || kept[j].r.action === "squash")
    ) {
      if (kept[j].r.action === "squash") lastSquash = j;
      j += 1;
    }
    if (lastSquash >= 0) out.add(kept[lastSquash].i);
    else if (kept[k].r.action === "reword") out.add(kept[k].i);
    k = j;
  }
  return out;
};

/** Mirror the engine's validation so Start is blocked client-side (REQ-P5-IR-005). */
const validateRows = (rows: ReadonlyArray<TodoRow>): string | null => {
  const kept = rows.filter((r) => r.action !== "drop");
  if (kept.length === 0) return "This plan drops every commit.";
  if (kept[0].action === "squash" || kept[0].action === "fixup")
    return "The first commit can't be a squash or fixup.";
  for (const idx of consumedMessageRows(rows)) {
    const r = rows[idx];
    if ((r.message ?? "").trim() === "")
      return `Provide a message for the ${r.action} of ${shortOid(r.oid)}.`;
  }
  return null;
};

export function RebaseDialog({ repoId }: { repoId: RepoId }) {
  const state = useUiStore((s) => s.rebaseDialog);
  if (state === null) return null;
  return (
    <RebaseBody
      repoId={repoId}
      initialUpstream={state.upstream ?? ""}
      initialOnto={state.onto ?? ""}
    />
  );
}

function RebaseBody({
  repoId,
  initialUpstream,
  initialOnto,
}: {
  repoId: RepoId;
  initialUpstream: string;
  initialOnto: string;
}) {
  const close = () => useUiStore.getState().setRebaseDialog(null);
  const branches = useBranchList(repoId);
  const start = useRebaseStart(repoId);
  const stash = useStashPush(repoId);
  // A dirty-tree refusal (the engine returns a typed `dirtyWorkingTree`) opens an
  // offer-to-stash affordance rather than dropping a bare toast (REQ-P5-IR refusal UX).
  const [dirtyTree, setDirtyTree] = useState(false);

  const [upstream, setUpstream] = useState(initialUpstream);
  const [showOnto, setShowOnto] = useState(initialOnto !== "");
  const [onto, setOnto] = useState(initialOnto);
  const effectiveOnto = showOnto && onto !== "" ? onto : undefined;

  // The range is `<upstream>..HEAD` and is independent of `--onto`, so the plan query is
  // keyed on `upstream` only — changing the replay target never refetches/re-seeds.
  const plan = useRebasePlan(repoId, upstream);
  const [rows, setRows] = useState<ReadonlyArray<TodoRow>>([]);
  const [editing, setEditing] = useState<number | null>(null);
  // Once the user touches the plan it is "dirty"; we then never auto-re-seed for the same
  // base (an external history change would otherwise silently discard their edits).
  const dirty = useRef(false);

  const seedRows = (commits: RebasePlan["commits"]) => {
    dirty.current = false;
    setRows(
      commits.map((c) => ({
        oid: c.oid,
        subject: c.subject,
        authorName: c.authorName,
        body: c.body,
        action: "pick" as RebaseAction,
      })),
    );
  };

  // Re-seed when the base (upstream) changes — an intentional new plan. For the SAME base,
  // re-seed only while the plan is still pristine; once edited, a background refetch (e.g.
  // an external HEAD move) must not clobber the user's todo (REQ-P5-IR-004).
  const seededUpstream = useRef<string | null>(null);
  const seededOids =
    plan.data === undefined
      ? null
      : plan.data.commits.map((c) => c.oid).join(",");
  const lastOids = useRef<string | null>(null);
  useEffect(() => {
    if (plan.data === undefined) return;
    const baseChanged = seededUpstream.current !== upstream;
    const oidsChanged = lastOids.current !== seededOids;
    if (baseChanged || (oidsChanged && !dirty.current)) {
      seededUpstream.current = upstream;
      lastOids.current = seededOids;
      seedRows(plan.data.commits);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstream, seededOids, plan.data]);

  const setAction = (index: number, action: RebaseAction) => {
    dirty.current = true;
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== index) return r;
        const message =
          action === "reword"
            ? fullMessageOf(r)
            : action === "squash"
              ? defaultSquashMessage(prev, index)
              : undefined;
        return { ...r, action, message };
      }),
    );
  };

  const move = (index: number, delta: -1 | 1) => {
    dirty.current = true;
    setRows((prev) => {
      const next = index + delta;
      if (next < 0 || next >= prev.length) return prev;
      const copy = [...prev];
      [copy[index], copy[next]] = [copy[next], copy[index]];
      return copy;
    });
  };

  const setMessage = (index: number, message: string) => {
    dirty.current = true;
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, message } : r)),
    );
  };

  const validation = rows.length === 0 ? null : validateRows(rows);
  // Only the rows whose message the rebase applies get a message editor (an absorbed
  // reword / non-last squash folds without its own message).
  const messageRows = consumedMessageRows(rows);
  const hasBase = upstream !== "";
  const canStart =
    hasBase &&
    rows.length > 0 &&
    validation === null &&
    !start.isPending &&
    !plan.isPending;

  const doStart = () => {
    const steps: ReadonlyArray<RebaseStepClass> = rows.map(
      (r) =>
        new RebaseStep({ oid: r.oid, action: r.action, message: r.message }),
    );
    start.mutate(
      { upstream, steps, onto: effectiveOnto },
      {
        onSuccess: (status) => {
          close();
          if (!status.inProgress) toast.success("Rebase complete");
          else if (status.stopReason === "conflict")
            toast.message(
              "Rebase stopped on a conflict — resolve and continue",
            );
          else if (status.stopReason === "edit")
            toast.message("Rebase stopped to edit a commit");
          else toast.message("Rebase stopped");
        },
        onError: (e) => {
          // The engine machine-detects a dirty-tree refusal and returns a typed
          // `dirtyWorkingTree` (NF-GIT-3) — branch on the error CODE, not git's stderr — and
          // offer to stash the conflicting changes rather than dropping a bare toast.
          if ((e as { code?: unknown }).code === "dirtyWorkingTree")
            setDirtyTree(true);
          else toast.error(errorMessage(e));
        },
      },
    );
  };

  // Stash the local changes that blocked the rebase, then retry. The stash is left for the
  // user to pop afterwards (the rebase may stop on a conflict/edit, so auto-popping isn't safe).
  const stashAndRebase = () => {
    stash.mutate(
      {},
      {
        onSuccess: () => {
          setDirtyTree(false);
          toast.success("Stashed local changes");
          doStart();
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  const branchItems: ReadonlyArray<BranchInfo> = [
    ...(branches.data?.localBranches ?? []),
    ...(branches.data?.remoteBranches ?? []),
  ];
  const isBranch = (value: string) => branchItems.some((b) => b.name === value);

  // A base picker: the branch/ref list, plus a synthetic option for a seeded commit oid
  // (from the commit context menu) that isn't itself a branch name.
  const basePicker = (
    value: string,
    onChange: (next: string) => void,
    label: string,
  ) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={start.isPending}
      className={`h-7 flex-1 ${SELECT_CLASS}`}
    >
      <option value="">Choose a branch or ref…</option>
      {value !== "" && !isBranch(value) && (
        <option value={value}>commit {shortOid(value)}</option>
      )}
      {branchItems.map((b) => (
        <option key={b.fullRef} value={b.name}>
          {b.name}
          {b.isRemote ? " (remote)" : ""}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog
      open={true}
      onOpenChange={(next: boolean) => {
        if (!next && !start.isPending) close();
      }}
    >
      <DialogContent style={{ width: "min(680px, 94vw)" }}>
        <div className="flex max-h-[82vh] flex-col gap-3 p-4">
          <DialogTitle>Interactive rebase</DialogTitle>
          <DialogDescription>
            Replay the commits since the chosen base onto it. Reorder rows and
            pick an action per commit; reword and squash collect their message
            here.
          </DialogDescription>

          {/* Base picker */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="w-28 shrink-0">Rebase onto</span>
              {basePicker(upstream, setUpstream, "Rebase onto")}
            </div>

            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                aria-label="Rebase onto a different base"
                checked={showOnto}
                onCheckedChange={(checked) => setShowOnto(checked === true)}
                disabled={start.isPending}
              />
              Replay onto a different base (advanced --onto)
            </label>
            {showOnto && (
              <div className="flex items-center gap-2 text-sm">
                <span className="w-28 shrink-0">New base</span>
                {basePicker(onto, setOnto, "New base")}
              </div>
            )}
          </div>

          {/* Todo list */}
          <div className="min-h-0 flex-1 overflow-auto border">
            {!hasBase && (
              <p className="text-muted-foreground px-3 py-4 text-sm">
                Choose a base above to list the commits to rebase.
              </p>
            )}
            {hasBase && plan.isPending && (
              <p className="text-muted-foreground px-3 py-4 text-sm">
                Loading the rebase range…
              </p>
            )}
            {hasBase && plan.isError && (
              <p className="text-destructive px-3 py-4 text-sm" role="alert">
                Couldn&apos;t compute the rebase range for this base.
              </p>
            )}
            {hasBase &&
              !plan.isPending &&
              !plan.isError &&
              rows.length === 0 && (
                <p className="text-muted-foreground px-3 py-4 text-sm">
                  No commits to rebase in this range.
                </p>
              )}
            <ul>
              {rows.map((r, i) => (
                <li
                  key={r.oid}
                  className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0"
                >
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${shortOid(r.oid)} up`}
                      onClick={() => move(i, -1)}
                      disabled={i === 0 || start.isPending}
                      className="hover:bg-accent h-3.5 px-1 text-[9px] leading-none disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${shortOid(r.oid)} down`}
                      onClick={() => move(i, 1)}
                      disabled={i === rows.length - 1 || start.isPending}
                      className="hover:bg-accent h-3.5 px-1 text-[9px] leading-none disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>
                  <select
                    aria-label={`Action for ${shortOid(r.oid)}`}
                    value={r.action}
                    onChange={(e) =>
                      setAction(i, e.target.value as RebaseAction)
                    }
                    disabled={start.isPending}
                    className={`h-6 w-24 shrink-0 ${SELECT_CLASS}`}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {ACTION_LABEL[a]}
                      </option>
                    ))}
                  </select>
                  <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                    {shortOid(r.oid)}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate text-xs ${r.action === "drop" ? "text-muted-foreground line-through" : ""}`}
                    title={r.subject}
                  >
                    {r.subject}
                  </span>
                  <span className="text-muted-foreground hidden shrink-0 text-[10px] sm:inline">
                    {r.authorName}
                  </span>
                  {messageRows.has(i) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[11px]"
                      onClick={() => setEditing(i)}
                      disabled={start.isPending}
                    >
                      Message…
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {validation !== null && (
            <p className="text-destructive text-xs" role="alert">
              {validation}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={close}
              disabled={start.isPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={doStart} disabled={!canStart}>
              {start.isPending ? "Starting…" : "Start rebase"}
            </Button>
          </div>
        </div>
      </DialogContent>

      {editing !== null && rows[editing] !== undefined && (
        <RebaseMessageDialog
          action={rows[editing].action}
          shortLabel={shortOid(rows[editing].oid)}
          initialValue={rows[editing].message ?? ""}
          onCancel={() => setEditing(null)}
          onSave={(value) => {
            setMessage(editing, value);
            setEditing(null);
          }}
        />
      )}

      {dirtyTree && (
        <Dialog
          open={true}
          onOpenChange={(next: boolean) => {
            if (!next && !stash.isPending) setDirtyTree(false);
          }}
        >
          <DialogContent style={{ width: "min(520px, 92vw)" }}>
            <div className="flex flex-col gap-3 p-4">
              <DialogTitle>Uncommitted changes</DialogTitle>
              <DialogDescription>
                Local changes would be overwritten by this rebase. Stash them
                and rebase, or cancel and deal with them yourself.
              </DialogDescription>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDirtyTree(false)}
                  disabled={stash.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={stashAndRebase}
                  disabled={stash.isPending}
                >
                  {stash.isPending ? "Stashing…" : "Stash and rebase"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}

function RebaseMessageDialog({
  action,
  shortLabel,
  initialValue,
  onSave,
  onCancel,
}: {
  action: RebaseAction;
  shortLabel: string;
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <Dialog
      open={true}
      onOpenChange={(next: boolean) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent style={{ width: "min(560px, 92vw)" }}>
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>
            {action === "reword" ? "Reword" : "Squash"} {shortLabel}
          </DialogTitle>
          <DialogDescription>
            {action === "reword"
              ? "Edit the commit message used when this commit is replayed."
              : "Edit the combined message for the squashed commits."}
          </DialogDescription>
          <textarea
            aria-label="Commit message"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-40 w-full border px-2 py-1 font-mono text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onSave(value)}>
              Save message
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
