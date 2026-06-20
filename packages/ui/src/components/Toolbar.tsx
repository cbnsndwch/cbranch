import {
  ArrowDownUp,
  Download,
  FolderOpen,
  RefreshCw,
  Upload,
} from "lucide-react";
import { type SubmitEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { type RefScope } from "../lib/filters";
import { useApi } from "../rpc/ApiProvider";
import { useRemoteList, useRepoState } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { ThemeToggle } from "./ThemeToggle";

type PullMode = "ff-only" | "rebase" | "merge";

export function Toolbar() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const filters = useUiStore((s) => s.filters);
  const setFilters = useUiStore((s) => s.setFilters);
  const openPalette = useUiStore((s) => s.setPaletteOpen);
  const { data: state } = useRepoState(repoId);
  const { data: remotes } = useRemoteList(repoId);
  const api = useApi();

  const repoRoot = state?.repoRoot ?? "—";
  const currentBranch = state?.isDetached
    ? "HEAD"
    : (state?.currentBranch ?? "—");
  const defaultRemote = remotes?.[0]?.name ?? "origin";

  const syncUnsubRef = useRef<(() => void) | null>(null);
  const [syncRunning, setSyncRunning] = useState<
    "fetch" | "pull" | "push" | null
  >(null);
  const [pullMode, setPullMode] = useState<PullMode>("ff-only");

  useEffect(() => {
    return () => {
      syncUnsubRef.current?.();
    };
  }, []);

  const handleFetch = () => {
    if (!repoId || syncRunning) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    setSyncRunning("fetch");
    const toastId = "sync-fetch";
    toast.loading("Fetching…", { id: toastId });
    syncUnsubRef.current = api.fetchStream(
      repoId,
      {},
      {
        onItem: (item) => {
          const ev = item as { _tag: string; text?: string };
          if (ev._tag === "progress" && ev.text) {
            toast.loading(ev.text.trim() || "Fetching…", {
              id: toastId,
            });
          }
        },
        onComplete: () => {
          setSyncRunning(null);
          syncUnsubRef.current = null;
          toast.success("Fetch complete", { id: toastId });
        },
        onError: (err) => {
          setSyncRunning(null);
          syncUnsubRef.current = null;
          toast.error("Fetch failed: " + String(err), {
            id: toastId,
          });
        },
      },
    );
  };

  const handlePull = () => {
    if (!repoId || syncRunning) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    setSyncRunning("pull");
    const toastId = "sync-pull";
    toast.loading("Pulling…", { id: toastId });
    syncUnsubRef.current = api.pullStream(
      repoId,
      pullMode,
      {},
      {
        onItem: (item) => {
          const ev = item as { _tag: string; text?: string };
          if (ev._tag === "progress" && ev.text) {
            toast.loading(ev.text.trim() || "Pulling…", {
              id: toastId,
            });
          }
        },
        onComplete: () => {
          setSyncRunning(null);
          syncUnsubRef.current = null;
          toast.success("Pull complete", { id: toastId });
        },
        onError: (err) => {
          setSyncRunning(null);
          syncUnsubRef.current = null;
          toast.error("Pull failed: " + String(err), { id: toastId });
        },
      },
    );
  };

  const handlePush = () => {
    if (!repoId || syncRunning) return;
    syncUnsubRef.current?.();
    syncUnsubRef.current = null;
    setSyncRunning("push");
    const toastId = "sync-push";
    toast.loading("Pushing…", { id: toastId });
    syncUnsubRef.current = api.pushStream(
      repoId,
      defaultRemote,
      {},
      {
        onItem: (item) => {
          const ev = item as { _tag: string; text?: string };
          if (ev._tag === "progress" && ev.text) {
            toast.loading(ev.text.trim() || "Pushing…", {
              id: toastId,
            });
          }
        },
        onComplete: () => {
          setSyncRunning(null);
          syncUnsubRef.current = null;
          toast.success("Push complete", { id: toastId });
        },
        onError: (err) => {
          setSyncRunning(null);
          syncUnsubRef.current = null;
          const msg = String(err);
          if (
            msg.includes("nonFastForward") ||
            msg.includes("non-fast-forward")
          ) {
            toast.error(
              "Push rejected (non-fast-forward). Pull first, then retry.",
              { id: toastId },
            );
          } else {
            toast.error("Push failed: " + msg, { id: toastId });
          }
        },
      },
    );
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

  return (
    <div className="bg-background flex h-8 items-center gap-1 border-b px-1">
      {/* Open / Refresh icon buttons */}
      <button
        type="button"
        onClick={() => openPalette(true)}
        className="flex h-5.5 items-center border px-1 py-0.5"
        aria-label="Open repository"
      >
        <FolderOpen className="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="flex h-5.5 items-center border px-1 py-0.5"
        aria-label="Refresh"
      >
        <RefreshCw className="size-4" aria-hidden="true" />
      </button>
      {/* Repo path */}
      <span className="flex h-5.5 max-w-50 items-center truncate border px-1 text-[11px]">
        {repoRoot}
      </span>
      {/* Current branch */}
      <span className="flex h-5.5 items-center border px-1 text-[11px]">
        {currentBranch}
      </span>
      <div className="flex-1" />
      {/* Ref scope */}
      <select
        value={filters.refScope === "all" ? "all" : "current"}
        onChange={(e) => handleScopeChange(e.target.value)}
        className="h-5.5 border text-[11px]"
      >
        <option value="current">Current branch</option>
        <option value="all">All branches</option>
      </select>
      {/* Text filter */}
      <form onSubmit={handleSubmit} className="flex items-center gap-1">
        <label className="flex items-center gap-1 text-[11px]">
          Filter:
          <input
            type="text"
            value={filters.grep}
            onChange={(e) => handleGrepChange(e.target.value)}
            className="h-5.5 w-28 border px-1 text-[11px]"
          />
        </label>
        <button type="submit" className="h-5.5 border px-2 text-[11px]">
          Apply
        </button>
      </form>
      {/* Commit button (inert placeholder) */}
      <button type="button" className="h-5.5 border px-2 text-[11px]">
        Commit (0)
      </button>
      {/* Sync buttons */}
      <button
        type="button"
        disabled={!repoId || syncRunning !== null}
        onClick={handleFetch}
        className="flex h-5.5 items-center gap-0.5 border px-1.5 text-[11px] disabled:opacity-40"
        aria-label="Fetch"
      >
        <Download className="size-3" aria-hidden="true" />
        {syncRunning === "fetch" ? "…" : "Fetch"}
      </button>
      <div className="flex h-5.5 items-center gap-0">
        <select
          value={pullMode}
          onChange={(e) => setPullMode(e.target.value as PullMode)}
          className="h-5.5 border-y border-l text-[11px]"
          disabled={!repoId || syncRunning !== null}
          aria-label="Pull mode"
        >
          <option value="ff-only">ff-only</option>
          <option value="rebase">rebase</option>
          <option value="merge">merge</option>
        </select>
        <button
          type="button"
          disabled={!repoId || syncRunning !== null}
          onClick={handlePull}
          className="flex h-5.5 items-center gap-0.5 border px-1.5 text-[11px] disabled:opacity-40"
          aria-label="Pull"
        >
          <ArrowDownUp className="size-3" aria-hidden="true" />
          {syncRunning === "pull" ? "…" : "Pull"}
        </button>
      </div>
      <button
        type="button"
        disabled={!repoId || syncRunning !== null}
        onClick={handlePush}
        className="flex h-5.5 items-center gap-0.5 border px-1.5 text-[11px] disabled:opacity-40"
        aria-label="Push"
      >
        <Upload className="size-3" aria-hidden="true" />
        {syncRunning === "push" ? "…" : "Push"}
      </button>
      <ThemeToggle />
    </div>
  );
}
