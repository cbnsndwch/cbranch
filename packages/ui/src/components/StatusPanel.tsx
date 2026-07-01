import { type RepoId } from '@cbranch/rpc-contract';

import { groupStatusEntries } from '../lib/status';
import {
    useDeleteUntracked,
    useDiscardFiles,
    useStageFiles,
    useStatus,
    useUnstageFiles,
} from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { ChangeListToolbar } from './ChangeListToolbar';
import { StatusChangeList } from './StatusChangeList';
import { Separator } from './ui/separator';

interface StatusPanelProps {
    repoId: RepoId;
}

export function StatusPanel({ repoId }: StatusPanelProps) {
    const { data: status, isLoading } = useStatus(repoId);
    const stageFiles = useStageFiles(repoId);
    const unstageFiles = useUnstageFiles(repoId);
    const discardFiles = useDiscardFiles(repoId);
    const deleteUntracked = useDeleteUntracked(repoId);

    const setCleanDialogOpen = useUiStore(s => s.setCleanDialogOpen);
    const stagedSelection = useUiStore(s => s.stagedSelection);
    const unstagedSelection = useUiStore(s => s.unstagedSelection);
    const toggleStagedSelection = useUiStore(s => s.toggleStagedSelection);
    const toggleUnstagedSelection = useUiStore(s => s.toggleUnstagedSelection);
    const setStagedSelection = useUiStore(s => s.setStagedSelection);
    const setUnstagedSelection = useUiStore(s => s.setUnstagedSelection);
    const setSelectedDiffFile = useUiStore(s => s.setSelectedDiffFile);

    if (isLoading) {
        return (
            <p className="text-muted-foreground px-4 py-4 text-xs">Loading…</p>
        );
    }

    const { staged, unstaged } = groupStatusEntries(status?.entries ?? []);
    const conflictCount = (status?.entries ?? []).filter(
        e => e.isConflicted,
    ).length;

    const allStagedSelected =
        staged.length > 0 && staged.every(e => stagedSelection.has(e.path));
    const allUnstagedSelected =
        unstaged.length > 0 &&
        unstaged.every(e => unstagedSelection.has(e.path));

    const handleStagedSelectAll = () => {
        if (allStagedSelected) setStagedSelection([]);
        else setStagedSelection(staged.map(e => e.path));
    };

    const handleUnstagedSelectAll = () => {
        if (allUnstagedSelected) setUnstagedSelection([]);
        else setUnstagedSelection(unstaged.map(e => e.path));
    };

    const handleDiscard = (paths: string[]) => {
        const tracked = paths.filter(p => {
            const entry = unstaged.find(e => e.path === p);
            return entry && !entry.isUntracked;
        });
        const untracked = paths.filter(p => {
            const entry = unstaged.find(e => e.path === p);
            return entry?.isUntracked;
        });
        if (tracked.length > 0) discardFiles.mutate({ paths: tracked });
        if (untracked.length > 0) deleteUntracked.mutate({ paths: untracked });
    };

    return (
        <div className="flex h-full flex-col overflow-hidden">
            {/* Conflict banner (docs/design/commit-surface.md §7): commit is blocked while a
          merge is unresolved; staging a file whose markers were removed marks it
          resolved and is the escape hatch before the full resolver phase. */}
            {conflictCount > 0 && (
                <div
                    role="alert"
                    className="bg-destructive/10 text-destructive border-b px-2 py-1 text-[11px]"
                >
                    {conflictCount} conflict{conflictCount === 1 ? '' : 's'} —
                    resolve markers, then stage the file to mark it resolved.
                </div>
            )}

            {/* Staged section */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ChangeListToolbar
                    title="Staged Changes"
                    count={staged.length}
                    allSelected={allStagedSelected}
                    onSelectAll={handleStagedSelectAll}
                    onAction={() =>
                        unstageFiles.mutate({ paths: [], all: true })
                    }
                    actionLabel="Unstage All"
                    disabled={staged.length === 0}
                />
                <div className="min-h-0 overflow-y-auto">
                    <StatusChangeList
                        entries={staged}
                        selection={stagedSelection}
                        onToggle={toggleStagedSelection}
                        onSelect={path =>
                            setSelectedDiffFile({ path, staged: true })
                        }
                        staged={true}
                        onAction={paths => unstageFiles.mutate({ paths })}
                    />
                </div>
            </div>

            <Separator />

            {/* Unstaged section */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ChangeListToolbar
                    title="Unstaged Changes"
                    count={unstaged.length}
                    allSelected={allUnstagedSelected}
                    onSelectAll={handleUnstagedSelectAll}
                    onAction={() => {
                        const sel = [...unstagedSelection];
                        if (sel.length > 0) stageFiles.mutate({ paths: sel });
                        else stageFiles.mutate({ paths: [], all: true });
                    }}
                    actionLabel={
                        [...unstagedSelection].length > 0
                            ? 'Stage Selected'
                            : 'Stage All'
                    }
                    disabled={unstaged.length === 0}
                    secondaryAction={{
                        label: 'Clean…',
                        onClick: () => setCleanDialogOpen(true),
                    }}
                />
                <div className="min-h-0 overflow-y-auto">
                    <StatusChangeList
                        entries={unstaged}
                        selection={unstagedSelection}
                        onToggle={toggleUnstagedSelection}
                        onSelect={path =>
                            setSelectedDiffFile({ path, staged: false })
                        }
                        staged={false}
                        onAction={paths => stageFiles.mutate({ paths })}
                        onDestructive={handleDiscard}
                    />
                </div>
            </div>

            {/* Empty state when nothing at all */}
            {staged.length === 0 && unstaged.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center">
                    <p className="text-muted-foreground text-sm">
                        No changes in working tree.
                    </p>
                </div>
            )}
        </div>
    );
}
