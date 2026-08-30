import { type TagInfo, type TagType, type RepoId } from '@cbranch/rpc-contract';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
    useRemoteList,
    useTagCreate,
    useTagDelete,
    useTagDeleteRemote,
    useTagList,
    useTagPush,
} from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogClose,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Input } from './ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from './ui/select';

interface TagsPanelProps {
    repoId: RepoId;
}

export function TagsPanel({ repoId }: TagsPanelProps) {
    const { data: tags, isLoading } = useTagList(repoId);
    const { data: remotes } = useRemoteList(repoId);
    const createMut = useTagCreate(repoId);
    const deleteMut = useTagDelete(repoId);
    const pushMut = useTagPush(repoId);
    const deleteRemoteMut = useTagDeleteRemote(repoId);

    // Create dialog open-state is lifted to the store so the menu/palette can open it.
    const createOpen = useUiStore(s => s.tagCreateOpen);
    const setCreateOpen = useUiStore(s => s.setTagCreateOpen);
    const createTarget = useUiStore(s => s.tagCreateTarget);
    const setCreateTarget = useUiStore(s => s.setTagCreateTarget);
    const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
    // Tag push / delete-remote let the user pick the remote (UI-011) rather than assuming
    // `origin`. Opening the picker seeds the choice with the first configured remote.
    const [remoteAction, setRemoteAction] = useState<{
        kind: 'push' | 'deleteRemote';
        tag: string;
    } | null>(null);
    const [selectedRemote, setSelectedRemote] = useState('');

    const remoteList = remotes ?? [];

    const openRemoteAction = (kind: 'push' | 'deleteRemote', tag: string) => {
        setSelectedRemote(remoteList[0]?.name ?? 'origin');
        setRemoteAction({ kind, tag });
    };

    const [tagName, setTagName] = useState('');
    const [tagType, setTagType] = useState<TagType>('lightweight');
    const [tagTarget, setTagTarget] = useState('HEAD');
    const [tagMessage, setTagMessage] = useState('');
    const [tagForce, setTagForce] = useState(false);

    useEffect(() => {
        if (createOpen && createTarget) setTagTarget(createTarget);
    }, [createOpen, createTarget]);

    const list = tags ?? [];

    const handleCreate = () => {
        const name = tagName.trim();
        if (!name) return;
        createMut.mutate(
            {
                name,
                target: tagTarget.trim() || undefined,
                tagType,
                message: tagMessage.trim() || undefined,
                force: tagForce,
            },
            {
                onSuccess: () => {
                    toast.success('Tag created');
                    setCreateOpen(false);
                    setCreateTarget(null);
                    setTagName('');
                    setTagType('lightweight');
                    setTagTarget('HEAD');
                    setTagMessage('');
                    setTagForce(false);
                },
                onError: err => toast.error(String(err)),
            },
        );
    };

    const handleDeleteLocal = (name: string) => {
        deleteMut.mutate(
            { name },
            {
                onSuccess: () => {
                    toast.success('Tag deleted');
                    setDeleteTarget(null);
                },
                onError: err => toast.error(String(err)),
            },
        );
    };

    const handlePush = (name: string, remote: string) => {
        pushMut.mutate(
            { remote, name },
            {
                onSuccess: () => {
                    toast.success('Tag pushed to "' + remote + '"');
                    setRemoteAction(null);
                },
                onError: err => toast.error(String(err)),
            },
        );
    };

    const handleDeleteRemote = (name: string, remote: string) => {
        deleteRemoteMut.mutate(
            { remote, name },
            {
                onSuccess: () => {
                    toast.success('Tag deleted from "' + remote + '"');
                    setRemoteAction(null);
                },
                onError: err => toast.error(String(err)),
            },
        );
    };

    return (
        <div className="flex h-full flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between border-b px-3 py-1.5">
                <h2 className="text-sm font-medium">Tags ({list.length})</h2>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                    className="h-[22px] px-2 text-[11px]"
                >
                    + New Tag
                </Button>
            </div>

            {/* Tag list */}
            <div className="min-h-0 flex-1 overflow-auto">
                {isLoading && (
                    <div className="text-muted-foreground px-3 py-4 text-sm">
                        Loading tags…
                    </div>
                )}
                {!isLoading && list.length === 0 && (
                    <div className="text-muted-foreground px-3 py-4 text-sm">
                        No tags.
                    </div>
                )}
                {list.map(tag => (
                    <TagRow
                        key={tag.name}
                        tag={tag}
                        onDeleteLocal={name => setDeleteTarget(name)}
                        onPush={name => openRemoteAction('push', name)}
                        onDeleteRemote={name =>
                            openRemoteAction('deleteRemote', name)
                        }
                    />
                ))}
            </div>

            {/* Create tag dialog */}
            <AlertDialog
                open={createOpen}
                onOpenChange={open => {
                    setCreateOpen(open);
                    if (!open) {
                        setCreateTarget(null);
                        setTagTarget('HEAD');
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Create tag</AlertDialogTitle>
                        <AlertDialogDescription>
                            Create a new Git tag at the specified target.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex flex-col gap-3 py-2">
                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium">
                                Tag name
                            </span>
                            <Input
                                value={tagName}
                                onChange={e => setTagName(e.target.value)}
                                placeholder="v1.0.0"
                                autoFocus
                            />
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium">Type</span>
                            <Select
                                value={tagType}
                                onValueChange={value =>
                                    setTagType(
                                        (value ?? 'lightweight') as TagType,
                                    )
                                }
                            >
                                <SelectTrigger
                                    aria-label="Tag type"
                                    className="h-8 w-full"
                                >
                                    <SelectValue>
                                        {(value: TagType) =>
                                            value === 'annotated'
                                                ? 'Annotated'
                                                : value === 'signed'
                                                  ? 'Signed'
                                                  : 'Lightweight'
                                        }
                                    </SelectValue>
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="lightweight">
                                        Lightweight
                                    </SelectItem>
                                    <SelectItem value="annotated">
                                        Annotated
                                    </SelectItem>
                                    <SelectItem value="signed">
                                        Signed
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium">Target</span>
                            <Input
                                value={tagTarget}
                                onChange={e => setTagTarget(e.target.value)}
                                placeholder="HEAD"
                            />
                        </label>
                        {(tagType === 'annotated' || tagType === 'signed') && (
                            <label className="flex flex-col gap-1">
                                <span className="text-xs font-medium">
                                    Message
                                </span>
                                <Input
                                    value={tagMessage}
                                    onChange={e =>
                                        setTagMessage(e.target.value)
                                    }
                                    placeholder="Release v1.0.0"
                                />
                            </label>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                aria-label="Force overwrite existing tag"
                                checked={tagForce}
                                onCheckedChange={checked =>
                                    setTagForce(checked)
                                }
                            />
                            Force (overwrite existing tag)
                        </label>
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogClose onClick={() => setCreateOpen(false)}>
                            Cancel
                        </AlertDialogClose>
                        <AlertDialogAction
                            onClick={handleCreate}
                            disabled={!tagName.trim() || createMut.isPending}
                            className="bg-primary text-primary-foreground hover:bg-primary/90"
                        >
                            {createMut.isPending ? 'Creating…' : 'Create'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Remote picker for push / delete-remote (UI-011) */}
            <AlertDialog
                open={remoteAction !== null}
                onOpenChange={open => {
                    if (!open) setRemoteAction(null);
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {remoteAction?.kind === 'deleteRemote'
                                ? 'Delete tag from remote'
                                : 'Push tag to remote'}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {remoteAction
                                ? remoteAction.kind === 'deleteRemote'
                                    ? 'Delete tag "' +
                                      remoteAction.tag +
                                      '" from the selected remote.'
                                    : 'Push tag "' +
                                      remoteAction.tag +
                                      '" to the selected remote.'
                                : ''}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="py-2">
                        {remoteList.length === 0 ? (
                            <p className="text-muted-foreground text-sm">
                                No remotes configured.
                            </p>
                        ) : (
                            <label className="flex flex-col gap-1">
                                <span className="text-xs font-medium">
                                    Remote
                                </span>
                                <Select
                                    value={selectedRemote}
                                    onValueChange={value =>
                                        setSelectedRemote(value ?? '')
                                    }
                                >
                                    <SelectTrigger
                                        aria-label="Remote"
                                        className="h-8 w-full"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {remoteList.map(remote => (
                                            <SelectItem
                                                key={remote.name}
                                                value={remote.name}
                                            >
                                                {remote.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </label>
                        )}
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogClose onClick={() => setRemoteAction(null)}>
                            Cancel
                        </AlertDialogClose>
                        <AlertDialogAction
                            onClick={() => {
                                if (!remoteAction || !selectedRemote) return;
                                if (remoteAction.kind === 'deleteRemote') {
                                    handleDeleteRemote(
                                        remoteAction.tag,
                                        selectedRemote,
                                    );
                                } else {
                                    handlePush(
                                        remoteAction.tag,
                                        selectedRemote,
                                    );
                                }
                            }}
                            disabled={
                                !selectedRemote ||
                                pushMut.isPending ||
                                deleteRemoteMut.isPending
                            }
                            className={
                                remoteAction?.kind === 'deleteRemote'
                                    ? ''
                                    : 'bg-primary text-primary-foreground hover:bg-primary/90'
                            }
                        >
                            {remoteAction?.kind === 'deleteRemote'
                                ? 'Delete'
                                : 'Push'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Delete local confirm */}
            <DestructiveConfirmDialog
                open={deleteTarget !== null}
                onOpenChange={open => {
                    if (!open) setDeleteTarget(null);
                }}
                title="Delete tag"
                description={
                    'Delete local tag "' +
                    (deleteTarget ?? '') +
                    '"? This cannot be undone.'
                }
                confirmLabel="Delete"
                onConfirm={() => {
                    if (deleteTarget) handleDeleteLocal(deleteTarget);
                }}
            />
        </div>
    );
}

interface TagRowProps {
    tag: TagInfo;
    onDeleteLocal: (name: string) => void;
    onPush: (name: string) => void;
    onDeleteRemote: (name: string) => void;
}

function TagRow({ tag, onDeleteLocal, onPush, onDeleteRemote }: TagRowProps) {
    const shortOid = tag.targetOid ? String(tag.targetOid).slice(0, 7) : '—';
    const dateStr =
        tag.taggerDate && tag.taggerDate > 0
            ? new Date(tag.taggerDate * 1000).toLocaleDateString()
            : '';

    return (
        <div className="group hover:bg-accent/50 flex items-center px-3 py-1.5">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="font-mono text-xs">{tag.name}</span>
                    <span className="text-muted-foreground rounded border px-1 text-[9px]">
                        {tag.isAnnotated ? 'annotated' : 'lightweight'}
                    </span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex gap-3 text-[10px]">
                    <span className="font-mono">{shortOid}</span>
                    {dateStr && <span>{dateStr}</span>}
                    {tag.taggerName && <span>{tag.taggerName}</span>}
                </div>
            </div>
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="hover:bg-accent flex h-5 w-5 shrink-0 items-center justify-center text-[11px] opacity-0 group-hover:opacity-100"
                    aria-label="Tag actions"
                >
                    …
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="end">
                    <DropdownMenuItem onClick={() => onPush(tag.name)}>
                        Push to remote…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onDeleteLocal(tag.name)}
                    >
                        Delete local
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onDeleteRemote(tag.name)}
                    >
                        Delete from remote…
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}
