import { type PropsWithChildren } from "react";

import { cn } from "../../lib/cn";

/** A panel-scoped empty/loading/error placeholder (P1-UI-GEN-1/2). */
export function Placeholder({
  tone = "muted",
  children,
}: PropsWithChildren<{ readonly tone?: "muted" | "danger" }>) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-4 text-center text-xs",
        tone === "danger" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
