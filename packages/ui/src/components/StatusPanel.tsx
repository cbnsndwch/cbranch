import { type RepoId } from '@cbranch/rpc-contract';
import { useState } from 'react';

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
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { StatusChangeList } from './StatusChangeList';
import { Separator } from './ui/separator';

interface StatusPanelProps {
    repoId: RepoId;
}

/** The split of a discard request into tracked (revert) and untracked (delete) paths. */
interface DiscardRequest {
    tracked: string[];
    untracked: string[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Human-readable, effect-naming confirmation copy for a discard request. Names the
 * two irreversible effects separately (tracked changes are reverted; untracked files
 * are deleted) so the user knows exactly what will be lost (REQ-P6-GUARD-001).
 */
function discardConfirmText(req: DiscardRequest): string {
    const parts: string[] = [];
    if (req.tracked.length > 0) {
        parts.push(
            `discard changes to ${req.tracked.length} tracked ${plural(
                req.tracked.length,
                'file',
                'files',
            )}, reverting ${plural(req.tracked.length, 'it', 'them')} to the last committed state`,
        );
    }
    if (req.untracked.length > 0) {
        parts.push(
            `delete ${req.untracked.length} untracked ${plural(
                req.untracked.length,
                'file',
                'files',
            )} from disk`,
        );
    }
    return `This will permanently ${parts.join(
        ' and ',
    )}. This action is irreversible and cannot be undone.`;
}

export function StatusPanel({ repoId }: StatusPanelProps) {
    const { data: status, isLoading } = useStatus(repoId);
    const stageFiles = useStageFiles(repoId);
    const unstageFiles = useUnstageFiles(repoId);
    const discardFiles = useDiscardFiles(repoId);
    const deleteUntracked = useDeleteUntracked(repoId);

    const setCleanDialogOpen = useUiStore(s => s.setCleanDialogOpen);
    const setResetDialog = useUiStore(s => s.setResetDialog);
    const selectedOid = useUiStore(s => s.selectedOid);
    const stagedSelection = useUiStore(s => s.stagedSelection);
    const unstagedSelection = useUiStore(s => s.unstagedSelection);
    const toggleStagedSelection = useUiStore(s => s.toggleStagedSelection);
    const toggleUnstagedSelection = useUiStore(s => s.toggleUnstagedSelection);
    const setStagedSelection = useUiStore(s => s.setStagedSelection);
    const setUnstagedSelection = useUiStore(s => s.setUnstagedSelection);
    const setSelectedDiffFile = useUiStore(s => s.setSelectedDiffFile);

    // Pending discard/delete awaiting confirmation. The destructive mutation never runs
    // as a side effect of any other action (REQ-P6-GUARD-002); it fires only from the
    // dialog's confirm control, which is not the default-focused button.
    const [pendingDiscard, setPendingDiscard] = useState<DiscardRequest | null>(
        null,
    );

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

    // Open the confirmation naming the exact paths; do NOT mutate here (REQ-P6-GUARD-001).
    const handleDiscard = (paths: string[]) => {
        const tracked = paths.filter(p => {
            const entry = unstaged.find(e => e.path === p);
            return entry && !entry.isUntracked;
        });
        const untracked = paths.filter(p => {
            const entry = unstaged.find(e => e.path === p);
            return entry?.isUntracked;
        });
        if (tracked.length === 0 && untracked.length === 0) return;
        setPendingDiscard({ tracked, untracked });
    };

    // Only reached from the confirm control of the destructive dialog.
    const confirmDiscard = () => {
        if (pendingDiscard === null) return;
        const { tracked, untracked } = pendingDiscard;
        if (tracked.length > 0) discardFiles.mutate({ paths: tracked });
        if (untracked.length > 0) deleteUntracked.mutate({ paths: untracked });
        // Drop only the just-discarded paths from the selection; leave the rest intact.
        const acted = new Set([...tracked, ...untracked]);
        setUnstagedSelection([...unstagedSelection].filter(p => !acted.has(p)));
        setPendingDiscard(null);
    };

    const selectedUnstaged = [...unstagedSelection].filter(p =>
        unstaged.some(e => e.path === p),
    );

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
                    secondaryAction={{
                        label: 'Reset…',
                        onClick: () =>
                            setResetDialog({ target: selectedOid ?? '' }),
                    }}
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
                    destructiveAction={
                        selectedUnstaged.length > 0
                            ? {
                                  label: `Discard ${selectedUnstaged.length}`,
                                  onClick: () =>
                                      handleDiscard(selectedUnstaged),
                              }
                            : undefined
                    }
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

            <DestructiveConfirmDialog
                open={pendingDiscard !== null}
                onOpenChange={open => {
                    if (!open) setPendingDiscard(null);
                }}
                title={
                    pendingDiscard !== null &&
                    pendingDiscard.tracked.length === 0
                        ? 'Delete untracked files?'
                        : 'Discard working-tree changes?'
                }
                description={
                    pendingDiscard !== null
                        ? discardConfirmText(pendingDiscard)
                        : ''
                }
                paths={
                    pendingDiscard !== null
                        ? [
                              ...pendingDiscard.tracked,
                              ...pendingDiscard.untracked,
                          ]
                        : undefined
                }
                confirmLabel="Discard"
                onConfirm={confirmDiscard}
            />
        </div>
    );
}
