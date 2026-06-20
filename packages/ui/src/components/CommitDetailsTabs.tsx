import { cn } from "../lib/cn";
import { type DetailTab, useUiStore } from "../state/store";

const TABS: ReadonlyArray<readonly [DetailTab, string]> = [
  ["changes", "Changes"],
  ["commit", "Commit"],
  ["diff", "Diff"],
  ["filetree", "File tree"],
  ["gpg", "GPG"],
  ["console", "Console"],
  ["output", "Output"],
];

export function CommitDetailsTabs() {
  const detailTab = useUiStore((s) => s.detailTab);
  const setDetailTab = useUiStore((s) => s.setDetailTab);

  return (
    <div className="bg-muted flex items-end border-b">
      {TABS.map(([tab, label]) => (
        <button
          key={tab}
          type="button"
          onClick={() => setDetailTab(tab)}
          className={cn(
            "px-3 py-0.5 text-[11px]",
            tab === detailTab
              ? "relative -mb-px border border-b-background bg-background font-medium"
              : "text-muted-foreground hover:bg-accent/50",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
