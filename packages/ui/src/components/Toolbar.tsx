import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  CloudDownload,
  FolderGit2,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  type LucideIcon,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { cn } from "../lib/cn";
import { type RefScope } from "../lib/filters";
import { useApi } from "../rpc/ApiProvider";
import {
  useBranchList,
  useRemoteList,
  useRepoState,
  useStatus,
} from "../rpc/hooks";
import { useUiStore } from "../state/store";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";

type PullMode = "ff-only" | "rebase" | "merge";
type SyncKind = "fetch" | "pull" | "push";
type PushOpts = {
  setUpstream?: boolean;
  forceWithLease?: boolean;
  tags?: boolean;
};

// force-with-lease overwrites remote history, so its error path stays distinct from a
// plain rejection (SY-022). A non-fast-forward rejection is intercepted before this and
// routed to the retry dialog (UI-007); this stays the fallback for other push failures.
const pushErrorMessage = (err: unknown) => "Push failed: " + String(err);

// The push rejection reaching `onError` is `unknown`: it may be the decoded `GitError`
// (an object carrying `code === "nonFastForward"`) or a transport error whose string form
// mentions it. Detect both so the retry dialog (UI-007) opens for a genuine non-ff reject
// while every other push error keeps the plain toast.
const isNonFastForward = (err: unknown): boolean => {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "nonFastForward"
  ) {
    return true;
  }
  const s = String(err);
  return s.includes("nonFastForward") || s.includes("non-fast-forward");
};

// A single streaming sync handler shape (mirrors `StreamHandlers<SyncEvent>` but with
// `unknown` items so the same core drives fetch / pull / push).
interface SyncCallbacks {
  onItem: (item: unknown) => void;
  onComplete: () => void;
  onError: (err: unknown) => void;
}

// The dense quick-actions bar (docs/design/toolbar-quick-actions.md). Two rows: a
// primary git-action toolbar and a history filter toolbar. Buttons are icon-first with
// a shadcn/Base UI Tooltip whose text is also the accessible name (`aria-label`). The Fetch /
// Pull / Push split-buttons surface the option dropdowns the review flagged as missing
// (D7 / UI-005 / UI-006); a Cancel affordance surfaces the otherwise-internal unsubscribe
// handle while a sync is in flight (XC-004).
export function Toolbar() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const filters = useUiStore((s) => s.filters);
  const setFilters = useUiStore((s) => s.setFilters);
  const openPalette = useUiStore((s) => s.setPaletteOpen);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const openCommitDialog = useUiStore((s) => s.setCommitDialogOpen);
  const syncRequest = useUiStore((s) => s.syncRequest);
  const setSyncRequest = useUiStore((s) => s.setSyncRequest);
  const { data: state } = useRepoState(repoId);
  const { data: remotes } = useRemoteList(repoId);
  const { data: branchListing } = useBranchList(repoId);
  const { data: status } = useStatus(repoId);
  const api = useApi();
  const queryClient = useQueryClient();

  // Pending-change count badge on the Commit button (docs/design/commit-surface.md §2).
  const changeCount = status?.entries.length ?? 0;

  const repoRoot = state?.repoRoot ?? "—";
  const currentBranch = state?.isDetached
    ? "HEAD"
    : (state?.currentBranch ?? "—");
  const defaultRemote = remotes?.[0]?.name ?? "origin";

  // Ahead/behind for the checked-out branch, sourced from the branch listing (D7) — the
  // same `upstream` divergence the BranchesPanel renders per row.
  const upstream = branchListing?.localBranches.find(
    (b) => b.isCurrent,
  )?.upstream;

  const syncUnsubRef = useRef<(() => void) | null>(null);
  // Mirror of `syncRunning` for the synchronous guard: a chained retry (pull → push)
  // starts the next sync from inside the prior op's `onComplete`, where the captured
  // `syncRunning` state is stale. The ref always reflects the live value.
  const syncRunningRef = useRef<SyncKind | null>(null);
  const [syncRunning, setSyncRunning] = useState<SyncKind | null>(null);
  const [pullMode, setPullMode] = useState<PullMode>("ff-only");
  // Non-fast-forward push retry dialog (UI-007): holds the rejected push's options so the
  // chosen pull (rebase/merge) can re-run the identical push on success.
  const [nonFfOpen, setNonFfOpen] = useState(false);
  const [nonFfPushOpts, setNonFfPushOpts] = useState<PushOpts>({});

  const setRunning = (kind: SyncKind | null) => {
    syncRunningRef.current = kind;
    setSyncRunning(kind);
  };

  useEffect(() => {
    return () => {
      syncUnsubRef.current?.();
    };
  }, []);

  // Shared streaming-sync core: one in-flight op at a time, progress mirrored into a
  // single toast, the unsubscribe stored so Cancel can tear it down. `onCompleted` runs
  // after the success toast (used to chain a retry); `onErrorOverride` may claim an error
  // (returning true) to suppress the default toast — the non-ff dialog uses it.
  const startSync = (
    kind: SyncKind,
    label: string,
    start: (handlers: SyncCallbacks) => () => void,
    opts?: {
      errorMessage?: (err: unknown) => string;
      onCompleted?: () => void;
      onErrorOverride?: (err: unknown) => boolean;
    },
  ) => {
    if (!repoId || syncRunningRef.current) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    setRunning(kind);
    const toastId = "sync-" + kind;
    toast.loading(label + "…", { id: toastId });
    syncUnsubRef.current = start({
      onItem: (item) => {
        const ev = item as { _tag: string; text?: string };
        if (ev._tag === "progress" && ev.text) {
          toast.loading(ev.text.trim() || label + "…", { id: toastId });
        }
      },
      onComplete: () => {
        setRunning(null);
        syncUnsubRef.current = null;
        toast.success(label + " complete", { id: toastId });
        opts?.onCompleted?.();
      },
      onError: (err) => {
        setRunning(null);
        syncUnsubRef.current = null;
        if (opts?.onErrorOverride?.(err)) {
          toast.dismiss(toastId);
          return;
        }
        toast.error(
          opts?.errorMessage
            ? opts.errorMessage(err)
            : label + " failed: " + String(err),
          { id: toastId },
        );
      },
    });
  };

  const handleFetch = (opts: {
    all?: boolean;
    prune?: boolean;
    tags?: boolean;
  }) => {
    if (!repoId) return;
    const rid = repoId;
    startSync("fetch", "Fetching", (h) => api.fetchStream(rid, opts, h));
  };

  const handlePull = (mode: PullMode) => {
    if (!repoId) return;
    const rid = repoId;
    setPullMode(mode);
    startSync("pull", "Pulling", (h) => api.pullStream(rid, mode, {}, h));
  };

  const handlePush = (opts: PushOpts) => {
    if (!repoId) return;
    const rid = repoId;
    startSync(
      "push",
      "Pushing",
      (h) => api.pushStream(rid, defaultRemote, opts, h),
      {
        errorMessage: pushErrorMessage,
        // A non-ff rejection opens the retry dialog (UI-007) instead of a dead-end
        // toast; the rejected push's options are stashed so the post-pull retry replays
        // the identical push. Every other push failure keeps the plain toast.
        onErrorOverride: (err) => {
          if (!isNonFastForward(err)) return false;
          setNonFfPushOpts(opts);
          setNonFfOpen(true);
          return true;
        },
      },
    );
  };

  // Resolve a non-ff push (UI-007): pull with the chosen mode, then — only on a clean
  // pull — replay the original push (chained via `onCompleted`, after `setRunning(null)`,
  // so the synchronous in-flight guard sees the slot free). A failed or conflicted pull
  // surfaces its own error and never reaches the retry.
  const handleNonFfRetry = (mode: "rebase" | "merge") => {
    setNonFfOpen(false);
    if (!repoId) return;
    const rid = repoId;
    const pushOpts = nonFfPushOpts;
    setPullMode(mode);
    startSync("pull", "Pulling", (h) => api.pullStream(rid, mode, {}, h), {
      onCompleted: () => handlePush(pushOpts),
    });
  };

  // The menu/palette request a sync without owning the streaming machinery: they set
  // `syncRequest`, and this always-mounted toolbar consumes it (fetch/pull/push) with the
  // current pull mode + default push opts. A ref holds the latest closures so the effect
  // fires only on a new request, not on every render (matching use-keybindings' pattern).
  const syncTriggerRef = useRef({
    handleFetch,
    handlePull,
    handlePush,
    pullMode,
    repoId,
  });
  syncTriggerRef.current = {
    handleFetch,
    handlePull,
    handlePush,
    pullMode,
    repoId,
  };
  useEffect(() => {
    if (!syncRequest) return;
    setSyncRequest(null);
    const t = syncTriggerRef.current;
    if (!t.repoId) return;
    if (syncRequest === "fetch") t.handleFetch({});
    else if (syncRequest === "pull") t.handlePull(t.pullMode);
    else if (syncRequest === "push") t.handlePush({});
  }, [syncRequest, setSyncRequest]);

  const handleCancel = () => {
    if (!syncRunning) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    toast.dismiss("sync-" + syncRunning);
    toast("Sync canceled");
    setSyncRunning(null);
  };

  const handleRefresh = () => {
    if (repoId) void queryClient.invalidateQueries({ queryKey: [repoId] });
  };

  // Open the dedicated stage-&-commit dialog (docs/design/commit-surface.md §2).
  const handleCommit = () => {
    openCommitDialog(true);
  };

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const handleSubmit = (event: SubmitEvent) => {
    event.preventDefault();
  };

  const handleScopeChange = (value: string) => {
    const refScope = value as RefScope;
    setFilters({ ...filters, refScope });
  };

  const handleGrepChange = (value: string) => {
    setFilters({ ...filters, grep: value });
  };

  const syncBusy = !repoId || syncRunning !== null;

  return (
    <TooltipProvider>
      <div className="bg-background flex flex-col border-b pb-1">
        {/* Row 1: primary git actions */}
        <div className="flex h-7 justify-start items-center gap-1 px-2">
          <IconButton
            icon={RefreshCw}
            label="Refresh (re-read refs, status, history)"
            onClick={handleRefresh}
            disabled={!repoId}
          />
          <Separator />
          {/* Working directory — current repo path, click to switch repo */}
          <SplitButton
            icon={FolderGit2}
            label="Working directory — click to switch repository"
            onPrimary={() => openPalette(true)}
            extra={<span className="max-w-40 truncate">{repoRoot}</span>}
          >
            <DropdownMenuItem onClick={() => openPalette(true)}>
              Open another repository…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openPalette(true)}>
              Recent repositories…
            </DropdownMenuItem>
          </SplitButton>
          {/* Branch — current branch + ahead/behind, click to manage branches */}
          <SplitButton
            icon={GitBranch}
            label="Branch — click to manage branches"
            onPrimary={() => setActiveView("branches")}
            disabled={!repoId}
            extra={
              <span className="flex items-center gap-1">
                <span className="max-w-32 truncate">{currentBranch}</span>
                {upstream && (upstream.ahead > 0 || upstream.behind > 0) && (
                  <span
                    className="flex items-center gap-0.5"
                    title={
                      upstream.ahead +
                      " ahead, " +
                      upstream.behind +
                      " behind " +
                      upstream.name
                    }
                  >
                    {upstream.ahead > 0 && (
                      <span className="text-green-600">
                        {"↑" + String(upstream.ahead)}
                      </span>
                    )}
                    {upstream.behind > 0 && (
                      <span className="text-orange-500">
                        {"↓" + String(upstream.behind)}
                      </span>
                    )}
                  </span>
                )}
              </span>
            }
          >
            <DropdownMenuItem onClick={() => setActiveView("branches")}>
              Checkout branch…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setActiveView("branches")}>
              Create branch…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setActiveView("branches")}>
              Merge into current…
            </DropdownMenuItem>
          </SplitButton>
          {/* Worktrees */}
          <SplitButton
            icon={FolderTree}
            label="Worktrees — manage linked worktrees"
            onPrimary={() => setActiveView("worktrees")}
            disabled={!repoId}
          >
            <DropdownMenuItem onClick={() => setActiveView("worktrees")}>
              List worktrees
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setActiveView("worktrees")}>
              Add worktree…
            </DropdownMenuItem>
          </SplitButton>
          <Separator />
          {/* Fetch (split: prune / tags / all remotes) */}
          <SplitButton
            icon={CloudDownload}
            label="Fetch"
            onPrimary={() => handleFetch({})}
            disabled={syncBusy}
          >
            <DropdownMenuItem onClick={() => handleFetch({})}>
              Fetch
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleFetch({ all: true })}>
              Fetch all remotes
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleFetch({ prune: true })}>
              Fetch and prune
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleFetch({ all: true, prune: true })}
            >
              Fetch all and prune
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleFetch({ tags: true })}>
              Fetch tags
            </DropdownMenuItem>
          </SplitButton>
          {/* Pull (split: ff-only / merge / rebase) */}
          <SplitButton
            icon={ArrowDownToLine}
            label={"Pull (" + pullMode + ")"}
            onPrimary={() => handlePull(pullMode)}
            disabled={syncBusy}
          >
            <DropdownMenuItem onClick={() => handlePull("ff-only")}>
              Pull (fast-forward only)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePull("merge")}>
              Pull (merge)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePull("rebase")}>
              Pull (rebase)
            </DropdownMenuItem>
          </SplitButton>
          {/* Push (split: set-upstream / tags / force-with-lease) */}
          <SplitButton
            icon={ArrowUpFromLine}
            label="Push"
            onPrimary={() => handlePush({})}
            disabled={syncBusy}
          >
            <DropdownMenuItem onClick={() => handlePush({})}>
              Push
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePush({ setUpstream: true })}>
              Push and set upstream
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handlePush({ tags: true })}>
              Push tags
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => handlePush({ forceWithLease: true })}
            >
              Force push (with lease) — overwrites remote history
            </DropdownMenuItem>
          </SplitButton>
          {/* Cancel — only surfaced while a streaming sync is in flight (XC-004) */}
          {syncRunning !== null && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={handleCancel}
                    aria-label="Cancel sync"
                    className="flex h-5.5 items-center gap-0.5 border border-orange-400 px-1.5 text-[11px] text-orange-600"
                  />
                }
              >
                <X className="size-3" aria-hidden="true" />
                Cancel
              </TooltipTrigger>
              <TooltipContent>Cancel the running sync</TooltipContent>
            </Tooltip>
          )}

          <Separator />

          {/* Commit */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={!repoId}
                  aria-label="Stage & commit changes"
                  className="flex h-5.5 items-center gap-0.5 border px-1.5 text-[11px] disabled:opacity-40"
                />
              }
            >
              <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
              {"Commit (" + String(changeCount) + ")"}
            </TooltipTrigger>
            <TooltipContent>Stage &amp; commit changes</TooltipContent>
          </Tooltip>
          {/* Stashes */}
          <SplitButton
            icon={Archive}
            label="Stashes — manage shelved changes"
            onPrimary={() => setActiveView("stash")}
            disabled={!repoId}
          >
            <DropdownMenuItem onClick={() => setActiveView("stash")}>
              Manage stashes…
            </DropdownMenuItem>
          </SplitButton>

          {/* </div> */}
          {/* Row 2: history filter toolbar */}
          {/* <div className="flex h-6 items-center gap-1 border-0 pl-2 pr-1"> */}

          <Separator />

          <select
            value={filters.refScope === "all" ? "all" : "current"}
            onChange={(e) => handleScopeChange(e.target.value)}
            className="h-5 border text-[11px]"
            aria-label="History ref scope"
          >
            <option value="current">Current branch</option>
            <option value="all">All branches</option>
          </select>
          <form onSubmit={handleSubmit} className="flex items-center gap-1">
            <label className="flex items-center gap-1 text-[11px]">
              <Search className="size-3" aria-hidden="true" />
              <input
                type="text"
                value={filters.grep}
                onChange={(e) => handleGrepChange(e.target.value)}
                placeholder="Filter commits…"
                className="h-5 w-40 border px-1 text-[11px]"
                aria-label="Filter commits"
              />
            </label>
            <button type="submit" className="h-5 border px-2 text-[11px]">
              Apply
            </button>
          </form>
        </div>

        {/* Non-fast-forward push retry dialog (UI-007). */}
        <AlertDialog
          open={nonFfOpen}
          onOpenChange={(open) => {
            if (!open) setNonFfOpen(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Push rejected — non-fast-forward
              </AlertDialogTitle>
              <AlertDialogDescription>
                The remote has commits you don&apos;t have locally, so the push
                was rejected. Integrate the remote changes first, then retry the
                push. A conflicting pull stops here without pushing.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose onClick={() => setNonFfOpen(false)}>
                Cancel
              </AlertDialogClose>
              <AlertDialogAction
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => handleNonFfRetry("rebase")}
              >
                Pull (rebase) &amp; retry
              </AlertDialogAction>
              <AlertDialogAction
                className="bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => handleNonFfRetry("merge")}
              >
                Pull (merge) &amp; retry
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

function Separator() {
  return <div className="bg-border mx-0.5 h-4 w-px" aria-hidden="true" />;
}

interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function IconButton({ icon: Icon, label, onClick, disabled }: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className="flex h-5.5 items-center border px-1 py-0.5 disabled:opacity-40"
          />
        }
      >
        <Icon className="size-4" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface SplitButtonProps {
  icon: LucideIcon;
  label: string;
  onPrimary: () => void;
  disabled?: boolean;
  extra?: ReactNode;
  children: ReactNode;
}

// A split control: a primary action region (default action) plus a caret that opens the
// option dropdown (docs/design §"Split buttons"). The caret's accessible name is the
// primary label + " options" so each half is independently addressable.
function SplitButton({
  icon: Icon,
  label,
  onPrimary,
  disabled,
  extra,
  children,
}: SplitButtonProps) {
  return (
    <div className={cn("flex h-5.5 items-stretch", disabled && "opacity-40")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onPrimary}
              disabled={disabled}
              aria-label={label}
              className="flex items-center gap-0.5 border-y border-l px-1 text-[11px]"
            />
          }
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {extra}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                disabled={disabled}
                aria-label={label + " options"}
                className="flex items-center border px-0.5 text-[11px]"
              />
            }
          >
            <ChevronDown className="size-3" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{label + " options"}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="bottom" align="start">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
