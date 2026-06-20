import { type StatusEntry } from "@cbranch/rpc-contract";

import { statusLabel } from "../lib/status";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

interface StatusChangeListProps {
  entries: StatusEntry[];
  selection: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string, staged: boolean) => void;
  staged: boolean;
  onAction: (paths: string[]) => void;
  onDestructive?: (paths: string[]) => void;
}

export function StatusChangeList({
  entries,
  selection,
  onToggle,
  onSelect,
  staged,
  onAction,
  onDestructive,
}: StatusChangeListProps) {
  if (entries.length === 0) {
    return <p className="text-muted-foreground px-4 py-2 text-xs">No changes.</p>;
  }

  return (
    <ul className="overflow-y-auto">
      {entries.map((entry) => {
        const isSelected = selection.has(entry.path);
        const label = statusLabel(entry);
        const actionLabel = staged ? "Unstage" : "Stage";

        return (
          <li
            key={entry.path + (staged ? ":staged" : ":unstaged")}
            className="group hover:bg-accent flex cursor-pointer items-center gap-1.5 px-2 py-0.5"
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggle(entry.path)}
              aria-label={`Select ${entry.path}`}
              onClick={(e) => e.stopPropagation()}
            />
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() => onSelect(entry.path, staged)}
            >
              <span className="text-muted-foreground min-w-[60px] text-xs">{label}</span>
              <span className="truncate text-xs">{entry.path}</span>
            </button>
            <div className="flex shrink-0 gap-1 opacity-0 group-hover:opacity-100">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onAction([entry.path]);
                }}
              >
                {actionLabel}
              </Button>
              {onDestructive && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive h-5 px-1.5 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDestructive([entry.path]);
                  }}
                >
                  {entry.isUntracked ? "Delete" : "Discard"}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
