import { ChangeSetPullRequest, type Engagement } from '@cbranch/rpc-contract';
import {
    ArrowDown,
    ArrowUp,
    ExternalLink,
    GitPullRequest,
    ListOrdered,
    Loader2,
    Plus,
    Save,
    Trash2,
    X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
    useCreateChangeSet,
    useDeleteChangeSet,
    useSetChangeSetItems,
    useUpdateChangeSet,
} from '../rpc/hooks';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);

export function EngagementChangeSets({
    engagement,
    onBrowsePullRequests,
}: {
    readonly engagement: Engagement;
    readonly onBrowsePullRequests: () => void;
}) {
    const create = useCreateChangeSet();
    const update = useUpdateChangeSet();
    const remove = useDeleteChangeSet();
    const setItems = useSetChangeSetItems();
    const [selectedId, setSelectedId] = useState<string | null>(
        engagement.changeSets[0]?.id ?? null,
    );
    const selected = engagement.changeSets.find(
        changeSet => changeSet.id === selectedId,
    );
    const [name, setName] = useState(selected?.name ?? '');
    const [description, setDescription] = useState(selected?.description ?? '');
    const [items, setLocalItems] = useState<
        ReadonlyArray<ChangeSetPullRequest>
    >(selected?.pullRequests ?? []);
    const [deleteOpen, setDeleteOpen] = useState(false);

    useEffect(() => {
        if (
            selectedId !== null &&
            engagement.changeSets.some(changeSet => changeSet.id === selectedId)
        )
            return;
        setSelectedId(engagement.changeSets[0]?.id ?? null);
    }, [engagement.changeSets, selectedId]);

    useEffect(() => {
        setName(selected?.name ?? '');
        setDescription(selected?.description ?? '');
        setLocalItems(selected?.pullRequests ?? []);
    }, [selected?.id, selected?.updatedAt]);

    const createSet = () => {
        create.mutate(
            { engagementId: engagement.id, name: 'New change set' },
            {
                onSuccess: workspace => {
                    const next = workspace.engagements
                        .find(item => item.id === engagement.id)
                        ?.changeSets.at(-1);
                    if (next) setSelectedId(next.id);
                },
                onError: error => toast.error(errorMessage(error)),
            },
        );
    };

    const save = async () => {
        if (!selected || name.trim() === '') return;
        try {
            await update.mutateAsync({
                engagementId: engagement.id,
                changeSetId: selected.id,
                name: name.trim(),
                description,
            });
            await setItems.mutateAsync({
                engagementId: engagement.id,
                changeSetId: selected.id,
                items,
            });
            toast.success('Change set saved');
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    const deleteSet = () => {
        if (!selected) return;
        remove.mutate(
            {
                engagementId: engagement.id,
                changeSetId: selected.id,
            },
            {
                onSuccess: workspace => {
                    const next = workspace.engagements.find(
                        item => item.id === engagement.id,
                    )?.changeSets[0];
                    setSelectedId(next?.id ?? null);
                    setDeleteOpen(false);
                },
                onError: error => toast.error(errorMessage(error)),
            },
        );
    };

    const move = (index: number, delta: -1 | 1) => {
        const target = index + delta;
        if (target < 0 || target >= items.length) return;
        const next = [...items];
        [next[index], next[target]] = [next[target]!, next[index]!];
        setLocalItems(next);
    };

    const updateNote = (index: number, dependencyNote: string) =>
        setLocalItems(current =>
            current.map((item, itemIndex) =>
                itemIndex === index
                    ? new ChangeSetPullRequest({
                          ...item,
                          dependencyNote,
                      })
                    : item,
            ),
        );

    const dirty =
        selected !== undefined &&
        (name !== selected.name ||
            description !== selected.description ||
            JSON.stringify(items) !== JSON.stringify(selected.pullRequests));
    const pending = update.isPending || setItems.isPending;

    return (
        <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:grid-cols-[210px_1fr] sm:grid-rows-1">
            <div className="bg-muted/30 flex min-h-0 flex-col border-b sm:border-r sm:border-b-0">
                <div className="flex h-9 shrink-0 items-center justify-between border-b px-2 text-xs font-medium">
                    Change sets
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="New change set"
                        onClick={createSet}
                        disabled={create.isPending}
                    >
                        {create.isPending ? (
                            <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                            <Plus className="size-3.5" />
                        )}
                    </Button>
                </div>
                <div className="max-h-36 min-h-0 overflow-auto p-1 sm:max-h-none sm:flex-1">
                    {engagement.changeSets.map(changeSet => (
                        <button
                            key={changeSet.id}
                            type="button"
                            onClick={() => setSelectedId(changeSet.id)}
                            className={
                                selectedId === changeSet.id
                                    ? 'bg-accent flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs'
                                    : 'flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent/50'
                            }
                        >
                            <ListOrdered className="text-muted-foreground size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">
                                    {changeSet.name}
                                </span>
                                <span className="text-muted-foreground">
                                    {changeSet.pullRequests.length} PRs
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            </div>
            {selected ? (
                <div className="flex min-h-0 flex-col overflow-hidden">
                    <div className="grid shrink-0 gap-2 border-b p-3 sm:grid-cols-[1fr_1.5fr_auto]">
                        <label className="grid gap-1 text-xs">
                            Name
                            <Input
                                value={name}
                                onChange={event => setName(event.target.value)}
                                disabled={pending}
                            />
                        </label>
                        <label className="grid gap-1 text-xs">
                            Coordination notes
                            <Input
                                value={description}
                                onChange={event =>
                                    setDescription(event.target.value)
                                }
                                disabled={pending}
                            />
                        </label>
                        <div className="flex items-end justify-end gap-1">
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                aria-label="Delete change set"
                                onClick={() => setDeleteOpen(true)}
                                disabled={pending}
                            >
                                <Trash2 className="size-3.5" />
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                onClick={() => void save()}
                                disabled={
                                    !dirty || pending || name.trim() === ''
                                }
                            >
                                {pending ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                    <Save className="size-3.5" />
                                )}
                                Save
                            </Button>
                        </div>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                        {items.map((item, index) => (
                            <ChangeSetRow
                                key={`${item.repoId}/${item.number}`}
                                item={item}
                                index={index}
                                count={items.length}
                                onMove={delta => move(index, delta)}
                                onNote={note => updateNote(index, note)}
                                onRemove={() =>
                                    setLocalItems(current =>
                                        current.filter(
                                            (_, itemIndex) =>
                                                itemIndex !== index,
                                        ),
                                    )
                                }
                            />
                        ))}
                        {items.length === 0 ? (
                            <div className="grid min-h-52 place-items-center text-center">
                                <div>
                                    <GitPullRequest className="text-muted-foreground mx-auto mb-2 size-7" />
                                    <p className="text-muted-foreground mb-3 text-xs">
                                        No pull requests in this change set.
                                    </p>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={onBrowsePullRequests}
                                    >
                                        Browse pull requests
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : (
                <div className="grid min-h-52 place-items-center text-center">
                    <div>
                        <ListOrdered className="text-muted-foreground mx-auto mb-2 size-7" />
                        <Button size="sm" onClick={createSet}>
                            <Plus className="size-3.5" />
                            New change set
                        </Button>
                    </div>
                </div>
            )}
            <DestructiveConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title={`Delete ${selected?.name ?? 'change set'}?`}
                description="The pull requests remain on GitHub. Only this coordination record is removed."
                confirmLabel="Delete change set"
                onConfirm={deleteSet}
            />
        </div>
    );
}

function ChangeSetRow({
    item,
    index,
    count,
    onMove,
    onNote,
    onRemove,
}: {
    readonly item: ChangeSetPullRequest;
    readonly index: number;
    readonly count: number;
    readonly onMove: (delta: -1 | 1) => void;
    readonly onNote: (note: string) => void;
    readonly onRemove: () => void;
}) {
    const repositoryUrl = `https://github.com/${item.repository}`;
    return (
        <div className="grid gap-2 border-b p-3 lg:grid-cols-[36px_minmax(240px,1fr)_minmax(220px,1fr)_auto]">
            <div className="flex items-start gap-1 lg:flex-col">
                <Badge tone="muted">{index + 1}</Badge>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Move ${item.title} up`}
                    disabled={index === 0}
                    onClick={() => onMove(-1)}
                >
                    <ArrowUp className="size-3" />
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label={`Move ${item.title} down`}
                    disabled={index === count - 1}
                    onClick={() => onMove(1)}
                >
                    <ArrowDown className="size-3" />
                </Button>
            </div>
            <div className="min-w-0">
                <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-1 text-sm font-medium hover:underline"
                >
                    <GitPullRequest className="mt-0.5 size-3.5 shrink-0" />
                    <span>{item.title}</span>
                    <ExternalLink className="mt-0.5 size-3 shrink-0" />
                </a>
                <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-2 text-[10px]">
                    <a
                        href={repositoryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono hover:underline"
                    >
                        {item.repository}#{item.number}
                    </a>
                    <a
                        href={`${repositoryUrl}/tree/${encodeURIComponent(item.headRefName)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono hover:underline"
                    >
                        {item.headRefName}
                    </a>
                    <span>-&gt;</span>
                    <a
                        href={`${repositoryUrl}/tree/${encodeURIComponent(item.baseRefName)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono hover:underline"
                    >
                        {item.baseRefName}
                    </a>
                </div>
            </div>
            <label className="grid gap-1 text-xs">
                Dependency note
                <Textarea
                    value={item.dependencyNote}
                    onChange={event => onNote(event.target.value)}
                    rows={2}
                    placeholder="Ordering or rollout dependency"
                />
            </label>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Remove ${item.title} from change set`}
                onClick={onRemove}
            >
                <X className="size-3.5" />
            </Button>
        </div>
    );
}
