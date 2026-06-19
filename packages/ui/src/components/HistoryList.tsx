import { type LogQuery, type Oid } from "@cbranch/rpc-contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";

import { layoutCommits, maxLaneCount } from "../graph/layout";
import { cn } from "../lib/cn";
import { type DateMode, formatDate, formatIso, formatRelativeMs, shortOid } from "../lib/format";
import { useLogStream } from "../rpc/hooks";
import { GraphCell } from "./GraphCell";
import { RefChips } from "./RefChips";
import { Placeholder } from "./ui/placeholder";

const ROW_HEIGHT = 40;

// Virtualized streaming history (P1-HIST-1/2/3 + P1-UI-HIST-1): only visible rows render
// (NF-PERF-3); rows append as the feed streams in. The lane/edge commit graph (spec 10) is
// laid out incrementally from parent data and rendered per row in the graph cell. Dates
// honor the relative/absolute preference with the alternate available on hover (P1-HIST-8).
export function HistoryList({
  query,
  dateMode,
  filtersActive,
  selectedOid,
  onSelectOid,
}: {
  readonly query: LogQuery | null;
  readonly dateMode: DateMode;
  readonly filtersActive: boolean;
  readonly selectedOid: Oid | null;
  readonly onSelectOid: (oid: Oid) => void;
}) {
  const { rows, status } = useLogStream(query);
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

  // Changing any filter resets virtualization/scroll to the top of the new results (P1-FILT-8).
  const queryKey = query === null ? null : JSON.stringify(query);
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [queryKey]);

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
    if (loading) return <Placeholder>Loading history…</Placeholder>;
    // Distinguish a real empty repo from a no-match filter result (P1-FILT-9).
    return <Placeholder>{filtersActive ? "No commits match the current filters." : "No commits yet."}</Placeholder>;
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
          const date = new Date(row.authorDate);
          const valid = !Number.isNaN(date.getTime());
          const alternate = !valid
            ? row.authorDate
            : dateMode === "relative"
              ? formatIso(row.authorDate)
              : formatRelativeMs(date.getTime());
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
              <span className="text-muted-foreground w-36 truncate" title={alternate}>
                {formatDate(row.authorDate, dateMode)}
              </span>
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
