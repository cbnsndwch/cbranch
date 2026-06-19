import { type RepoId } from "@cbranch/rpc-contract";

import { shortOid } from "../lib/format";
import { useRepoState } from "../rpc/hooks";
import { Badge } from "./ui/badge";

// Working-tree status summary (P1-STAT-1/3/4 + P1-UI-STAT-1). Phase 1's RPC catalog
// exposes repo.state (branch / detached / empty / mid-operation); the staged/unstaged
// counts depend on the P2 status.get method and are surfaced then.
export function StatusSummary({ repoId }: { readonly repoId: RepoId }) {
  const { data: state, isLoading, isError } = useRepoState(repoId);

  if (isLoading) return <span className="text-muted-foreground text-xs">Loading status…</span>;
  if (isError || !state) return <span className="text-destructive text-xs">Status unavailable</span>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state.isDetached ? (
        <Badge tone="warn">detached {state.headOid ? shortOid(state.headOid) : ""}</Badge>
      ) : (
        <Badge>{state.currentBranch ?? "(no branch)"}</Badge>
      )}
      {state.isEmpty ? <Badge tone="muted">empty</Badge> : null}
      {state.inProgress !== "none" ? <Badge tone="warn">{state.inProgress} in progress</Badge> : null}
      {state.isBare ? <Badge tone="muted">bare</Badge> : null}
    </div>
  );
}
