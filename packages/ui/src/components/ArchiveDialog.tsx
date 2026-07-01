// The archive-export dialog (docs/spec/09 REQ-P5-AR-001..005).
//
// Collects a tree-ish (pre-seeded when launched from a commit), a format
// (zip/tar/tar.gz), and optional prefix + sub-path, then `archivePrepare`s a descriptor,
// fetches its side-channel URL, and triggers a browser download via a transient
// `<a download>`. Success is reported inline with the file name + byte size (the size is
// known only after the blob arrives — the descriptor carries none); an invalid tree-ish
// surfaces git's error inline and produces NO download.

import { type ArchiveFormat, type RepoId } from '@cbranch/rpc-contract';
import { useState } from 'react';

import { useArchivePrepare } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from './ui/select';

const FORMAT_LABEL: Record<ArchiveFormat, string> = {
    zip: 'zip',
    tar: 'tar',
    'tar.gz': 'tar.gz',
};

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Export failed.';

export function ArchiveDialog() {
    const repoId = useUiStore(s => s.activeRepoId);
    const state = useUiStore(s => s.archiveDialog);
    if (repoId === null || state === null) return null;
    // Remount on a new launch so the form re-seeds from the new tree-ish.
    return (
        <ArchiveDialogBody
            key={state.treeish}
            repoId={repoId}
            initialTreeish={state.treeish}
        />
    );
}

const close = () => useUiStore.getState().setArchiveDialog(null);

function ArchiveDialogBody({
    repoId,
    initialTreeish,
}: {
    repoId: RepoId;
    initialTreeish: string;
}) {
    const [treeish, setTreeish] = useState(initialTreeish);
    const [format, setFormat] = useState<ArchiveFormat>('zip');
    const [prefix, setPrefix] = useState('');
    const [subPath, setSubPath] = useState('');
    const [exported, setExported] = useState<{
        filename: string;
        size: number;
    } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [downloading, setDownloading] = useState(false);

    const prepare = useArchivePrepare(repoId);
    const busy = prepare.isPending || downloading;
    const canExport = treeish.trim() !== '' && !busy;

    const doExport = async () => {
        setError(null);
        setExported(null);
        try {
            const descriptor = await prepare.mutateAsync({
                format,
                treeish: treeish.trim(),
                prefix: prefix.trim() === '' ? undefined : prefix.trim(),
                subPath: subPath.trim() === '' ? undefined : subPath.trim(),
            });
            setDownloading(true);
            const res = await fetch(descriptor.url);
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
            setExported({ filename: descriptor.filename, size: blob.size });
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setDownloading(false);
        }
    };

    const field = 'h-8 w-full border px-2 text-sm';

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next && !busy) close();
            }}
        >
            <DialogContent style={{ width: 'min(520px, 92vw)' }}>
                <div className="flex flex-col gap-3 p-4">
                    <DialogTitle>Export archive</DialogTitle>
                    <DialogDescription>
                        Export a commit, tag, or branch tip as a downloadable
                        archive.
                    </DialogDescription>

                    <div className="flex flex-col gap-1 text-sm">
                        <span>Tree-ish</span>
                        <input
                            type="text"
                            aria-label="Tree-ish"
                            value={treeish}
                            onChange={e => setTreeish(e.target.value)}
                            placeholder="HEAD, a branch, a tag, or a commit"
                            className={field}
                            disabled={busy}
                        />
                    </div>

                    <div className="flex items-center gap-2 text-sm">
                        <span id="archive-format-label">Format</span>
                        <Select
                            value={format}
                            onValueChange={value =>
                                setFormat(value as ArchiveFormat)
                            }
                        >
                            <SelectTrigger
                                aria-labelledby="archive-format-label"
                                disabled={busy}
                                className="w-32"
                            >
                                <SelectValue>
                                    {(value: ArchiveFormat) =>
                                        FORMAT_LABEL[value] ?? 'zip'
                                    }
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="zip">zip</SelectItem>
                                <SelectItem value="tar">tar</SelectItem>
                                <SelectItem value="tar.gz">tar.gz</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1 text-sm">
                        <span>Prefix (optional)</span>
                        <input
                            type="text"
                            aria-label="Prefix"
                            value={prefix}
                            onChange={e => setPrefix(e.target.value)}
                            placeholder="e.g. my-project/"
                            className={field}
                            disabled={busy}
                        />
                    </div>

                    <div className="flex flex-col gap-1 text-sm">
                        <span>Sub-path (optional)</span>
                        <input
                            type="text"
                            aria-label="Sub-path"
                            value={subPath}
                            onChange={e => setSubPath(e.target.value)}
                            placeholder="e.g. src"
                            className={field}
                            disabled={busy}
                        />
                    </div>

                    {error !== null && (
                        <div
                            role="alert"
                            className="border-destructive/50 bg-destructive/10 text-destructive border px-2 py-1 text-xs"
                        >
                            {error}
                        </div>
                    )}
                    {exported !== null && (
                        <div
                            role="status"
                            className="border-status-ahead/40 bg-status-ahead/10 border px-2 py-1 text-xs"
                        >
                            Exported {exported.filename} (
                            {exported.size.toLocaleString()} bytes)
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={busy}
                        >
                            Close
                        </Button>
                        <Button
                            size="sm"
                            onClick={doExport}
                            disabled={!canExport}
                        >
                            {busy ? 'Exporting…' : 'Export'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
