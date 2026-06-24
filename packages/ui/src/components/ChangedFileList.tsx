import { type ChangeCode, type DiffFile } from "@cbranch/rpc-contract";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  File,
  FileCog,
  FileMinus,
  FilePlus,
  FileSymlink,
  type LucideIcon,
  SquarePen,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";

import { cn } from "../lib/cn";
import {
  allDirPaths,
  buildFileTree,
  diffTotals,
  flatRows,
  treeRows,
} from "../lib/diff";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Changed-file list (P1-DIFF-2 / P1-UI-DIFF-1): flat or directory-tree view, each entry a
// Lucide status icon and (for renames/copies) old → new paths; virtualized for large change
// sets; a header with the total files changed and aggregate added/removed counts.

const ROW_HEIGHT = 24;

const STATUS_ICON: Record<ChangeCode, LucideIcon> = {
  added: FilePlus,
  modified: SquarePen,
  deleted: FileMinus,
  renamed: FileSymlink,
  copied: Copy,
  typeChanged: FileCog,
  updatedButUnmerged: FileCog,
  untracked: FilePlus,
  ignored: File,
  unmodified: File,
};

const STATUS_TONE: Partial<Record<ChangeCode, string>> = {
  added: "text-status-ahead",
  deleted: "text-destructive",
  modified: "text-status-behind",
  renamed: "text-primary",
  copied: "text-primary",
};

function StatusIcon({ status }: { readonly status: ChangeCode }) {
  const Icon = STATUS_ICON[status];
  return (
    <Icon
      className={cn(
        "size-3.5 shrink-0",
        STATUS_TONE[status] ?? "text-muted-foreground",
      )}
      aria-hidden="true"
    />
  );
}

function FileLabel({ file }: { readonly file: DiffFile }): ReactNode {
  // Renames/copies show both paths (similarity is not carried by the contract, P1-DIFF-1).
  if (
    (file.status === "renamed" || file.status === "copied") &&
    file.oldPath &&
    file.oldPath !== file.newPath
  ) {
    return (
      <span className="truncate">
        <span className="text-muted-foreground">{file.oldPath} → </span>
        {file.newPath}
      </span>
    );
  }
  return <span className="truncate">{file.newPath || file.oldPath}</span>;
}

export function ChangedFileList({
  files,
  selectedPath,
  onSelect,
  onBlame,
  onHistory,
}: {
  readonly files: ReadonlyArray<DiffFile>;
  readonly selectedPath: string | null;
  readonly onSelect: (path: string) => void;
  /** When set, each file row's "…" actions menu offers Blame — REQ-UX-012. */
  readonly onBlame?: (path: string) => void;
  /** When set, each file row's "…" actions menu offers File history — REQ-UX-012. */
  readonly onHistory?: (path: string) => void;
}) {
  const [mode, setMode] = useState<"flat" | "tree">("flat");
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const expanded = useMemo(() => {
    const all = new Set(allDirPaths(tree));
    for (const path of collapsed) all.delete(path);
    return all;
  }, [tree, collapsed]);

  const rows = useMemo(
    () => (mode === "flat" ? flatRows(files) : treeRows(tree, expanded)),
    [mode, files, tree, expanded],
  );
  const totals = useMemo(() => diffTotals(files), [files]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="flex h-full flex-col border-r">
      <div className="text-muted-foreground flex items-center gap-2 border-b px-2 py-1 text-[11px]">
        <span>
          {totals.files} file{totals.files === 1 ? "" : "s"}
        </span>
        <span className="text-status-ahead">+{totals.additions}</span>
        <span className="text-destructive">-{totals.deletions}</span>
        <div
          className="ml-auto flex items-center"
          role="group"
          aria-label="File list view"
        >
          {(["flat", "tree"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cn(
                "border px-1 capitalize first:rounded-l last:rounded-r",
                mode === m ? "bg-accent text-accent-foreground" : "",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-auto text-xs"
        role="listbox"
        aria-label="Changed files"
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
            const indent = 4 + row.depth * 12;
            const isSelected = row.kind === "file" && row.path === selectedPath;
            return (
              <div
                key={`${row.kind}:${row.path}`}
                role={row.kind === "file" ? "option" : undefined}
                aria-selected={row.kind === "file" ? isSelected : undefined}
                className="absolute top-0 left-0 w-full"
                style={{
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {row.kind === "dir" ? (
                  <button
                    type="button"
                    onClick={() => toggleDir(row.path)}
                    style={{ paddingLeft: indent }}
                    className="hover:bg-accent text-muted-foreground flex h-full w-full items-center gap-1 pr-2 text-left"
                  >
                    {expanded.has(row.path) ? (
                      <ChevronDown
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <ChevronRight
                        className="size-3 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{row.name}</span>
                  </button>
                ) : (
                  <div
                    className={cn(
                      "group hover:bg-accent flex h-full w-full items-center",
                      isSelected ? "bg-accent" : "",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(row.path)}
                      style={{ paddingLeft: indent }}
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left"
                    >
                      <StatusIcon status={row.file!.status} />
                      {mode === "tree" ? (
                        <span className="truncate">{row.name}</span>
                      ) : (
                        <FileLabel file={row.file!} />
                      )}
                    </button>
                    {(onBlame || onHistory) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Actions for ${row.path}`}
                          className="hover:bg-accent mr-1 flex size-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
                        >
                          …
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="bottom" align="end">
                          {onBlame && (
                            <DropdownMenuItem onClick={() => onBlame(row.path)}>
                              Blame
                            </DropdownMenuItem>
                          )}
                          {onHistory && (
                            <DropdownMenuItem
                              onClick={() => onHistory(row.path)}
                            >
                              File history
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
