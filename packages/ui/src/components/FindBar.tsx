import { ChevronDown, ChevronUp, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";

// The quick-find bar over loaded history (P1-UI-FILT-2): a focused input with a live match
// counter and previous/next stepping. Enter / Shift+Enter step matches; Escape closes.
export function FindBar({
  query,
  matchCount,
  current,
  onQueryChange,
  onStep,
  onClose,
}: {
  readonly query: string;
  readonly matchCount: number;
  /** Zero-based pointer into the matches, or -1 when none. */
  readonly current: number;
  readonly onQueryChange: (value: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const counter =
    query.trim() === ""
      ? ""
      : matchCount === 0
        ? "no matches"
        : `${current + 1} / ${matchCount}`;

  return (
    <div className="flex items-center gap-1 border-b px-2 py-1">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Find in loaded history (message or hash)…"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Find in loaded history"
        className="bg-input/40 text-foreground focus:border-ring flex-1 border px-1 py-0.5 text-xs outline-none"
      />
      <span
        className="text-muted-foreground w-20 text-right text-[11px]"
        aria-live="polite"
      >
        {counter}
      </span>
      <button
        type="button"
        onClick={() => onStep(-1)}
        disabled={matchCount === 0}
        aria-label="Previous match"
        className="text-muted-foreground hover:text-foreground border p-0.5 disabled:opacity-40"
      >
        <ChevronUp className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onStep(1)}
        disabled={matchCount === 0}
        aria-label="Next match"
        className="text-muted-foreground hover:text-foreground border p-0.5 disabled:opacity-40"
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close find"
        className="text-muted-foreground hover:text-foreground border p-0.5"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
