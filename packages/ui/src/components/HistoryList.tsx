import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useMemo, useRef } from "react";

import { layoutCommits, maxLaneCount } from "../graph/layout";
import { cn } from "../lib/cn";
import { formatIso, shortOid } from "../lib/format";
import { useLogStream } from "../rpc/hooks";
import { GraphCell } from "./GraphCell";
import { RefChips } from "./RefChips";
import { Placeholder } from "./ui/placeholder";

const ROW_HEIGHT = 40;

// Virtualized streaming history (P1-HIST-1/2/3 + P1-UI-HIST-1): only visible rows render
// (NF-PERF-3); rows append as the feed streams in. The lane/edge commit graph (spec 10) is
// laid out incrementally from parent data and rendered per row in the graph cell.
export function HistoryList({
  repoId,
  selectedOid,
  onSelectOid,
}: {
  readonly repoId: RepoId;
  readonly selectedOid: Oid | null;
  readonly onSelectOid: (oid: Oid) => void;
}) {
  const { rows, status } = useLogStream(repoId);
  // Lane layout is append-only and viewport-independent, so recomputing from the streamed
  // window stays stable across scrolling (spec 10 REQ-GRAPH-008/020).
  const graphRows = useMemo(() => layoutCommits(rows.map((r) => ({ oid: r.oid, parents: r.parents }))), [rows]);
  const columns = useMemo(() => Math.max(1, maxLaneCount(graphRows)), [graphRows]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const moveSelection = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = selectedOid === null ? -1 : rows.findIndex((r) => r.oid === selectedOid);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(current < 0 ? 0 : current + delta, rows.length - 1));
    const nextRow = rows[nextIndex];
    if (nextRow) {
      onSelectOid(nextRow.oid);
      virtualizer.scrollToIndex(nextIndex);
    }
  };

  if (status === "error") return <Placeholder tone="danger">Could not load history.</Placeholder>;
  if (rows.length === 0) {
    const loading = status === "loading" || status === "streaming";
    return <Placeholder>{loading ? "Loading history…" : "No commits yet."}</Placeholder>;
  }

  return (
    <div
      ref={parentRef}
      tabIndex={0}
      onKeyDown={moveSelection}
      role="listbox"
      aria-label="Commit history"
      className="h-full overflow-auto outline-none"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const selected = row.oid === selectedOid;
          return (
            <div
              key={row.oid}
              role="option"
              aria-selected={selected}
              onClick={() => onSelectOid(row.oid)}
              className={cn(
                "hover:bg-accent absolute top-0 left-0 flex w-full cursor-pointer items-center gap-2 border-b pr-2 text-xs",
                selected ? "bg-accent" : "",
              )}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <GraphCell row={graphRows[item.index]!} columns={columns} height={item.size} selected={selected} />
              {row.refs.length > 0 ? <RefChips refs={row.refs} /> : null}
              <span className="flex-1 truncate">{row.subject}</span>
              <span className="text-muted-foreground w-28 truncate">{row.authorName}</span>
              <span className="text-muted-foreground w-36 truncate">{formatIso(row.authorDate)}</span>
              <span className="text-muted-foreground w-16 font-mono">{shortOid(row.oid)}</span>
            </div>
          );
        })}
      </div>
      {status === "streaming" || status === "loading" ? (
        <div className="text-muted-foreground p-2 text-center text-xs">Loading more…</div>
      ) : null}
    </div>
  );
}
