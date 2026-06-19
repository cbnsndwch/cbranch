import { type ChangeCode, type DiffFile, type Oid, type RepoId } from "@cbranch/rpc-contract";
import { useState } from "react";

import { cn } from "../lib/cn";
import { useCommitDiff } from "../rpc/hooks";
import { Placeholder } from "./ui/placeholder";

// Read-only diff (P1-DIFF-1/2/8 + P1-UI-DIFF-1): the changed-file list plus a unified
// view of the selected file. Inline/side-by-side, syntax highlighting (Shiki), the
// tree view, and large-diff deferral arrive with the diff-viewer milestone (ui-D).

const STATUS_GLYPH: Record<ChangeCode, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  updatedButUnmerged: "U",
  untracked: "?",
  ignored: "!",
  unmodified: " ",
};

export function DiffPanel({ repoId, oid }: { readonly repoId: RepoId; readonly oid: Oid | null }) {
  const { data: files, isLoading, isError } = useCommitDiff(repoId, oid);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  if (oid === null) return <Placeholder>Select a commit to see its changes.</Placeholder>;
  if (isLoading) return <Placeholder>Loading diff…</Placeholder>;
  if (isError || !files) return <Placeholder tone="danger">Could not load the diff.</Placeholder>;
  if (files.length === 0) return <Placeholder>No changes in this commit.</Placeholder>;

  const active = files.find((f) => f.newPath === selectedPath) ?? files[0]!;

  return (
    <div className="flex h-full">
      <ul className="w-1/3 min-w-40 overflow-auto border-r text-xs">
        {files.map((file) => {
          const path = file.newPath || file.oldPath;
          return (
            <li key={path}>
              <button
                type="button"
                onClick={() => setSelectedPath(file.newPath)}
                className={cn(
                  "hover:bg-accent flex w-full items-center gap-2 px-2 py-1 text-left",
                  active === file ? "bg-accent" : "",
                )}
              >
                <span className="text-muted-foreground w-3 font-mono">{STATUS_GLYPH[file.status]}</span>
                <span className="truncate">{path}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex-1 overflow-auto">
        <FileDiff file={active} />
      </div>
    </div>
  );
}

function FileDiff({ file }: { readonly file: DiffFile }) {
  if (file.isBinary) return <Placeholder>Binary file ({file.status}).</Placeholder>;
  if (file.hunks.length === 0) return <Placeholder>No textual changes ({file.status}).</Placeholder>;
  return (
    <div className="font-mono text-xs">
      {file.hunks.map((hunk, hi) => (
        <div key={hi}>
          <div className="bg-muted text-muted-foreground px-2 py-0.5">{hunk.header}</div>
          {hunk.lines.map((line, li) => (
            <div
              key={li}
              className={cn(
                "px-2 whitespace-pre",
                line.kind === "add" ? "bg-diff-add text-diff-add-foreground" : "",
                line.kind === "delete" ? "bg-diff-remove text-diff-remove-foreground" : "",
              )}
            >
              {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : " "}
              {line.content}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
