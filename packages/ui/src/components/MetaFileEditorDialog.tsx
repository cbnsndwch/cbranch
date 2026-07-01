// Repository metadata-file editors (docs/spec/17 REQ-P6-META-001..005). A dialog with a
// CodeMirror 6 plain-text editor over a CLOSED set of files — the root .gitignore /
// .gitattributes / .mailmap and the private .git/info/exclude. Opening reads current
// content (or an empty editor that creates the file on save); Save writes it atomically on
// the host and invalidates the affected status/diff/identity views. info/exclude is clearly
// labeled private (never committed).

import { type MetaFile, type RepoId } from '@cbranch/rpc-contract';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useMetaFile, useWriteMetaFile } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

const FILES: ReadonlyArray<{
    file: MetaFile;
    label: string;
    private?: boolean;
}> = [
    { file: 'gitignore', label: '.gitignore' },
    { file: 'gitattributes', label: '.gitattributes' },
    { file: 'mailmap', label: '.mailmap' },
    { file: 'info-exclude', label: '.git/info/exclude', private: true },
];

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Save failed.';

export function MetaFileEditorDialog({ repoId }: { repoId: RepoId }) {
    const file = useUiStore(s => s.metaFileDialog);
    if (file === null) return null;
    return <MetaFileEditorBody key={file} repoId={repoId} file={file} />;
}

function MetaFileEditorBody({
    repoId,
    file,
}: {
    repoId: RepoId;
    file: MetaFile;
}) {
    const setFile = useUiStore(s => s.setMetaFileDialog);
    const query = useMetaFile(repoId, file);
    const write = useWriteMetaFile(repoId);

    // Editor state, seeded once from the loaded content (the editor is uncontrolled after).
    const [text, setText] = useState<string | null>(null);
    const loaded = query.data;
    useEffect(() => {
        if (loaded !== undefined && text === null) setText(loaded.text);
    }, [loaded, text]);

    const meta = FILES.find(f => f.file === file)!;
    const dirty = loaded !== undefined && text !== null && text !== loaded.text;

    const close = () => {
        if (!write.isPending) setFile(null);
    };

    const save = () => {
        if (text === null) return;
        write.mutate(
            { file, text },
            {
                onSuccess: () => toast.success(`Saved ${meta.label}`),
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
            <DialogContent style={{ width: 'min(760px, 94vw)' }}>
                <div className="flex h-[70vh] flex-col gap-3 p-4">
                    <DialogTitle>Edit repository metadata</DialogTitle>

                    <div className="flex flex-wrap gap-1">
                        {FILES.map(f => (
                            <Button
                                key={f.file}
                                size="sm"
                                variant={
                                    f.file === file ? 'default' : 'outline'
                                }
                                onClick={() => setFile(f.file)}
                                disabled={write.isPending}
                            >
                                {f.label}
                            </Button>
                        ))}
                    </div>

                    <div className="text-muted-foreground flex items-center gap-2 text-xs">
                        {meta.private ? (
                            <span>
                                Private to this repository — not committed.
                            </span>
                        ) : (
                            <span>
                                A working-tree file — saving it becomes a normal
                                stageable change.
                            </span>
                        )}
                        {loaded !== undefined && !loaded.exists && (
                            <span className="text-foreground">
                                (new file — created on save)
                            </span>
                        )}
                        {dirty && (
                            <span
                                role="status"
                                className="text-foreground font-medium"
                            >
                                • Unsaved changes
                            </span>
                        )}
                    </div>

                    <div className="min-h-0 flex-1 border">
                        {query.isLoading || text === null ? (
                            <p className="text-muted-foreground p-2 text-xs">
                                Loading…
                            </p>
                        ) : (
                            <CodeMirrorEditor
                                initialValue={text}
                                onChange={setText}
                                ariaLabel={`${meta.label} content`}
                            />
                        )}
                    </div>

                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={write.isPending}
                        >
                            Close
                        </Button>
                        <Button
                            size="sm"
                            onClick={save}
                            disabled={write.isPending || text === null}
                        >
                            {write.isPending ? 'Saving…' : 'Save'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
