// Go-to-commit dialog (docs/spec/17 REQ-P6-NAV-001..003). A small input (also bound to
// Ctrl+G) that accepts a full/abbreviated commit hash or a ref that resolves to a commit.
// On resolve it validates the input with commit.detail and hands the full oid to the
// history view (via the store), which pages more history in if needed, then scrolls to and
// selects the row. An unresolvable/ambiguous input surfaces an inline, non-destructive
// error and leaves the current selection unchanged (REQ-P6-NAV-002). Client-only — no new
// RPC surface (REQ-P6-NAV-003).

import { Oid, type RepoId } from '@cbranch/rpc-contract';
import { type FormEvent, useState } from 'react';

import { useApi } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

export function GoToCommitDialog({ repoId }: { repoId: RepoId }) {
    const open = useUiStore(s => s.goToDialogOpen);
    if (!open) return null;
    return <GoToCommitDialogBody repoId={repoId} />;
}

function GoToCommitDialogBody({ repoId }: { repoId: RepoId }) {
    const setOpen = useUiStore(s => s.setGoToDialogOpen);
    const setGotoRequest = useUiStore(s => s.setGotoRequest);
    const api = useApi();

    const [value, setValue] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [resolving, setResolving] = useState(false);

    const close = () => setOpen(false);

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const input = value.trim();
        if (input === '' || resolving) return;
        setResolving(true);
        setError(null);
        // Validate that the input resolves to a commit; commit.detail returns its full oid.
        api.commitDetail(repoId, Oid.make(input))
            .then(detail => {
                setGotoRequest({ oid: detail.oid });
                setOpen(false);
            })
            .catch(() => {
                setError(
                    `Could not resolve "${input}" to a commit. Check the hash or ref.`,
                );
            })
            .finally(() => setResolving(false));
    };

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next) close();
            }}
        >
            <DialogContent style={{ width: 'min(480px, 92vw)' }}>
                <form onSubmit={submit} className="flex flex-col gap-3 p-4">
                    <DialogTitle>Go to commit</DialogTitle>
                    <DialogDescription>
                        Enter a commit hash (full or abbreviated) or a ref. The
                        history will scroll to and select it, loading more if
                        needed.
                    </DialogDescription>
                    <Input
                        autoFocus
                        aria-label="Commit hash or ref"
                        value={value}
                        onChange={e => {
                            setValue(e.target.value);
                            setError(null);
                        }}
                        placeholder="e.g. a1b2c3d, HEAD~5, origin/main"
                        disabled={resolving}
                    />
                    {error !== null && (
                        <p role="alert" className="text-destructive text-xs">
                            {error}
                        </p>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={resolving}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            disabled={value.trim() === '' || resolving}
                        >
                            {resolving ? 'Resolving…' : 'Go'}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
