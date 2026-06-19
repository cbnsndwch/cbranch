import { Cloud, GitBranch, Tag } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../lib/cn";
import { parseRefs, type RefKind, type RefLabel } from "../lib/refs";

// Ref/branch/tag chips on a history row (P1-UI-HIST-4; spec 10 REQ-GRAPH-012/013/015).
// Each kind is visually distinguished; the current HEAD branch carries a HEAD marker
// (REQ-GRAPH-014); overflow past a small cap collapses into an expandable "+N"
// affordance rather than truncating silently (REQ-GRAPH-015).

const MAX_VISIBLE = 3;

const kindClass: Record<RefKind, string> = {
  localBranch: "border-graph-3 text-graph-3",
  remoteBranch: "border-border text-muted-foreground",
  tag: "border-status-ahead text-status-ahead",
  head: "border-primary text-primary",
};

const kindIcon: Record<RefKind, ReactNode> = {
  localBranch: <GitBranch className="size-3 shrink-0" aria-hidden="true" />,
  remoteBranch: <Cloud className="size-3 shrink-0" aria-hidden="true" />,
  tag: <Tag className="size-3 shrink-0" aria-hidden="true" />,
  head: null,
};

function Chip({ label }: { readonly label: RefLabel }) {
  return (
    <span
      title={label.raw}
      className={cn(
        "inline-flex max-w-[12rem] items-center gap-1 border px-1 text-[10px] leading-4",
        kindClass[label.kind],
      )}
    >
      {label.isHead && label.kind !== "head" ? (
        <span className="bg-primary text-primary-foreground px-0.5 font-semibold">HEAD</span>
      ) : null}
      {kindIcon[label.kind]}
      <span className="truncate">{label.name}</span>
    </span>
  );
}

export function RefChips({ refs }: { readonly refs: ReadonlyArray<string> }) {
  const [expanded, setExpanded] = useState(false);
  const labels = parseRefs(refs);
  if (labels.length === 0) return null;

  const visible = expanded ? labels : labels.slice(0, MAX_VISIBLE);
  const hidden = labels.length - visible.length;

  return (
    <span className="flex items-center gap-1">
      {visible.map((label) => (
        <Chip key={label.raw} label={label} />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded(true);
          }}
          title={labels
            .slice(MAX_VISIBLE)
            .map((l) => l.raw)
            .join(", ")}
          className="text-muted-foreground hover:text-foreground border px-1 text-[10px] leading-4"
        >
          +{hidden}
        </button>
      ) : null}
    </span>
  );
}
