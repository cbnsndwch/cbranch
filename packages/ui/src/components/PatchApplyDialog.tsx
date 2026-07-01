// Apply patch dialog (docs/spec/17 REQ-P6-PATCH-002..006). Paste a patch (or the contents
// of a host .patch file), pick a mode (working tree / index / commits via git am) and an
// optional 3-way fallback, dry-run it with Check (no mutation, no partial apply), preview it
// as a readable diff, then Apply. An `am` conflict routes to the existing Phase 4 conflict
// flow. A patch that exceeds the inline RPC cap is parked on the side-channel upload route
// and referenced by token instead of being rejected (REQ-P6-PATCH-006).

import {
    type PatchApplyMode,
    type PatchApplyReport,
    type RepoId,
} from '@cbranch/rpc-contract';
import { useState } from 'react';
import { toast } from 'sonner';

import { useApplyPatch, useInspectPatch } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';
import { RadioGroup, RadioGroupItem } from './ui/radio-group';

// Patches larger than this are uploaded over the side-channel rather than sent inline.
const INLINE_CAP = 256 * 1024;

const MODES: ReadonlyArray<{ mode: PatchApplyMode; label: string }> = [
    { mode: 'working', label: 'Working tree' },
    { mode: 'index', label: 'Index (cached)' },
    { mode: 'am', label: 'Commits (git am)' },
];

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Apply failed.';

/** Park an oversized patch on the side-channel; small patches travel inline (REQ-P6-PATCH-006). */
async function resolvePatchInput(
    patch: string,
): Promise<{ patch: string; uploadId?: string }> {
    if (new Blob([patch]).size <= INLINE_CAP) return { patch };
    const res = await fetch('/sidechannel/patch-upload', {
        method: 'POST',
        body: patch,
    });
    if (!res.ok) throw new Error('Could not upload the patch.');
    const body = (await res.json()) as { uploadId: string };
    return { patch: '', uploadId: body.uploadId };
}

/** A lightweight readable-diff preview: color +/- lines of the raw patch text. */
function PatchPreview({ text }: { text: string }) {
    const lines = text.split('\n');
    return (
        <pre className="bg-muted/30 max-h-56 overflow-auto border p-2 font-mono text-[11px]">
            {lines.map((line, i) => {
                let cls = '';
                if (line.startsWith('+') && !line.startsWith('+++'))
                    cls = 'text-green-600 dark:text-green-400';
                else if (line.startsWith('-') && !line.startsWith('---'))
                    cls = 'text-red-600 dark:text-red-400';
                else if (line.startsWith('@@')) cls = 'text-muted-foreground';
                return (
                    <div key={i} className={cls}>
                        {line || ' '}
                    </div>
                );
            })}
        </pre>
    );
}

export function PatchApplyDialog({ repoId }: { repoId: RepoId }) {
    const open = useUiStore(s => s.patchApplyDialogOpen);
    const setOpen = useUiStore(s => s.setPatchApplyDialogOpen);
    const inspect = useInspectPatch(repoId);
    const apply = useApplyPatch(repoId);

    const [patch, setPatch] = useState('');
    const [mode, setMode] = useState<PatchApplyMode>('working');
    const [threeWay, setThreeWay] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [report, setReport] = useState<PatchApplyReport | null>(null);
    const [error, setError] = useState<string | null>(null);

    if (!open) return null;

    const busy = inspect.isPending || apply.isPending;
    const empty = patch.trim() === '';

    const close = () => {
        if (!busy) {
            setOpen(false);
            setPatch('');
            setReport(null);
            setError(null);
        }
    };

    const check = async () => {
        setError(null);
        setReport(null);
        try {
            const input = await resolvePatchInput(patch);
            const r = await inspect.mutateAsync({ ...input, mode, threeWay });
            setReport(r);
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    const runApply = async () => {
        setError(null);
        try {
            const input = await resolvePatchInput(patch);
            const result = await apply.mutateAsync({
                ...input,
                mode,
                threeWay,
            });
            if (result.applied) {
                toast.success(result.message || 'Patch applied.');
                close();
            } else if (result.inProgress === 'am') {
                toast.message(
                    'Patch stopped with conflicts — resolve them in the Conflicts view.',
                );
                setOpen(false);
            } else {
                setError(result.message || 'The patch did not apply.');
            }
        } catch (e) {
            setError(errorMessage(e));
        }
    };

    return (
        <Dialog
            open={true}
            onOpenChange={(next: boolean) => {
                if (!next) close();
            }}
        >
            <DialogContent style={{ width: 'min(720px, 94vw)' }}>
                <div className="flex flex-col gap-3 p-4">
                    <DialogTitle>Apply patch</DialogTitle>
                    <DialogDescription>
                        Paste a patch, choose how to apply it, and optionally
                        check it first. A patch applied as commits (git am) that
                        conflicts routes to the Conflicts view.
                    </DialogDescription>

                    <textarea
                        aria-label="Patch text"
                        className="h-40 w-full resize-none border p-2 font-mono text-xs"
                        value={patch}
                        onChange={e => {
                            setPatch(e.target.value);
                            setReport(null);
                        }}
                        placeholder="Paste the contents of a .patch file here…"
                        disabled={busy}
                    />

                    <div className="flex flex-wrap items-center gap-4">
                        <RadioGroup
                            aria-label="Apply mode"
                            value={mode}
                            onValueChange={v =>
                                setMode((v ?? 'working') as PatchApplyMode)
                            }
                            className="flex gap-3"
                        >
                            {MODES.map(m => (
                                <label
                                    key={m.mode}
                                    className="flex items-center gap-1.5 text-sm"
                                >
                                    <RadioGroupItem
                                        value={m.mode}
                                        aria-label={`${m.mode} mode`}
                                    />
                                    {m.label}
                                </label>
                            ))}
                        </RadioGroup>
                        <label className="flex items-center gap-1.5 text-sm">
                            <Checkbox
                                aria-label="3-way merge"
                                checked={threeWay}
                                onCheckedChange={c => setThreeWay(c === true)}
                                disabled={busy}
                            />
                            3-way fallback
                        </label>
                        <label className="flex items-center gap-1.5 text-sm">
                            <Checkbox
                                aria-label="Preview patch"
                                checked={showPreview}
                                onCheckedChange={c =>
                                    setShowPreview(c === true)
                                }
                            />
                            Preview
                        </label>
                    </div>

                    {showPreview && !empty && <PatchPreview text={patch} />}

                    {report !== null && (
                        <p
                            role="status"
                            className={
                                report.clean
                                    ? 'text-xs text-green-600 dark:text-green-400'
                                    : 'text-destructive text-xs'
                            }
                        >
                            {report.clean
                                ? `Applies cleanly — touches ${report.files.length} file(s).`
                                : 'This patch does NOT apply cleanly.'}
                        </p>
                    )}
                    {error !== null && (
                        <p role="alert" className="text-destructive text-xs">
                            {error}
                        </p>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={check}
                            disabled={empty || busy}
                        >
                            {inspect.isPending ? 'Checking…' : 'Check'}
                        </Button>
                        <Button
                            size="sm"
                            onClick={runApply}
                            disabled={empty || busy}
                        >
                            {apply.isPending ? 'Applying…' : 'Apply'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
