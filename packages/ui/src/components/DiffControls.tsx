import { ChevronDown, ChevronUp, Columns2, Rows3 } from "lucide-react";

import { cn } from "../lib/cn";
import { type DiffOptions, type DiffView } from "../lib/diff";

// Diff surface controls (P1-UI-DIFF-2 / P1-DET-3): inline vs side-by-side, a whitespace
// toggle, a context-lines stepper, previous/next change navigation, and — for merges — a
// base selector to choose the parent (default: first parent) or request the combined diff.
// Whitespace, context, base, and combined map to the server DiffSpec (it recomputes the
// patch); inline/split is a client rendering preference.

const MAX_CONTEXT = 20;

export function DiffControls({
  diffView,
  onDiffViewChange,
  options,
  onOptionsChange,
  parents,
  onPrevChange,
  onNextChange,
}: {
  readonly diffView: DiffView;
  readonly onDiffViewChange: (view: DiffView) => void;
  readonly options: DiffOptions;
  readonly onOptionsChange: (options: DiffOptions) => void;
  readonly parents: ReadonlyArray<string>;
  readonly onPrevChange: () => void;
  readonly onNextChange: () => void;
}) {
  const ignoreWs = options.whitespace !== "show";
  const isMerge = parents.length >= 2;

  // Selector value: a parent index, or "combined".
  const baseValue = options.combined ? "combined" : String(parents.findIndex((p) => p === options.base));
  const onBaseChange = (value: string) => {
    if (value === "combined") {
      onOptionsChange({ ...options, combined: true, base: undefined });
      return;
    }
    const index = Number(value);
    // First parent is the default comparison: leave base unset so the server uses ^1.
    onOptionsChange({ ...options, combined: false, base: index <= 0 ? undefined : parents[index] });
  };

  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-2 border-b px-2 py-1 text-[11px]">
      <div className="flex items-center" role="group" aria-label="Diff layout">
        <button
          type="button"
          onClick={() => onDiffViewChange("inline")}
          aria-pressed={diffView === "inline"}
          aria-label="Inline diff"
          className={cn("border p-0.5", diffView === "inline" ? "bg-accent text-accent-foreground" : "")}
        >
          <Rows3 className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onDiffViewChange("split")}
          aria-pressed={diffView === "split"}
          aria-label="Side-by-side diff"
          className={cn("border p-0.5", diffView === "split" ? "bg-accent text-accent-foreground" : "")}
        >
          <Columns2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <label className="flex items-center gap-1">
        <input
          type="checkbox"
          checked={ignoreWs}
          onChange={(event) =>
            onOptionsChange({ ...options, whitespace: event.target.checked ? "ignore-all" : "show" })
          }
        />
        ignore whitespace
      </label>

      <span className="flex items-center gap-1">
        context
        <button
          type="button"
          aria-label="Fewer context lines"
          onClick={() => onOptionsChange({ ...options, context: Math.max(0, options.context - 1) })}
          className="border px-1"
        >
          −
        </button>
        <span className="w-4 text-center tabular-nums">{options.context}</span>
        <button
          type="button"
          aria-label="More context lines"
          onClick={() => onOptionsChange({ ...options, context: Math.min(MAX_CONTEXT, options.context + 1) })}
          className="border px-1"
        >
          +
        </button>
      </span>

      {isMerge ? (
        <label className="flex items-center gap-1">
          base
          <select
            value={baseValue}
            onChange={(event) => onBaseChange(event.target.value)}
            className="bg-input/40 text-foreground border px-1 py-0.5"
            aria-label="Diff base"
          >
            {parents.map((parent, index) => (
              <option key={parent} value={String(index)}>
                parent {index + 1}
              </option>
            ))}
            <option value="combined">combined</option>
          </select>
        </label>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onPrevChange} aria-label="Previous change" className="border p-0.5">
          <ChevronUp className="size-3.5" aria-hidden="true" />
        </button>
        <button type="button" onClick={onNextChange} aria-label="Next change" className="border p-0.5">
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
