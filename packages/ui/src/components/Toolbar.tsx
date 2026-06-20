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
import { ThemeToggle } from "./ThemeToggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type PullMode = "ff-only" | "rebase" | "merge";
type SyncKind = "fetch" | "pull" | "push";

// force-with-lease overwrites remote history, so its error path stays distinct from a
// plain rejection (SY-022). The non-fast-forward retry dialog is intentionally still a
// toast here — Group 7 owns UI-007.
const pushErrorMessage = (err: unknown) => {
  const msg = String(err);
  if (msg.includes("nonFastForward") || msg.includes("non-fast-forward")) {
    return "Push rejected (non-fast-forward). Pull first, then retry.";
  }
  return "Push failed: " + msg;
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
// a tooltip (`title`) whose text is also the accessible name (`aria-label`). The Fetch /
// Pull / Push split-buttons surface the option dropdowns the review flagged as missing
// (D7 / UI-005 / UI-006); a Cancel affordance surfaces the otherwise-internal unsubscribe
// handle while a sync is in flight (XC-004).
export function Toolbar() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const filters = useUiStore((s) => s.filters);
  const setFilters = useUiStore((s) => s.setFilters);
  const openPalette = useUiStore((s) => s.setPaletteOpen);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setDetailTab = useUiStore((s) => s.setDetailTab);
  const { data: state } = useRepoState(repoId);
  const { data: remotes } = useRemoteList(repoId);
  const { data: branchListing } = useBranchList(repoId);
  const { data: status } = useStatus(repoId);
  const api = useApi();
  const queryClient = useQueryClient();

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
  const stagedCount =
    status?.entries.filter((e) => e.staged !== "unmodified").length ?? 0;

  const syncUnsubRef = useRef<(() => void) | null>(null);
  const [syncRunning, setSyncRunning] = useState<SyncKind | null>(null);
  const [pullMode, setPullMode] = useState<PullMode>("ff-only");

  useEffect(() => {
    return () => {
      syncUnsubRef.current?.();
    };
  }, []);

  // Shared streaming-sync core: one in-flight op at a time, progress mirrored into a
  // single toast, the unsubscribe stored so Cancel can tear it down.
  const startSync = (
    kind: SyncKind,
    label: string,
    start: (handlers: SyncCallbacks) => () => void,
    errorMessage?: (err: unknown) => string,
  ) => {
    if (!repoId || syncRunning) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    setSyncRunning(kind);
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
        setSyncRunning(null);
        syncUnsubRef.current = null;
        toast.success(label + " complete", { id: toastId });
      },
      onError: (err) => {
        setSyncRunning(null);
        syncUnsubRef.current = null;
        toast.error(
          errorMessage ? errorMessage(err) : label + " failed: " + String(err),
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

  const handlePush = (opts: {
    setUpstream?: boolean;
    forceWithLease?: boolean;
    tags?: boolean;
  }) => {
    if (!repoId) return;
    const rid = repoId;
    startSync(
      "push",
      "Pushing",
      (h) => api.pushStream(rid, defaultRemote, opts, h),
      pushErrorMessage,
    );
  };

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

  const handleCommit = () => {
    setActiveView("history");
    setDetailTab("changes");
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
    <div className="bg-background flex flex-col border-b">
      {/* Row 1: primary git actions */}
      <div className="flex h-7 items-center gap-1 px-1">
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
          <button
            type="button"
            onClick={handleCancel}
            title="Cancel the running sync"
            aria-label="Cancel sync"
            className="flex h-5.5 items-center gap-0.5 border border-orange-400 px-1.5 text-[11px] text-orange-600"
          >
            <X className="size-3" aria-hidden="true" />
            Cancel
          </button>
        )}
        <Separator />
        {/* Commit */}
        <button
          type="button"
          onClick={handleCommit}
          disabled={!repoId}
          title="Commit staged changes"
          aria-label="Commit staged changes"
          className="flex h-5.5 items-center gap-0.5 border px-1.5 text-[11px] disabled:opacity-40"
        >
          <GitCommitHorizontal className="size-3.5" aria-hidden="true" />
          {"Commit (" + String(stagedCount) + ")"}
        </button>
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
        <div className="flex-1" />
        <ThemeToggle />
      </div>

      {/* Row 2: history filter toolbar */}
      <div className="flex h-6 items-center gap-1 border-t px-1">
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
    </div>
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-5.5 items-center border px-1 py-0.5 disabled:opacity-40"
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
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
      <button
        type="button"
        onClick={onPrimary}
        disabled={disabled}
        title={label}
        aria-label={label}
        className="flex items-center gap-0.5 border-y border-l px-1 text-[11px]"
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {extra}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          title={label + " options"}
          aria-label={label + " options"}
          className="flex items-center border px-0.5 text-[11px]"
        >
          <ChevronDown className="size-3" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start">
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
