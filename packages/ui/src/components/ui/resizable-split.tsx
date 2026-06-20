// A minimal two-pane horizontal resizable split (docs/design/commit-surface.md §3 —
// the commit dialog body is a changes|diff split with a draggable divider). The split
// position is *controlled* (the caller persists it); this component only translates a
// pointer drag over the divider into a clamped fraction. Keyboard-accessible: the
// divider is a focusable `separator` that nudges with the arrow keys.

import { useCallback, useId, useRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

interface ResizableSplitProps {
  /** Fraction (0..1) of the width given to the left pane. */
  readonly fraction: number;
  readonly onFractionChange: (fraction: number) => void;
  readonly left: ReactNode;
  readonly right: ReactNode;
  /** Clamp bounds so neither pane collapses. */
  readonly min?: number;
  readonly max?: number;
  readonly className?: string;
}

export function ResizableSplit({
  fraction,
  onFractionChange,
  left,
  right,
  min = 0.2,
  max = 0.7,
  className,
}: ResizableSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
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
      if (rect.width === 0) return;
      onFractionChange(clamp((ev.clientX - rect.left) / rect.width));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      onFractionChange(clamp(fraction - 0.02));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      onFractionChange(clamp(fraction + 0.02));
    }
  };

  const pct = Math.round(clamp(fraction) * 100);

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 w-full", className)}
      style={{ ["--split" as string]: `${pct}%` }}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={{ width: `${pct}%` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize changes and diff"
        aria-labelledby={labelId}
        aria-valuenow={pct}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="bg-border hover:bg-primary/40 focus-visible:bg-primary/60 w-1 shrink-0 cursor-col-resize outline-none"
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}
