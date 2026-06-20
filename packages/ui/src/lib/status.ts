import { type ChangeCode, type StatusEntry, type WorkingTreeStatus } from "@cbranch/rpc-contract";

export const isStagedChange = (e: StatusEntry): boolean => e.staged !== "unmodified";

export const isUnstagedChange = (e: StatusEntry): boolean => e.unstaged !== "unmodified" || e.isUntracked;

export const groupStatusEntries = (
  entries: ReadonlyArray<StatusEntry>,
): { staged: StatusEntry[]; unstaged: StatusEntry[] } => ({
  staged: entries.filter(isStagedChange),
  unstaged: entries.filter(isUnstagedChange),
});

export const statusLabel = (e: StatusEntry): string => {
  const code: ChangeCode = isStagedChange(e) ? e.staged : e.unstaged;
  switch (code) {
    case "modified":
      return "modified";
    case "added":
      return "new file";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed → " + (e.origPath ?? e.path);
    case "copied":
      return "copied";
    case "typeChanged":
      return "type changed";
    case "updatedButUnmerged":
      return "conflict";
    case "untracked":
      return "untracked";
    case "ignored":
      return "ignored";
    default:
      return "modified";
  }
};

export const hasStagedChanges = (status: WorkingTreeStatus): boolean => status.entries.some(isStagedChange);

export const hasUnstagedChanges = (status: WorkingTreeStatus): boolean => status.entries.some(isUnstagedChange);
