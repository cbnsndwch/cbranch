// Blame overlay (docs/spec/08 REQ-BL-001..006, REQ-UX-009/011/012; DECISIONS D17). A
// virtualized, line-aligned view: a left gutter shows the owning commit once per contiguous
// block (REQ-BL-003), beside the source line. Clicking a block's attribution opens a Popover
// with the full SHA / author / date / subject and per-block actions — "Open commit"
// (REQ-BL-005) and "Blame previous revision" (REQ-BL-004), which re-blames the parent of the
// owning commit at that line's prior path, maintaining a back-stack to walk history.
//
// Blame is content-addressed by a concrete oid (the caller resolves the revision before
// opening), so the result never goes stale. Large files are size-capped server-side
// (REQ-EDGE-010); the cap arm offers "Blame anyway" (force) and the whole view offers a
// "Syntax highlighting" toggle so a huge file can be shown without the Shiki pass.
import {
  type BlameCommit,
  type BlameData,
  type BlameResult,
  type Oid,
  type RepoId,
} from "@cbranch/rpc-contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  blockStartIndices,
  groupBlameBlocks,
  indexCommits,
} from "../lib/blame-blocks";
import { cn } from "../lib/cn";
import { formatInstant, shortOid } from "../lib/format";
import {
  languageForPath,
  loadShikiLines,
  type ShikiToken,
} from "../lib/shiki-highlighter";
import { useBlame } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Skeleton } from "./ui/skeleton";

const NL = String.fromCharCode(10);
const ROW_HEIGHT = 20;
const GUTTER_W = 188;
const NUM_W = 52;
// Monospace advance at 12px — only used to size the horizontal scroll extent; an estimate is
// fine (a few px off merely over/under-scrolls slightly, never clips selection or layout).
const CHAR_W = 7.3;

const isBlameData = (data: BlameResult | undefined): data is BlameData =>
  data !== undefined && "lines" in data;

/**
 * A frame in the blame-previous back-stack (REQ-BL-004). `forced` is per-frame so it can't
 * leak across navigation: walking back to a deliberately-forced frame keeps it forced, and a
 * fresh blame-previous starts un-forced — both without a deferred-reset race.
 */
interface BlameFrame {
  readonly rev: string;
  readonly path: string;
  readonly forced: boolean;
}

interface BlamePanelProps {
  readonly repoId: RepoId;
  readonly rev: string;
  readonly path: string;
  readonly onClose: () => void;
  /** Open the owning commit in the main commit view (REQ-BL-005). */
  readonly onOpenCommit: (oid: Oid) => void;
}

export function BlamePanel({
  repoId,
  rev,
  path,
  onClose,
  onOpenCommit,
}: BlamePanelProps) {
  // The blame-previous back-stack (REQ-BL-004); the top frame is what's currently shown.
  const [stack, setStack] = useState<ReadonlyArray<BlameFrame>>([
    { rev, path, forced: false },
  ]);
  const [highlight, setHighlight] = useState(true);
  const dateMode = useUiStore((s) => s.dateMode);
  const theme = useUiStore((s) => s.theme);

  const current = stack[stack.length - 1]!;
  const { data, isLoading, isError, refetch } = useBlame(
    repoId,
    current.rev,
    current.path,
    current.forced,
  );

  // Surface load failures as a toast in addition to the in-panel message (REQ-UX-011).
  useEffect(() => {
    if (isError) toast.error(`Could not blame ${current.path}.`);
  }, [isError, current.path]);

  const blame = isBlameData(data) ? data : null;
  const tooLarge = data !== undefined && !isBlameData(data) ? data : null;

  const blocks = useMemo(
    () => (blame ? groupBlameBlocks(blame.lines) : []),
    [blame],
  );
  const starts = useMemo(() => blockStartIndices(blocks), [blocks]);
  const commits = useMemo(
    () =>
      blame ? indexCommits(blame.commits) : new Map<string, BlameCommit>(),
    [blame],
  );

  // Tokenize the whole file once per (data / toggle / theme) for per-line coloring. Shiki
  // loads on demand and resolves to null when the language is unknown or it fails — the view
  // then shows plain, unhighlighted text (REQ-UX-009 "proceed without highlighting").
  const [tokens, setTokens] = useState<ReadonlyArray<
    ReadonlyArray<ShikiToken>
  > | null>(null);
  useEffect(() => {
    // Clear first so a frame change never paints the PREVIOUS frame's tokens against the new
    // lines: when the next frame's data is cache-immediate, `blame` goes non-null→non-null
    // without passing through null, and the async re-tokenize below resolves a tick later.
    setTokens(null);
    if (!blame || !highlight) return;
    const language = languageForPath(current.path);
    if (!language) return;
    let cancelled = false;
    const code = blame.lines.map((l) => l.content).join(NL);
    const dark =
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark");
    void loadShikiLines({ code, language, dark }).then((lines) => {
      if (!cancelled) setTokens(lines);
    });
    return () => {
      cancelled = true;
    };
    // `theme` re-tokenizes on a light/dark switch (the `dark` class mutation alone won't
    // re-fire this effect) — mirrors FileAtRevision/MergeEditor.
  }, [blame, highlight, current.path, theme]);

  const blamePrevious = (commit: BlameCommit) => {
    if (commit.previousOid === undefined) return;
    setStack((s) => {
      const cur = s[s.length - 1]!;
      return [
        ...s,
        {
          rev: commit.previousOid as string,
          path: commit.previousPath ?? cur.path,
          forced: false,
        },
      ];
    });
  };

  const goBack = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  // Proceed past the large-file cap (REQ-EDGE-010): force this frame AND turn highlighting
  // off, since the Shiki pass over a multi-MB file is the cost the cap exists to avoid.
  const blameAnyway = () => {
    setHighlight(false);
    setStack((s) => [...s.slice(0, -1), { ...s[s.length - 1]!, forced: true }]);
  };

  const openCommit = (oid: Oid) => {
    onOpenCommit(oid);
    onClose();
  };

  const maxChars = useMemo(
    () =>
      blame
        ? blame.lines.reduce((m, l) => Math.max(m, l.content.length), 0)
        : 0,
    [blame],
  );
  const rowWidth = GUTTER_W + NUM_W + Math.max(120, maxChars * CHAR_W);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="h-[88vh] w-[94vw] max-w-6xl">
        <DialogHeader className="justify-between border-b px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {stack.length > 1 && (
              <Button
                size="sm"
                variant="outline"
                onClick={goBack}
                aria-label="Back to previous blame"
              >
                ← Back
              </Button>
            )}
            <div className="min-w-0">
              <DialogTitle>Blame</DialogTitle>
              <DialogDescription
                className="truncate font-mono"
                title={current.path}
              >
                {current.path} @ {shortOid(current.rev)}
              </DialogDescription>
            </div>
          </div>
          <label className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={highlight}
              onChange={(e) => setHighlight(e.target.checked)}
            />
            Syntax highlighting
          </label>
        </DialogHeader>

        {isLoading && <BlameSkeleton />}

        {isError && (
          <div className="flex flex-1 flex-col items-start gap-3 p-6 text-sm">
            <p className="text-destructive">Could not blame this file.</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        )}

        {tooLarge && (
          <div className="flex flex-1 flex-col items-start gap-2 p-6 text-sm">
            <p className="font-medium">File too large to blame in app</p>
            <p className="text-muted-foreground">
              {tooLarge.byteSize.toLocaleString()} bytes exceeds the inline
              blame limit. Blaming it anyway may be slow.
            </p>
            <Button size="sm" className="mt-2" onClick={blameAnyway}>
              Blame anyway
            </Button>
          </div>
        )}

        {blame && (
          <BlameList
            blame={blame}
            starts={starts}
            commits={commits}
            tokens={highlight ? tokens : null}
            dateMode={dateMode}
            rowWidth={rowWidth}
            onOpenCommit={openCommit}
            onBlamePrevious={blamePrevious}
          />
        )}

        <DialogFooter className="flex-row justify-end border-t px-4 py-2">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlameSkeleton() {
  return (
    <div className="flex-1 space-y-1 overflow-hidden p-3" aria-hidden="true">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3" style={{ width: GUTTER_W - 24 }} />
          <Skeleton
            className="h-3 flex-1"
            style={{ maxWidth: `${20 + ((i * 37) % 60)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

interface BlameListProps {
  readonly blame: BlameData;
  readonly starts: ReadonlySet<number>;
  readonly commits: ReadonlyMap<string, BlameCommit>;
  readonly tokens: ReadonlyArray<ReadonlyArray<ShikiToken>> | null;
  readonly dateMode: "relative" | "absolute";
  readonly rowWidth: number;
  readonly onOpenCommit: (oid: Oid) => void;
  readonly onBlamePrevious: (commit: BlameCommit) => void;
}

function BlameList({
  blame,
  starts,
  commits,
  tokens,
  dateMode,
  rowWidth,
  onOpenCommit,
  onBlamePrevious,
}: BlameListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: blame.lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  return (
    <div
      ref={parentRef}
      className="min-h-0 flex-1 overflow-auto font-mono text-xs leading-5"
      role="list"
      aria-label={`Blame for ${blame.path}`}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: rowWidth,
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const line = blame.lines[item.index]!;
          const isStart = starts.has(item.index);
          const owner = isStart ? commits.get(line.ownerOid) : undefined;
          return (
            <div
              key={item.index}
              role="listitem"
              className={cn(
                "hover:bg-accent/40 absolute top-0 left-0 flex items-center border-l",
                // A hairline at each block boundary visually associates a contiguous block
                // with its single attribution (REQ-BL-003), while every line keeps its row.
                isStart && item.index > 0 && "border-border/60 border-t",
              )}
              style={{
                height: item.size,
                width: rowWidth,
                transform: `translateY(${item.start}px)`,
              }}
            >
              <div
                className="text-muted-foreground flex h-full shrink-0 items-center overflow-hidden border-r pr-1 pl-2"
                style={{ width: GUTTER_W }}
              >
                {owner ? (
                  <BlameGutterCell
                    commit={owner}
                    dateMode={dateMode}
                    onOpenCommit={onOpenCommit}
                    onBlamePrevious={onBlamePrevious}
                  />
                ) : null}
              </div>
              <span
                className="text-muted-foreground/70 shrink-0 px-2 text-right tabular-nums select-none"
                style={{ width: NUM_W }}
              >
                {line.finalLineNo}
              </span>
              <span className="whitespace-pre pr-4">
                {renderLine(line.content, tokens?.[item.index])}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function renderLine(
  content: string,
  lineTokens: ReadonlyArray<ShikiToken> | undefined,
) {
  if (!lineTokens || lineTokens.length === 0) return content;
  return lineTokens.map((t, i) => (
    <span key={i} style={t.color ? { color: t.color } : undefined}>
      {t.content}
    </span>
  ));
}

interface BlameGutterCellProps {
  readonly commit: BlameCommit;
  readonly dateMode: "relative" | "absolute";
  readonly onOpenCommit: (oid: Oid) => void;
  readonly onBlamePrevious: (commit: BlameCommit) => void;
}

function BlameGutterCell({
  commit,
  dateMode,
  onOpenCommit,
  onBlamePrevious,
}: BlameGutterCellProps) {
  return (
    <Popover>
      <PopoverTrigger
        className="hover:text-foreground flex w-full items-center gap-1.5 truncate text-left"
        aria-label={`Blame details for ${shortOid(commit.oid)}`}
      >
        <span className="text-primary shrink-0">{shortOid(commit.oid)}</span>
        <span className="truncate">{commit.authorName}</span>
        <span className="text-muted-foreground/70 ml-auto shrink-0 pl-1">
          {formatInstant(commit.authorTime, dateMode)}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="font-sans">
        <div className="space-y-1.5">
          <p className="text-sm leading-snug font-medium">{commit.summary}</p>
          <p className="font-mono text-[11px] break-all select-all">
            {commit.oid}
          </p>
          <p className="text-muted-foreground text-[11px]">
            {commit.authorName} &lt;{commit.authorEmail}&gt;
          </p>
          <p className="text-muted-foreground text-[11px]">
            {formatInstant(commit.authorTime, "absolute")}
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => onOpenCommit(commit.oid)}>
            Open commit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={commit.previousOid === undefined}
            onClick={() => onBlamePrevious(commit)}
          >
            Blame previous
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
