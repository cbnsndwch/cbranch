// Git note editor (docs/spec/17 REQ-P6-NOTE-002/004). A CodeMirror 6 message field to add
// or edit the note on a commit (default `commits` ref). Saving rewrites the notes ref, not
// the commit — the hash is unchanged, which the copy makes explicit.

import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { shortOid } from '../lib/format';
import { useNote, useSetNote } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

export function NoteEditorDialog({ repoId }: { repoId: RepoId }) {
    const editor = useUiStore(s => s.noteEditor);
    if (editor === null) return null;
    return <NoteEditorBody key={editor.oid} repoId={repoId} oid={editor.oid} />;
}

function NoteEditorBody({ repoId, oid }: { repoId: RepoId; oid: Oid }) {
    const setEditor = useUiStore(s => s.setNoteEditor);
    const note = useNote(repoId, oid);
    const setNote = useSetNote(repoId);

    const [text, setText] = useState<string | null>(null);
    const loaded = note.data;
    useEffect(() => {
        if (loaded !== undefined && text === null) setText(loaded.text);
    }, [loaded, text]);

    const close = () => {
        if (!setNote.isPending) setEditor(null);
    };

    const save = () => {
        if (text === null) return;
        setNote.mutate(
            { oid, text },
            {
                onSuccess: () => {
                    toast.success('Note saved');
                    setEditor(null);
                },
                onError: () => toast.error('Could not save the note'),
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
            <DialogContent style={{ width: 'min(640px, 92vw)' }}>
                <div className="flex h-[50vh] flex-col gap-3 p-4">
                    <DialogTitle>Note on {shortOid(oid)}</DialogTitle>
                    <p className="text-muted-foreground text-xs">
                        Editing this note rewrites the notes ref, not the commit
                        — the commit's hash does not change.
                    </p>
                    <div className="min-h-0 flex-1 border">
                        {note.isLoading || text === null ? (
                            <p className="text-muted-foreground p-2 text-xs">
                                Loading…
                            </p>
                        ) : (
                            <CodeMirrorEditor
                                initialValue={text}
                                onChange={setText}
                                ariaLabel="Note message"
                            />
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={setNote.isPending}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={save}
                            disabled={setNote.isPending || text === null}
                        >
                            {setNote.isPending ? 'Saving…' : 'Save note'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
