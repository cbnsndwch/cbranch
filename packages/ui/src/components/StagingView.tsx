import { type RepoId } from "@cbranch/rpc-contract";

import { CommitPanel } from "./CommitPanel";
import { StatusPanel } from "./StatusPanel";
import { WorkingDiffPanel } from "./WorkingDiffPanel";

interface StagingViewProps {
  repoId: RepoId;
}

export function StagingView({ repoId }: StagingViewProps) {
  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr_auto] overflow-hidden">
      <div className="grid min-h-0 grid-cols-[240px_1fr] overflow-hidden">
        <div className="min-h-0 overflow-auto border-r">
          <StatusPanel repoId={repoId} />
        </div>
        <div className="min-h-0 overflow-auto">
          <WorkingDiffPanel repoId={repoId} />
        </div>
      </div>
      <div className="border-t">
        <CommitPanel repoId={repoId} />
      </div>
    </div>
  );
}
