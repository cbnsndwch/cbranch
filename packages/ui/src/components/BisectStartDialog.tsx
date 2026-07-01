// The start-bisect dialog (docs/spec/09 REQ-P5-BS-001).
//
// Optionally seeds a known-bad and one or more known-good commits, then starts the
// session. On success the graph navigates to the first revision git checks out so the
// user can begin marking (REQ-P5-BS-003). Bad/good are commit oids (the contract types
// them as Oid); "Bisect from here" pre-seeds bad from the selected commit.

import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import { useState } from 'react';
import { toast } from 'sonner';

import { useBisectStart } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Could not start bisect.';

export function BisectStartDialog({
    repoId,
    onSelectOid,
}: {
    repoId: RepoId;
    onSelectOid: (oid: Oid) => void;
}) {
    const state = useUiStore(s => s.bisectStartDialog);
    if (state === null) return null;
    return (
        <BisectStartBody
            repoId={repoId}
            onSelectOid={onSelectOid}
            initialBad={state.bad ?? ''}
        />
    );
}

const close = () => useUiStore.getState().setBisectStartDialog(null);

function BisectStartBody({
    repoId,
    onSelectOid,
    initialBad,
}: {
    repoId: RepoId;
    onSelectOid: (oid: Oid) => void;
    initialBad: string;
}) {
    const [bad, setBad] = useState(initialBad);
    const [good, setGood] = useState('');
    const start = useBisectStart(repoId);

    const doStart = () =>
        start.mutate(
            {
                bad: bad.trim() === '' ? undefined : (bad.trim() as Oid),
                good: good.trim() === '' ? undefined : [good.trim() as Oid],
            },
            {
                onSuccess: s => {
                    close();
                    if (s.state === 'bisecting' && s.current)
                        onSelectOid(s.current.oid);
                },
                onError: e => toast.error(errorMessage(e)),
            },
        );

    const field = 'h-8 w-full border px-2 text-sm font-mono';

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next && !start.isPending) close();
            }}
        >
            <DialogContent style={{ width: 'min(480px, 92vw)' }}>
                <div className="flex flex-col gap-3 p-4">
                    <DialogTitle>Start bisect</DialogTitle>
                    <DialogDescription>
                        Optionally seed a known-bad and a known-good commit. You
                        can also start empty and mark the current revision good
                        or bad.
                    </DialogDescription>

                    <div className="flex flex-col gap-1 text-sm">
                        <span>Known bad (optional)</span>
                        <input
                            type="text"
                            aria-label="Known bad commit"
                            value={bad}
                            onChange={e => setBad(e.target.value)}
                            placeholder="commit oid"
                            className={field}
                            disabled={start.isPending}
                        />
                    </div>
                    <div className="flex flex-col gap-1 text-sm">
                        <span>Known good (optional)</span>
                        <input
                            type="text"
                            aria-label="Known good commit"
                            value={good}
                            onChange={e => setGood(e.target.value)}
                            placeholder="commit oid"
                            className={field}
                            disabled={start.isPending}
                        />
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={start.isPending}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={doStart}
                            disabled={start.isPending}
                        >
                            {start.isPending ? 'Starting…' : 'Start'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
