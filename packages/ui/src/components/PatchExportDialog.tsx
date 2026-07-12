// Export patch dialog (docs/spec/17 REQ-P6-PATCH-001). Validates a commit range via
// patch.formatPrepare (reporting the commit count), then downloads the format-patch bundle
// over GET /sidechannel/patch and triggers a browser download. An empty/invalid range
// produces no download.

import { type RepoId } from '@cbranch/rpc-contract';
import { useState } from 'react';
import { toast } from 'sonner';

import { usePatchFormatPrepare } from '../rpc/hooks';
import { useHostEndpoint } from '../rpc/connection-provider';
import { resolveHostUrl } from '../rpc/client';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Export failed.';

export function PatchExportDialog({ repoId }: { repoId: RepoId }) {
    const state = useUiStore(s => s.patchExportDialog);
    if (state === null) return null;
    return (
        <PatchExportBody
            key={state.range}
            repoId={repoId}
            initialRange={state.range}
        />
    );
}

function PatchExportBody({
    repoId,
    initialRange,
}: {
    repoId: RepoId;
    initialRange: string;
}) {
    const setOpen = useUiStore(s => s.setPatchExportDialog);
    const prepare = usePatchFormatPrepare(repoId);
    const endpoint = useHostEndpoint();

    const [range, setRange] = useState(initialRange);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);

    const busy = prepare.isPending || downloading;
    const trimmed = range.trim();

    const doExport = async () => {
        setError(null);
        try {
            const descriptor = await prepare.mutateAsync({ range: trimmed });
            if (descriptor.count === 0) {
                setError('That range contains no commits to export.');
                return;
            }
            setDownloading(true);
            const url =
                `/sidechannel/patch?repoId=${encodeURIComponent(repoId)}` +
                `&range=${encodeURIComponent(trimmed)}`;
            const res = await fetch(resolveHostUrl(endpoint, url));
            if (!res.ok) {
                setError('Export failed — the server rejected the request.');
                return;
            }
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = objectUrl;
            anchor.download = descriptor.filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(objectUrl);
            toast.success(
                `Exported ${descriptor.count} commit${
                    descriptor.count === 1 ? '' : 's'
                } (${blob.size} bytes)`,
            );
            setOpen(null);
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setDownloading(false);
        }
    };

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next && !busy) setOpen(null);
            }}
        >
            <DialogContent style={{ width: 'min(520px, 92vw)' }}>
                <div className="flex flex-col gap-3 p-4">
                    <DialogTitle>Export patch</DialogTitle>
                    <DialogDescription>
                        Export a commit range as a downloadable .patch bundle
                        (git format-patch). Use a revision range like{' '}
                        <span className="font-mono">base..HEAD</span> or{' '}
                        <span className="font-mono">HEAD~3..HEAD</span>.
                    </DialogDescription>
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Range</span>
                        <Input
                            autoFocus
                            aria-label="Commit range"
                            value={range}
                            onChange={e => {
                                setRange(e.target.value);
                                setError(null);
                            }}
                            placeholder="e.g. main..HEAD"
                            disabled={busy}
                        />
                    </label>
                    {error !== null && (
                        <p role="alert" className="text-destructive text-xs">
                            {error}
                        </p>
                    )}
                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setOpen(null)}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={doExport}
                            disabled={trimmed === '' || busy}
                        >
                            {busy ? 'Exporting…' : 'Export'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
