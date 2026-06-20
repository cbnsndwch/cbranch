import { type RepoId } from "@cbranch/rpc-contract";

export function HistoryStatusStrip({ repoId: _repoId }: { readonly repoId: RepoId | null }) {
  return (
    <div className="text-muted-foreground flex shrink-0 flex-col border-b px-2 py-1 text-[11px]">
      <div className="flex h-[22px] items-center justify-between">
        <span>Working directory</span>
        <span className="size-2 rounded-full" style={{ background: "var(--color-status-staged)" }} aria-hidden="true" />
      </div>
      <div className="flex h-[22px] items-center justify-between">
        <span>Commit index</span>
        <span className="size-2 rounded-full" style={{ background: "var(--color-status-staged)" }} aria-hidden="true" />
      </div>
    </div>
  );
}
