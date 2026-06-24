// File-history overlay (docs/spec/08 REQ-FH-001..005, REQ-UX-010/011/012; DECISIONS D17). A
// store-driven Dialog (like the blame overlay) listing the revisions that touched a single
// path, oldest-name renames included (REQ-FH-002) — each row showing abbreviated SHA, author,
// date, and subject, with a "renamed from" indicator on rename revisions. Selecting a revision
// reveals its three actions (REQ-FH-003): View diff (the path's patch at that revision, in the
// existing diff viewer), View file at revision (the read-only editor component), and Blame
// (hands off to the blame overlay). The list paginates with a server cursor (REQ-FH-004): a
// "Load more" button fetches the next page rather than loading the whole log up front.
import {
  type FileHistoryEntry,
  type Oid,
  type RepoId,
} from "@cbranch/rpc-contract";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { buildDiffSpec, defaultDiffOptions, filePath } from "../lib/diff";
import { formatDate, formatIso, shortOid } from "../lib/format";
import { useCommitDiff, useFileHistory } from "../rpc/hooks";
import { useUiStore } from "../state/store";
import { FileAtRevision } from "./FileAtRevision";
import { RenderedDiffFile } from "./RenderedDiffFile";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Placeholder } from "./ui/placeholder";
import { Skeleton } from "./ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

/** The blame target shape the panel hands off to the blame overlay (mirrors `BlameTarget`). */
interface BlameHandoff {
  readonly rev: string;
  readonly path: string;
}

/**
 * Which sub-view the panel shows. `list` is the revision table; `diff`/`file` reuse the
 * existing diff viewer / read-only editor for the selected revision (REQ-UX-010), with a
 * Back control returning to the list.
 */
type PanelView =
  | { readonly kind: "list" }
  | { readonly kind: "diff"; readonly entry: FileHistoryEntry }
  | { readonly kind: "file"; readonly entry: FileHistoryEntry };

interface FileHistoryPanelProps {
  readonly repoId: RepoId;
  readonly path: string;
  /** A concrete oid to start the `--follow` walk from; absent = the current branch tip. */
  readonly startRev?: string;
  readonly onClose: () => void;
  /** Open a revision in the main commit view (REQ-FH-003). */
  readonly onOpenCommit: (oid: Oid) => void;
  /** Open blame for the path at a revision, reusing the blame overlay (REQ-FH-003 → REQ-BL-001). */
  readonly onBlame: (target: BlameHandoff) => void;
}

export function FileHistoryPanel({
  repoId,
  path,
  startRev,
  onClose,
  onOpenCommit,
  onBlame,
}: FileHistoryPanelProps) {
  const dateMode = useUiStore((s) => s.dateMode);
  const [view, setView] = useState<PanelView>({ kind: "list" });
  const [selectedOid, setSelectedOid] = useState<string | null>(null);

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useFileHistory(repoId, path, startRev);

  // Surface load failures as a toast in addition to the in-panel message (REQ-UX-011). A
  // next-page failure leaves the query `status: "success"` (the first page is still cached), so
  // `isError` stays false — it surfaces only via `isFetchNextPageError`; toast that too, and the
  // Load-more control below turns into a Retry so the user is never left without feedback.
  useEffect(() => {
    if (isError) toast.error(`Could not load the history of ${path}.`);
  }, [isError, path]);
  useEffect(() => {
    if (isFetchNextPageError)
      toast.error(`Could not load more history for ${path}.`);
  }, [isFetchNextPageError, path]);

  const entries = useMemo(
    () => data?.pages.flatMap((page) => page.entries) ?? [],
    [data],
  );

  const openCommit = (oid: Oid) => {
    onOpenCommit(oid);
    onClose();
  };

  const blameAt = (entry: FileHistoryEntry) => {
    onBlame({ rev: entry.oid, path: entry.path });
    onClose();
  };

  const toggleSelected = (oid: string) =>
    setSelectedOid((cur) => (cur === oid ? null : oid));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="h-[88vh] w-[94vw] max-w-5xl">
        <DialogHeader className="justify-between border-b px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {view.kind !== "list" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setView({ kind: "list" })}
                aria-label="Back to history"
              >
                ← Back
              </Button>
            )}
            <div className="min-w-0">
              <DialogTitle>File history</DialogTitle>
              <DialogDescription className="truncate font-mono" title={path}>
                {view.kind === "list"
                  ? path
                  : `${view.entry.path} @ ${shortOid(view.entry.oid)}`}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {view.kind === "diff" && (
          <HistoryDiff repoId={repoId} entry={view.entry} />
        )}

        {view.kind === "file" && (
          <div className="min-h-0 flex-1 overflow-auto">
            <FileAtRevision
              repoId={repoId}
              rev={view.entry.oid}
              path={view.entry.path}
            />
          </div>
        )}

        {view.kind === "list" && (
          <div className="min-h-0 flex-1 overflow-auto">
            {isLoading && <HistorySkeleton />}

            {/* Full-view error only when the initial load failed (no rows yet). A failure while
                paginating leaves the loaded rows below and surfaces inline (next-page errors set
                `isError` on the query even though the cached pages are retained). */}
            {isError && entries.length === 0 && (
              <div className="flex flex-col items-start gap-3 p-6 text-sm">
                <p className="text-destructive">
                  Could not load this file's history.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void refetch()}
                >
                  Retry
                </Button>
              </div>
            )}

            {!isLoading && !isError && entries.length === 0 && (
              <Placeholder>No history for this file.</Placeholder>
            )}

            {entries.length > 0 && (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">Commit</TableHead>
                      <TableHead className="w-40">Author</TableHead>
                      <TableHead className="w-32">Date</TableHead>
                      <TableHead>Subject</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => (
                      <HistoryRow
                        key={entry.oid}
                        entry={entry}
                        dateMode={dateMode}
                        selected={selectedOid === entry.oid}
                        onToggle={() => toggleSelected(entry.oid)}
                        onViewDiff={() => setView({ kind: "diff", entry })}
                        onViewFile={() => setView({ kind: "file", entry })}
                        onBlame={() => blameAt(entry)}
                        onOpenCommit={() => openCommit(entry.oid)}
                      />
                    ))}
                  </TableBody>
                </Table>

                {hasNextPage && (
                  <div className="flex flex-col items-center gap-1.5 p-3">
                    {isFetchNextPageError && (
                      <p className="text-destructive text-xs">
                        Could not load more history.
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isFetchingNextPage}
                      onClick={() => void fetchNextPage()}
                    >
                      {isFetchingNextPage
                        ? "Loading…"
                        : isFetchNextPageError
                          ? "Retry"
                          : "Load more"}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
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

interface HistoryRowProps {
  readonly entry: FileHistoryEntry;
  readonly dateMode: "relative" | "absolute";
  readonly selected: boolean;
  readonly onToggle: () => void;
  readonly onViewDiff: () => void;
  readonly onViewFile: () => void;
  readonly onBlame: () => void;
  readonly onOpenCommit: () => void;
}

function HistoryRow({
  entry,
  dateMode,
  selected,
  onToggle,
  onViewDiff,
  onViewFile,
  onBlame,
  onOpenCommit,
}: HistoryRowProps) {
  return (
    <>
      <TableRow
        className="cursor-pointer"
        data-state={selected ? "selected" : undefined}
        aria-expanded={selected}
        aria-label={`Revision ${shortOid(entry.oid)}`}
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <TableCell className="text-primary font-mono">
          {shortOid(entry.oid)}
        </TableCell>
        <TableCell className="truncate" title={entry.authorEmail}>
          {entry.authorName}
        </TableCell>
        <TableCell
          className="text-muted-foreground whitespace-nowrap"
          title={formatIso(entry.authorDate)}
        >
          {formatDate(entry.authorDate, dateMode)}
        </TableCell>
        <TableCell>
          <span className="truncate">{entry.subject}</span>
          {entry.oldPath && (
            // Rename indicator: the path differed at this revision (REQ-FH-002 / AC-13).
            <span
              className="text-muted-foreground mt-0.5 block truncate font-mono text-[11px]"
              title={entry.oldPath}
            >
              ↳ renamed from {entry.oldPath}
            </span>
          )}
        </TableCell>
      </TableRow>

      {selected && (
        <TableRow className="bg-muted/40">
          <TableCell colSpan={4} className="py-1.5">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={onViewDiff}>
                View diff
              </Button>
              <Button size="sm" variant="outline" onClick={onViewFile}>
                View file at revision
              </Button>
              <Button size="sm" variant="outline" onClick={onBlame}>
                Blame
              </Button>
              <Button size="sm" variant="ghost" onClick={onOpenCommit}>
                Open commit
              </Button>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** The path's patch at one revision, scoped to the path and shown in the existing diff viewer. */
function HistoryDiff({
  repoId,
  entry,
}: {
  readonly repoId: RepoId;
  readonly entry: FileHistoryEntry;
}) {
  const diffView = useUiStore((s) => s.diffView);
  const [forced, setForced] = useState(false);
  // Scope the diff to the path at this revision. On a rename/copy revision the prior name must
  // be in the pathspec too, or git filters the deletion out before rename detection runs and
  // reports the file as a fresh add of its whole content rather than the real change (AC-13).
  const spec = useMemo(
    () =>
      buildDiffSpec(
        repoId,
        entry.oid,
        defaultDiffOptions,
        entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
      ),
    [repoId, entry],
  );
  const { data: files, isLoading, isError } = useCommitDiff(spec);

  useEffect(() => {
    if (isError) toast.error(`Could not load the diff for ${entry.path}.`);
  }, [isError, entry.path]);

  if (isLoading) return <Placeholder>Loading diff…</Placeholder>;
  if (isError || !files)
    return <Placeholder tone="danger">Could not load the diff.</Placeholder>;

  // The rename filepair's new side is `entry.path`; fall back to the first entry defensively.
  const file = files.find((f) => filePath(f) === entry.path) ?? files[0];
  if (!file)
    return (
      <Placeholder>No changes to {entry.path} in this revision.</Placeholder>
    );

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <RenderedDiffFile
        file={file}
        diffView={diffView}
        forced={forced}
        onForce={() => setForced(true)}
      />
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-2 p-3" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-24" />
          <Skeleton
            className="h-3 flex-1"
            style={{ maxWidth: `${30 + ((i * 31) % 50)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
