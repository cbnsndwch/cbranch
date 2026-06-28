import { Cloud, GitBranch, Tag } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../lib/cn";
import { parseRefs, type RefKind, type RefLabel } from "../lib/refs";

// Ref/branch/tag chips on a history row (P1-UI-HIST-4; spec 10 REQ-GRAPH-012/013/015).
// Each kind is visually distinguished; the current HEAD branch carries a HEAD marker
// (REQ-GRAPH-014); overflow past a small cap collapses into an expandable "+N"
// affordance rather than truncating silently (REQ-GRAPH-015).

const MAX_VISIBLE = 3;

// Tags / detached-HEAD keep theme tokens; local & remote branches are colored below.
const kindClass: Record<"tag" | "head", string> = {
  tag: "border-status-ahead text-status-ahead",
  head: "border-primary text-primary",
};

// Local branches (except the active HEAD branch) read green, remote-tracking branches
// red — fixed light-bg/dark-text palette colors so the pill looks the same in light and
// dark mode. The active local branch keeps its distinct staged-color chip.
function chipClass(label: RefLabel): string {
  if (label.kind === "remoteBranch")
    return "border-0 bg-red-100 px-1.5 text-red-800";
  if (label.kind === "localBranch")
    return label.isHead
      ? "bg-[var(--color-status-staged)] text-white border-0 px-1.5 font-semibold"
      : "border-0 bg-green-100 px-1.5 text-green-800";
  return kindClass[label.kind];
}

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
        "inline-flex max-w-48 items-center gap-1 border px-1 text-[10px] leading-4",
        chipClass(label),
      )}
    >
      {label.isHead && label.kind !== "head" ? (
        <span className="bg-primary text-white px-0.5 font-bold">HEAD</span>
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
