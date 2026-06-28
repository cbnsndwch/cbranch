import { type LogQuery, type Oid } from "@cbranch/rpc-contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { layoutCommits, maxLaneCount } from "../graph/layout";
import { cn } from "../lib/cn";
import {
  type DateMode,
  formatDate,
  formatIso,
  formatRelativeMs,
  shortOid,
} from "../lib/format";
import { findMatches, stepMatch } from "../lib/quick-find";
import { useLogStream } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { FindBar } from "./FindBar";
import { GraphCell } from "./GraphCell";
import { RefChips } from "./RefChips";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Placeholder } from "./ui/placeholder";

const ROW_HEIGHT = 26;
const DEFAULT_PAGE = 10;

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  return (
    parts
      .map((p) => p[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
};

// Virtualized streaming history (P1-HIST-1/2/3 + P1-UI-HIST-1): only visible rows render
// (NF-PERF-3); rows append as the feed streams in. The lane/edge commit graph (spec 10) is
// laid out incrementally from parent data and rendered per row in the graph cell. Dates
// honor the relative/absolute preference with the alternate available on hover (P1-HIST-8).
// Full keyboard navigation (P1-HIST-6) and a quick incremental find (P1-FILT-7) operate
// over the loaded window.
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
  const setKnownRefStrings = useUiStore((s) => s.setKnownRefStrings);
  const setPickDialog = useUiStore((s) => s.setPickDialog);
  useEffect(() => {
    const allRefs = [...new Set(rows.flatMap((r) => r.refs))];
    setKnownRefStrings(allRefs);
  }, [rows, setKnownRefStrings]);

  // Lane layout is append-only and viewport-independent, so recomputing from the streamed
  // window stays stable across scrolling (spec 10 REQ-GRAPH-008/020).
  const graphRows = useMemo(
    () => layoutCommits(rows.map((r) => ({ oid: r.oid, parents: r.parents }))),
    [rows],
  );
  const columns = useMemo(
    () => Math.max(1, maxLaneCount(graphRows)),
    [graphRows],
  );
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findPos, setFindPos] = useState(-1);
  const matches = useMemo(
    () => findMatches(rows, findQuery),
    [rows, findQuery],
  );
  const matchOids = useMemo(
    () => new Set(matches.map((i) => rows[i]!.oid)),
    [matches, rows],
  );
  const currentMatchOid =
    findPos >= 0 && findPos < matches.length
      ? rows[matches[findPos]!]?.oid
      : undefined;

  const selectIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      onSelectOid(row.oid);
      virtualizer.scrollToIndex(index);
    },
    [rows, onSelectOid, virtualizer],
  );

  // Changing any filter resets virtualization/scroll to the top of the new results (P1-FILT-8).
  const queryKey = query === null ? null : JSON.stringify(query);
  useEffect(() => {
    parentRef.current?.scrollTo({ top: 0 });
  }, [queryKey]);

  // Open quick-find on the conventional shortcut, even when the list is not focused (P1-UI-FILT-2).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // As the find query changes, jump to the first match (responsive find, P1-FILT-7).
  const firstMatch = matches[0];
  useEffect(() => {
    if (findQuery.trim() === "" || matches.length === 0) {
      setFindPos(-1);
      return;
    }
    setFindPos(0);
    if (firstMatch !== undefined) selectIndex(firstMatch);
    // selectIndex is stable per rows; intentionally keyed on the query + match set only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, matches.length]);

  const stepFind = (direction: 1 | -1) => {
    const next = stepMatch(matches.length, findPos, direction);
    setFindPos(next);
    if (next >= 0) selectIndex(matches[next]!);
  };

  const closeFind = () => {
    setFindOpen(false);
    setFindQuery("");
    setFindPos(-1);
  };

  // Full keyboard navigation over the list (P1-HIST-6): arrows, page up/down, home/end.
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(
      1,
      Math.floor((parentRef.current?.clientHeight ?? 0) / ROW_HEIGHT) ||
        DEFAULT_PAGE,
    );
    const current =
      selectedOid === null ? -1 : rows.findIndex((r) => r.oid === selectedOid);
    const last = rows.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : Math.min(current + 1, last);
        break;
      case "ArrowUp":
        next = current < 0 ? 0 : Math.max(current - 1, 0);
        break;
      case "PageDown":
        next = current < 0 ? 0 : Math.min(current + page, last);
        break;
      case "PageUp":
        next = current < 0 ? 0 : Math.max(current - page, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next !== null) selectIndex(next);
  };

  // The same two commit operations back both the hover `…` dropdown and the right-click
  // context menu, so a row's actions stay identical however the user reaches them.
  const cherryPickCommit = (target: Oid, subject: string) =>
    setPickDialog({ kind: "cherryPick", commits: [{ oid: target, subject }] });
  const revertCommit = (target: Oid, subject: string) =>
    setPickDialog({ kind: "revert", commits: [{ oid: target, subject }] });

  if (status === "error")
    return <Placeholder tone="danger">Could not load history.</Placeholder>;

  const findBar = findOpen ? (
    <FindBar
      query={findQuery}
      matchCount={matches.length}
      current={findPos}
      onQueryChange={setFindQuery}
      onStep={stepFind}
      onClose={closeFind}
    />
  ) : null;

  if (rows.length === 0) {
    const loading = status === "loading" || status === "streaming";
    const message = loading
      ? "Loading history…"
      : filtersActive
        ? "No commits match the current filters."
        : "No commits yet.";
    return (
      <div className="flex h-full flex-col">
        {findBar}
        <Placeholder>{message}</Placeholder>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {findBar}
      <div
        ref={parentRef}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        role="listbox"
        aria-label="Commit history"
        className="min-h-0 flex-1 overflow-auto outline-none"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]!;
            const selected = row.oid === selectedOid;
            const matched = matchOids.has(row.oid);
            const isCurrentMatch = row.oid === currentMatchOid;
            const date = new Date(row.authorDate);
            const valid = !Number.isNaN(date.getTime());
            const alternate = !valid
              ? row.authorDate
              : dateMode === "relative"
                ? formatIso(row.authorDate)
                : formatRelativeMs(date.getTime());
            return (
              <ContextMenu key={row.oid}>
                <ContextMenuTrigger
                  render={
                    <div
                      role="option"
                      aria-selected={selected}
                      onClick={() => onSelectOid(row.oid)}
                      className={cn(
                        "group hover:bg-accent absolute top-0 left-0 flex w-full cursor-pointer items-center gap-2 border-b pr-2 text-xs",
                        selected
                          ? "bg-(--color-selection-bg) text-(--color-selection-fg)"
                          : "",
                        matched ? "bg-status-ahead/10" : "",
                        isCurrentMatch ? "ring-ring ring-1 ring-inset" : "",
                      )}
                      style={{
                        height: item.size,
                        transform: `translateY(${item.start}px)`,
                      }}
                    />
                  }
                >
                  <GraphCell
                    row={graphRows[item.index]!}
                    columns={columns}
                    height={item.size}
                    selected={selected}
                  />
                  {row.refs.length > 0 ? <RefChips refs={row.refs} /> : null}
                  <span className="flex-1 truncate">{row.subject}</span>
                  <div
                    className="flex size-5.5 shrink-0 items-center justify-center text-[9px] font-semibold text-white"
                    style={{
                      background: "var(--color-status-staged)",
                    }}
                    aria-hidden="true"
                  >
                    {initials(row.authorName)}
                  </div>
                  <span className="w-30 truncate">{row.authorName}</span>
                  <span className="w-27.5 truncate" title={alternate}>
                    {formatDate(row.authorDate, dateMode)}
                  </span>
                  <span className="w-20 font-mono">{shortOid(row.oid)}</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Actions for ${shortOid(row.oid)}`}
                      className="hover:bg-accent flex size-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100 data-popup-open:opacity-100"
                    >
                      …
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="end">
                      <DropdownMenuItem
                        onClick={() => cherryPickCommit(row.oid, row.subject)}
                      >
                        Cherry-pick…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => revertCommit(row.oid, row.subject)}
                      >
                        Revert…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onClick={() => cherryPickCommit(row.oid, row.subject)}
                  >
                    Cherry-pick…
                  </ContextMenuItem>
                  <ContextMenuItem
                    onClick={() => revertCommit(row.oid, row.subject)}
                  >
                    Revert…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        {status === "streaming" || status === "loading" ? (
          <div className="text-muted-foreground p-2 text-center text-xs">
            Loading more…
          </div>
        ) : null}
      </div>
    </div>
  );
}
