// A minimal two-pane resizable split (docs/design/commit-surface.md §3 — the commit
// dialog body is a changes|diff split with a draggable divider). The split position is
// *controlled* (the caller persists it); this component only translates a pointer drag
// over the divider into a clamped fraction. Keyboard-accessible: the divider is a
// focusable `separator` that nudges with the arrow keys. `orientation` picks left|right
// (horizontal, the default) or top|bottom (vertical, e.g. the history/details split).

import { useCallback, useId, useRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

type Orientation = "horizontal" | "vertical";

interface ResizableSplitProps {
  /** Fraction (0..1) of the size given to the first (left/top) pane. */
  readonly fraction: number;
  readonly onFractionChange: (fraction: number) => void;
  /** First pane — left when horizontal, top when vertical. */
  readonly left: ReactNode;
  /** Second pane — right when horizontal, bottom when vertical. */
  readonly right: ReactNode;
  /** Split direction; "horizontal" (left|right) by default. */
  readonly orientation?: Orientation;
  /** Clamp bounds so neither pane collapses. */
  readonly min?: number;
  readonly max?: number;
  /** Accessible name for the divider. */
  readonly label?: string;
  readonly className?: string;
}

export function ResizableSplit({
  fraction,
  onFractionChange,
  left,
  right,
  orientation = "horizontal",
  min = 0.2,
  max = 0.7,
  label = "Resize changes and diff",
  className,
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const vertical = orientation === "vertical";
  const clamp = useCallback(
    (f: number) => Math.min(max, Math.max(min, f)),
    [min, max],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const extent = vertical ? rect.height : rect.width;
      if (extent === 0) return;
      const pos = vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
      onFractionChange(clamp(pos / extent));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const decrease = vertical ? "ArrowUp" : "ArrowLeft";
    const increase = vertical ? "ArrowDown" : "ArrowRight";
    if (e.key === decrease) {
      e.preventDefault();
      onFractionChange(clamp(fraction - 0.02));
    } else if (e.key === increase) {
      e.preventDefault();
      onFractionChange(clamp(fraction + 0.02));
    }
  };

  const pct = Math.round(clamp(fraction) * 100);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0",
        vertical ? "h-full flex-col" : "w-full",
        className,
      )}
      style={{ ["--split" as string]: `${pct}%` }}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={vertical ? { height: `${pct}%` } : { width: `${pct}%` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label={label}
        aria-labelledby={labelId}
        aria-valuenow={pct}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          "bg-border hover:bg-primary/40 focus-visible:bg-primary/60 shrink-0 outline-none",
          vertical ? "h-1 w-full cursor-row-resize" : "w-1 cursor-col-resize",
        )}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}
