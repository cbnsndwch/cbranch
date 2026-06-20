import { type RepoId } from "@cbranch/rpc-contract";
import { ChevronDown, ChevronRight, Cloud, GitBranch, RefreshCw, Search, Tag } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../lib/cn";
import { parseRefs } from "../lib/refs";
import { useRepoState } from "../rpc/hooks";
import { useUiStore } from "../state/store";

function SectionHeader({
  label,
  expanded,
  onToggle,
}: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const Icon = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-muted-foreground hover:bg-accent/50 flex w-full items-center gap-1 px-2 py-0.5 text-[11px]"
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}

function TreeItem({
  label,
  icon,
  level,
  isCurrent,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly level: number;
  readonly isCurrent: boolean;
}) {
  return (
    <div
      className={cn(
        "flex cursor-pointer items-center gap-1 leading-[18px] hover:bg-accent/50",
        isCurrent ? "font-bold" : "",
      )}
      style={{ paddingLeft: `${level * 16}px` }}
    >
      {icon}
      <span className="truncate text-[12px]">{label}</span>
    </div>
  );
}

export function RepositorySidebar({ repoId }: { readonly repoId: RepoId | null }) {
  const { data: repoState } = useRepoState(repoId);
  const knownRefStrings = useUiStore((s) => s.knownRefStrings);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    new Set(["branches", "remotes", "tags", "submodules", "stashes"]),
  );

  const labels = parseRefs([...knownRefStrings]);
  const localBranches = labels.filter((l) => l.kind === "localBranch");
  const remoteBranches = labels.filter((l) => l.kind === "remoteBranch");
  const tags = labels.filter((l) => l.kind === "tag");
  const currentBranch = repoState?.currentBranch;

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filterFn = (name: string) => !search || name.toLowerCase().includes(search.toLowerCase());

  return (
    <div className="flex h-full flex-col overflow-hidden border-r bg-[var(--color-muted)]">
      {/* Icon row */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-b px-2">
        <Search className="size-3" aria-hidden="true" />
        <RefreshCw className="size-3" aria-hidden="true" />
        <span className="ml-1 text-[11px]">Refs</span>
      </div>
      {/* Search */}
      <div className="shrink-0 border-b px-2 py-1">
        <input
          type="text"
          placeholder="Search refs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-background h-[22px] w-full border px-1 text-[11px]"
        />
      </div>
      {/* Tree */}
      <div className="flex-1 overflow-auto">
        <SectionHeader label="BRANCHES" expanded={expanded.has("branches")} onToggle={() => toggle("branches")} />
        {expanded.has("branches") &&
          localBranches
            .filter((l) => filterFn(l.name))
            .map((label) => (
              <TreeItem
                key={label.raw}
                label={label.name}
                icon={<GitBranch className="size-3 shrink-0" aria-hidden="true" />}
                level={1}
                isCurrent={label.name === currentBranch || label.isHead}
              />
            ))}
        <SectionHeader label="REMOTES" expanded={expanded.has("remotes")} onToggle={() => toggle("remotes")} />
        {expanded.has("remotes") &&
          remoteBranches
            .filter((l) => filterFn(l.name))
            .map((label) => (
              <TreeItem
                key={label.raw}
                label={label.name}
                icon={<Cloud className="size-3 shrink-0" aria-hidden="true" />}
                level={1}
                isCurrent={false}
              />
            ))}
        <SectionHeader label="TAGS" expanded={expanded.has("tags")} onToggle={() => toggle("tags")} />
        {expanded.has("tags") &&
          tags
            .filter((l) => filterFn(l.name))
            .map((label) => (
              <TreeItem
                key={label.raw}
                label={label.name}
                icon={<Tag className="size-3 shrink-0" aria-hidden="true" />}
                level={1}
                isCurrent={false}
              />
            ))}
        <SectionHeader label="SUBMODULES" expanded={expanded.has("submodules")} onToggle={() => toggle("submodules")} />
        <SectionHeader label="STASHES" expanded={expanded.has("stashes")} onToggle={() => toggle("stashes")} />
      </div>
    </div>
  );
}
