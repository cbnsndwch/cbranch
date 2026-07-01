// The clean-working-directory dialog (docs/spec/09 REQ-P5-CL-001..005).
//
// A preview-then-remove flow: two option Checkboxes (untracked directories, ignored
// files), a Preview that lists exactly what a clean with those options would remove, and
// a destructive Remove gated behind a DestructiveConfirmDialog. The destructive button is
// enabled ONLY when the shown preview matches the current options (changing an option
// invalidates the stale preview — REQ-P5-CL-002), there is at least one entry, and no
// fetch/mutation is in flight. An empty preview shows "Nothing to clean" and keeps Remove
// disabled. The clean removes exactly the previewed paths (REQ-P5-CL-003).

import { type RepoId } from '@cbranch/rpc-contract';
import { useState } from 'react';
import { toast } from 'sonner';

import { useClean, useCleanPreview } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';

const plural = (n: number) => (n === 1 ? 'entry' : 'entries');

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Clean failed.';

export function CleanDialog() {
    const repoId = useUiStore(s => s.activeRepoId);
    if (repoId === null) return null;
    return <CleanDialogBody repoId={repoId} />;
}

function CleanDialogBody({ repoId }: { repoId: RepoId }) {
    const open = useUiStore(s => s.cleanDialogOpen);
    const setOpen = useUiStore(s => s.setCleanDialogOpen);

    const [directories, setDirectories] = useState(false);
    const [ignored, setIgnored] = useState(false);
    const [previewed, setPreviewed] = useState<{
        directories: boolean;
        ignored: boolean;
    } | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);

    // The shown preview is valid only while its options still match the current toggles.
    const matches =
        previewed !== null &&
        previewed.directories === directories &&
        previewed.ignored === ignored;
    const preview = useCleanPreview(repoId, directories, ignored, matches);
    const clean = useClean(repoId);

    const entries = matches ? (preview.data?.entries ?? []) : [];
    const fetching = preview.isFetching;
    const pending = clean.isPending;
    const canRemove = matches && entries.length > 0 && !fetching && !pending;

    const reset = () => {
        setPreviewed(null);
        clean.reset();
    };
    const requestClose = () => {
        if (!pending) {
            reset();
            setOpen(false);
        }
    };

    const runClean = () =>
        clean.mutate(
            { paths: entries.map(e => e.path), directories, ignored },
            {
                onSuccess: result => {
                    toast.success(
                        `Removed ${result.removed} ${plural(result.removed)}`,
                    );
                    reset();
                    setOpen(false);
                },
                onError: e => toast.error(errorMessage(e)),
            },
        );

    return (
        <>
            <Dialog
                open={open}
                onOpenChange={(next: boolean) => {
                    if (next) setOpen(true);
                    else requestClose();
                }}
            >
                <DialogContent style={{ width: 'min(560px, 92vw)' }}>
                    <div className="flex flex-col gap-3 p-4">
                        <DialogTitle>Clean working directory</DialogTitle>
                        <DialogDescription>
                            Permanently remove untracked files. Preview first —
                            only the previewed entries are removed. Tracked and
                            staged files are never touched.
                        </DialogDescription>

                        {/* The concise aria-label (distinct from the visible text) is the stable
                accessible name; Base UI also renders a hidden form input inside the
                <label>, so a matching wrapping-label name would double-match queries. */}
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                aria-label="Untracked directories"
                                checked={directories}
                                onCheckedChange={c =>
                                    setDirectories(c === true)
                                }
                                disabled={pending}
                            />
                            Include untracked directories
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                aria-label="Ignored files"
                                checked={ignored}
                                onCheckedChange={c => setIgnored(c === true)}
                                disabled={pending}
                            />
                            Include ignored files
                        </label>

                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    setPreviewed({ directories, ignored })
                                }
                                disabled={fetching || pending}
                            >
                                {fetching ? 'Previewing…' : 'Preview'}
                            </Button>
                            {previewed !== null && !matches && (
                                <span
                                    role="status"
                                    className="text-muted-foreground text-xs"
                                >
                                    Options changed — preview again.
                                </span>
                            )}
                        </div>

                        {matches &&
                            !fetching &&
                            (entries.length === 0 ? (
                                <p className="text-muted-foreground text-xs">
                                    Nothing to clean.
                                </p>
                            ) : (
                                <ul className="bg-muted/30 max-h-48 overflow-auto border p-2 text-xs">
                                    {entries.map(e => (
                                        <li key={e.path} className="font-mono">
                                            {e.path}
                                        </li>
                                    ))}
                                </ul>
                            ))}

                        <div className="flex justify-end gap-2 pt-1">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={requestClose}
                                disabled={pending}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => setConfirmOpen(true)}
                                disabled={!canRemove}
                            >
                                {pending
                                    ? 'Removing…'
                                    : `Remove ${entries.length} ${plural(entries.length)}`}
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <DestructiveConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Permanently delete untracked entries?"
                description={`This permanently deletes ${entries.length} untracked ${plural(
                    entries.length,
                )} from the working tree. This cannot be undone.`}
                confirmLabel={`Delete ${entries.length}`}
                onConfirm={runClean}
            />
        </>
    );
}
