import { FolderOpen, RefreshCw } from "lucide-react";
import { type FormEvent } from "react";

import { type RefScope } from "../lib/filters";
import { useRepoState } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { ThemeToggle } from "./ThemeToggle";

export function Toolbar() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const filters = useUiStore((s) => s.filters);
  const setFilters = useUiStore((s) => s.setFilters);
  const openPalette = useUiStore((s) => s.setPaletteOpen);
  const { data: state } = useRepoState(repoId);

  const repoRoot = state?.repoRoot ?? "—";
  const currentBranch = state?.isDetached ? "HEAD" : (state?.currentBranch ?? "—");

  const handleSubmit = (event: FormEvent) => {
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
        className="flex h-[22px] items-center border px-1 py-0.5"
        aria-label="Open repository"
      >
        <FolderOpen className="size-4" aria-hidden="true" />
      </button>
      <button type="button" className="flex h-[22px] items-center border px-1 py-0.5" aria-label="Refresh">
        <RefreshCw className="size-4" aria-hidden="true" />
      </button>
      {/* Repo path */}
      <span className="flex h-[22px] max-w-[200px] items-center truncate border px-1 text-[11px]">{repoRoot}</span>
      {/* Current branch */}
      <span className="flex h-[22px] items-center border px-1 text-[11px]">{currentBranch}</span>
      <div className="flex-1" />
      {/* Ref scope */}
      <select
        value={filters.refScope === "all" ? "all" : "current"}
        onChange={(e) => handleScopeChange(e.target.value)}
        className="h-[22px] border text-[11px]"
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
            className="h-[22px] w-28 border px-1 text-[11px]"
          />
        </label>
        <button type="submit" className="h-[22px] border px-2 text-[11px]">
          Apply
        </button>
      </form>
      {/* Commit button (inert placeholder) */}
      <button type="button" className="h-[22px] border px-2 text-[11px]">
        Commit (0)
      </button>
      <ThemeToggle />
    </div>
  );
}
