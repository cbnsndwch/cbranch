import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import { toast } from 'sonner';

import { formatEpoch, formatInstant, shortOid } from '../lib/format';
import { useCommitDetail, useNote, useRemoveNote } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import { Placeholder } from './ui/placeholder';

// Commit details (P1-DET-1/3 + P1-UI-DET-1): identity, author/committer, full message,
// and navigable parents. Pointing-refs and the merge parent selector arrive in polish.
export function DetailsPanel({
    repoId,
    oid,
    onSelectOid,
}: {
    readonly repoId: RepoId;
    readonly oid: Oid | null;
    readonly onSelectOid: (oid: Oid) => void;
}) {
    const { data, isLoading, isError } = useCommitDetail(repoId, oid);
    const dateMode = useUiStore(s => s.dateMode);
    const setNoteEditor = useUiStore(s => s.setNoteEditor);
    const note = useNote(repoId, oid);
    const removeNote = useRemoveNote(repoId);

    if (oid === null)
        return <Placeholder>Select a commit to see its details.</Placeholder>;
    if (isLoading) return <Placeholder>Loading commit…</Placeholder>;
    if (isError || !data)
        return (
            <Placeholder tone="danger">
                Could not load commit {shortOid(oid)}.
            </Placeholder>
        );

    return (
        <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
            <div>
                <div className="text-muted-foreground font-mono text-xs break-all">
                    {data.oid}
                </div>
                <div className="mt-1 font-medium">{data.subject}</div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">author</dt>
                <dd>
                    {data.author.name} &lt;{data.author.email}&gt; ·{' '}
                    <span title={formatEpoch(data.author.when.epochSeconds)}>
                        {formatInstant(data.author.when.epochSeconds, dateMode)}
                    </span>
                </dd>
                <dt className="text-muted-foreground">committer</dt>
                <dd>
                    {data.committer.name} ·{' '}
                    <span title={formatEpoch(data.committer.when.epochSeconds)}>
                        {formatInstant(
                            data.committer.when.epochSeconds,
                            dateMode,
                        )}
                    </span>
                </dd>
            </dl>
            {data.body ? (
                <pre className="text-xs whitespace-pre-wrap">{data.body}</pre>
            ) : null}
            {data.parents.length > 0 ? (
                <div className="text-xs">
                    <span className="text-muted-foreground">parents: </span>
                    {data.parents.map(parent => (
                        <button
                            key={parent}
                            type="button"
                            onClick={() => onSelectOid(parent)}
                            className="text-primary mr-2 font-mono hover:underline"
                        >
                            {shortOid(parent)}
                        </button>
                    ))}
                </div>
            ) : null}

            {/* Git note (REQ-P6-NOTE-001/002/004): editing a note rewrites the notes ref,
          never the commit — the hash is unchanged. */}
            <div className="mt-1 border-t pt-2">
                <div className="mb-1 flex items-center gap-2">
                    <span className="text-muted-foreground text-xs font-medium">
                        Note
                    </span>
                    <div className="ml-auto flex gap-1">
                        <Button
                            size="sm"
                            variant="ghost"
                            className="h-5 px-1.5 text-xs"
                            onClick={() => setNoteEditor({ oid: data.oid })}
                        >
                            {note.data?.present ? 'Edit' : 'Add'}
                        </Button>
                        {note.data?.present && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="text-destructive hover:text-destructive h-5 px-1.5 text-xs"
                                disabled={removeNote.isPending}
                                onClick={() =>
                                    removeNote.mutate(
                                        { oid: data.oid },
                                        {
                                            onSuccess: () =>
                                                toast.success('Note removed'),
                                            onError: () =>
                                                toast.error(
                                                    'Could not remove the note',
                                                ),
                                        },
                                    )
                                }
                            >
                                Remove
                            </Button>
                        )}
                    </div>
                </div>
                {note.data?.present ? (
                    <pre className="bg-muted/30 border p-2 text-xs whitespace-pre-wrap">
                        {note.data.text}
                    </pre>
                ) : (
                    <p className="text-muted-foreground text-xs">
                        No note on this commit. A note does not change the
                        commit's hash.
                    </p>
                )}
            </div>
        </div>
    );
}
