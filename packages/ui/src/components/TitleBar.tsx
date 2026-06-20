import { useRepoState } from "../rpc/hooks";
import { useUiStore } from "../state/store";

export function TitleBar() {
  const repoId = useUiStore((s) => s.activeRepoId);
  const { data: state } = useRepoState(repoId);
  const title = state?.currentBranch
    ? `${state.currentBranch} — cbranch`
    : "cbranch";

  return (
    <div className="bg-background text-foreground flex items-center border-b px-2 text-[11px]">
      {title}
    </div>
  );
}
