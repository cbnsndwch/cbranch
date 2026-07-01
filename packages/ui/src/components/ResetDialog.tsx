// Reset-to-commit dialog (docs/spec/17 REQ-P6-RESET-001..003). Reachable from the
// stage/commit surface, the command palette, and the commit context menu — outside the
// P5 reflog panel, which was previously the only reset entry point. The user picks a
// target ref/oid and a mode (soft/mixed/hard). Each mode's effect is described inline
// (the lighter confirmation soft/mixed MAY use); a hard reset is additionally gated
// behind the DestructiveConfirmDialog naming the working-tree data loss (REQ-P6-RESET-002).
// Reuses the existing ResetTo RPC — no new contract surface (REQ-P6-RESET-003).

import { type RepoId } from '@cbranch/rpc-contract';
import { useState } from 'react';
import { toast } from 'sonner';

import { useResetTo } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';

type ResetMode = 'soft' | 'mixed' | 'hard';

const MODE_EFFECT: Readonly<Record<ResetMode, string>> = {
    soft: 'Move HEAD only. The index and working tree are kept, so every change from the reset commits becomes staged.',
    mixed: 'Move HEAD and reset the index. Working-tree files are kept, so changes become unstaged (the default).',
    hard: 'Move HEAD and discard all changes in the index and working tree. Uncommitted work is permanently lost.',
};

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Reset failed.';

export function ResetDialog({ repoId }: { repoId: RepoId }) {
    const state = useUiStore(s => s.resetDialog);
    if (state === null) return null;
    // Key on the seeded target so each open starts with fresh local state.
    return (
        <ResetDialogBody
            key={state.target}
            repoId={repoId}
            initialTarget={state.target}
        />
    );
}

function ResetDialogBody({
    repoId,
    initialTarget,
}: {
    repoId: RepoId;
    initialTarget: string;
}) {
    const setResetDialog = useUiStore(s => s.setResetDialog);
    const resetTo = useResetTo(repoId);

    const [target, setTarget] = useState(initialTarget);
    const [mode, setMode] = useState<ResetMode>('mixed');
    const [confirmOpen, setConfirmOpen] = useState(false);

    const pending = resetTo.isPending;
    const trimmed = target.trim();
    const canReset = trimmed !== '' && !pending;

    const close = () => {
        if (!pending) setResetDialog(null);
    };

    const runReset = () =>
        resetTo.mutate(
            { mode, target: trimmed },
            {
                onSuccess: () => {
                    toast.success(`Reset (${mode}) to ${trimmed}`);
                    setResetDialog(null);
                },
                onError: e => toast.error(errorMessage(e)),
            },
        );

    // Soft/mixed run directly from this dialog (its effect copy is the lighter
    // confirmation); hard opens the destructive guard first (REQ-P6-RESET-002).
    const onReset = () => {
        if (!canReset) return;
        if (mode === 'hard') setConfirmOpen(true);
        else runReset();
    };

    return (
        <>
            <Dialog
                open={true}
                onOpenChange={(next: boolean) => {
                    if (!next) close();
                }}
            >
                <DialogContent style={{ width: 'min(520px, 92vw)' }}>
                    <div className="flex flex-col gap-3 p-4">
                        <DialogTitle>Reset to commit</DialogTitle>
                        <DialogDescription>
                            Move the current branch to a target commit. Choose
                            how much of the index and working tree to keep.
                        </DialogDescription>

                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Target</span>
                            <input
                                className="h-8 w-full border px-2 text-sm"
                                aria-label="Target commit"
                                value={target}
                                onChange={e => setTarget(e.target.value)}
                                placeholder="A commit hash, ref, or e.g. HEAD~1"
                                disabled={pending}
                            />
                        </label>

                        <RadioGroup
                            aria-label="Reset mode"
                            value={mode}
                            onValueChange={v =>
                                setMode((v ?? 'mixed') as ResetMode)
                            }
                            className="flex flex-col gap-2"
                        >
                            {(['soft', 'mixed', 'hard'] as const).map(m => (
                                <label
                                    key={m}
                                    className="flex items-start gap-2 text-sm"
                                >
                                    <RadioGroupItem
                                        value={m}
                                        aria-label={`${m} reset`}
                                        className="mt-0.5"
                                    />
                                    <span>
                                        <span className="font-medium capitalize">
                                            {m}
                                        </span>
                                        <span className="text-muted-foreground block text-xs">
                                            {MODE_EFFECT[m]}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </RadioGroup>

                        <div className="flex justify-end gap-2 pt-1">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={close}
                                disabled={pending}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant={
                                    mode === 'hard' ? 'destructive' : 'default'
                                }
                                size="sm"
                                onClick={onReset}
                                disabled={!canReset}
                            >
                                {pending ? 'Resetting…' : 'Reset'}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <DestructiveConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Hard reset — discard working-tree changes?"
                description={`A hard reset to ${trimmed} discards all uncommitted changes in the index and working tree. This is irreversible and cannot be undone.`}
                confirmLabel="Hard reset"
                onConfirm={runReset}
            />
        </>
    );
}
