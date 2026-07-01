// Undo-last-commit dialog (docs/spec/17 REQ-P6-UNDO-001..005). Moves HEAD back one commit
// with a soft reset (`git reset --soft HEAD~1`), keeping that commit's changes staged so the
// user can re-commit after edits, and prefilling the preserved message into the commit
// surface. It is blocked with an explanation when the last commit is a merge, a root commit,
// or a rebase/merge/cherry-pick is in progress (REQ-P6-UNDO-003), and warns when the commit
// was already pushed to its upstream (REQ-P6-UNDO-004). Composes existing methods only —
// reset.to + commit.lastMessage/commit.detail — with no new RPC surface (REQ-P6-UNDO-005).

import { type RepoId } from '@cbranch/rpc-contract';
import { toast } from 'sonner';

import {
    useCommitDetail,
    useLastMessage,
    useRepoState,
    useResetTo,
    useStatus,
} from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';

const IN_PROGRESS_LABEL: Readonly<Record<string, string>> = {
    merge: 'a merge',
    rebase: 'a rebase',
    cherryPick: 'a cherry-pick',
    revert: 'a revert',
    am: 'a patch application',
    bisect: 'a bisect',
};

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Undo failed.';

export function UndoLastCommitDialog({ repoId }: { repoId: RepoId }) {
    const open = useUiStore(s => s.undoDialogOpen);
    if (!open) return null;
    return <UndoLastCommitBody repoId={repoId} />;
}

function UndoLastCommitBody({ repoId }: { repoId: RepoId }) {
    const setOpen = useUiStore(s => s.setUndoDialogOpen);
    const setCommitDialogOpen = useUiStore(s => s.setCommitDialogOpen);
    const updateCommitDraft = useUiStore(s => s.updateCommitDraft);

    const repoState = useRepoState(repoId);
    const headOid = repoState.data?.headOid ?? null;
    const headDetail = useCommitDetail(repoId, headOid);
    const status = useStatus(repoId);
    const lastMessage = useLastMessage(repoId);
    const resetTo = useResetTo(repoId);

    const inProgress = repoState.data?.inProgress ?? 'none';
    const parents = headDetail.data?.parents;
    const branch = status.data?.branch;
    // Pushed ⟺ an upstream is set and the local branch is not ahead of it, so HEAD is
    // already on the remote (REQ-P6-UNDO-004).
    const pushed = branch?.upstream !== undefined && (branch.ahead ?? 0) === 0;

    const loading =
        repoState.isLoading ||
        (headOid !== null && headDetail.isLoading) ||
        lastMessage.isLoading;

    // Determine a blocking reason, if any (REQ-P6-UNDO-003).
    let blocked: string | null = null;
    if (inProgress !== 'none') {
        blocked = `Cannot undo while ${
            IN_PROGRESS_LABEL[inProgress] ?? 'an operation'
        } is in progress. Finish or abort it first.`;
    } else if (headOid === null) {
        blocked = 'There is no commit to undo — the branch has no commits yet.';
    } else if (parents !== undefined && parents.length === 0) {
        blocked =
            'The last commit is the root commit (it has no parent), so it cannot be undone this way.';
    } else if (parents !== undefined && parents.length > 1) {
        blocked =
            'The last commit is a merge commit. Undoing it is ambiguous about which parent to keep, so it is blocked.';
    }

    const close = () => {
        if (!resetTo.isPending) setOpen(false);
    };

    const runUndo = () => {
        // Capture the message BEFORE the reset (afterwards HEAD is the parent).
        const msg = lastMessage.data;
        resetTo.mutate(
            { mode: 'soft', target: 'HEAD~1' },
            {
                onSuccess: () => {
                    if (msg !== undefined) {
                        updateCommitDraft({
                            subject: msg.subject,
                            body: msg.body,
                            amend: false,
                        });
                    }
                    toast.success(
                        'Undid the last commit — changes are staged.',
                    );
                    setOpen(false);
                    setCommitDialogOpen(true);
                },
                onError: e => toast.error(errorMessage(e)),
            },
        );
    };

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next) close();
            }}
        >
            <DialogContent style={{ width: 'min(520px, 92vw)' }}>
                <div className="flex flex-col gap-3 p-4">
                    <DialogTitle>Undo last commit</DialogTitle>

                    {loading ? (
                        <DialogDescription>Checking…</DialogDescription>
                    ) : blocked !== null ? (
                        <DialogDescription role="alert">
                            {blocked}
                        </DialogDescription>
                    ) : (
                        <>
                            <DialogDescription>
                                This moves HEAD back one commit and keeps its
                                changes staged, so you can re-commit after
                                edits. The commit message is preserved and
                                prefilled for the next commit.
                            </DialogDescription>
                            {pushed && (
                                <p
                                    role="alert"
                                    className="text-destructive text-xs"
                                >
                                    This commit was already pushed to{' '}
                                    <span className="font-mono">
                                        {branch?.upstream}
                                    </span>
                                    . Undoing it will make your branch diverge
                                    from the remote.
                                </p>
                            )}
                        </>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={resetTo.isPending}
                        >
                            {blocked !== null ? 'Close' : 'Cancel'}
                        </Button>
                        {blocked === null && !loading && (
                            <Button
                                size="sm"
                                onClick={runUndo}
                                disabled={resetTo.isPending}
                            >
                                {resetTo.isPending
                                    ? 'Undoing…'
                                    : 'Undo last commit'}
                            </Button>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
