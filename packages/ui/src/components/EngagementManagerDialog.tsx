import { type EngagementColor, type EngagementId } from '@cbranch/rpc-contract';
import {
    ArrowDown,
    ArrowUp,
    FolderPlus,
    GripVertical,
    ImageUp,
    Plus,
    Trash2,
    X,
} from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '../lib/cn';
import {
    ENGAGEMENT_COLORS,
    engagementSwatchClass,
    moveWorkspaceId,
} from '../lib/engagements';
import {
    useActivateEngagement,
    useCreateEngagement,
    useDeleteEngagement,
    useEngagementWorkspace,
    useRemoveEngagementRepo,
    useReorderEngagements,
    useUpdateEngagement,
} from '../rpc/hooks';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { WorkspaceAvatar } from './WorkspaceAvatar';

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);

export function EngagementManagerDialog() {
    const open = useUiStore(s => s.engagementManagerOpen);
    const setOpen = useUiStore(s => s.setEngagementManagerOpen);
    const activeEngagementId = useUiStore(s => s.activeEngagementId);
    const openSwitcher = useUiStore(s => s.setRepoSwitcherOpen);
    const workspace = useEngagementWorkspace();
    const create = useCreateEngagement();
    const update = useUpdateEngagement();
    const removeRepo = useRemoveEngagementRepo();
    const removeEngagement = useDeleteEngagement();
    const activate = useActivateEngagement();
    const reorder = useReorderEngagements();
    const { openEngagement } = useNavigation();
    const [selectedId, setSelectedId] = useState<EngagementId | null>(null);
    const [name, setName] = useState('');
    const [color, setColor] = useState<EngagementColor>('teal');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [uploadingAvatar, setUploadingAvatar] = useState(false);
    const [removingAvatar, setRemovingAvatar] = useState(false);
    const [draggedId, setDraggedId] = useState<EngagementId | null>(null);
    const avatarFileInputRef = useRef<HTMLInputElement>(null);

    const selected = workspace.data?.engagements.find(
        engagement => engagement.id === selectedId,
    );

    useEffect(() => {
        if (!open) return;
        const initial =
            workspace.data?.engagements.find(
                engagement => engagement.id === activeEngagementId,
            ) ?? workspace.data?.engagements[0];
        setSelectedId(initial?.id ?? null);
        setName(initial?.name ?? '');
        setColor(initial?.color ?? 'teal');
        setAvatarUrl(initial?.avatarUrl ?? '');
    }, [activeEngagementId, open, workspace.data]);

    const select = (id: EngagementId) => {
        const engagement = workspace.data?.engagements.find(
            item => item.id === id,
        );
        setSelectedId(id);
        setName(engagement?.name ?? '');
        setColor(engagement?.color ?? 'teal');
        setAvatarUrl(engagement?.avatarUrl ?? '');
    };

    const moveWorkspace = (source: EngagementId, target: EngagementId) => {
        if (source === target || reorder.isPending) return;
        reorder.mutate(
            moveWorkspaceId(
                (workspace.data?.engagements ?? []).map(
                    engagement => engagement.id,
                ),
                source,
                target,
            ),
            { onError: error => toast.error(errorMessage(error)) },
        );
    };

    const startCreate = () => {
        setSelectedId(null);
        setName('');
        setColor('teal');
        setAvatarUrl('');
    };

    const uploadAvatar = async (file: File) => {
        if (!selected) return;
        if (file.size > 2 * 1024 * 1024) {
            toast.error('Workspace images must be 2 MB or smaller.');
            return;
        }
        setUploadingAvatar(true);
        try {
            const response = await fetch(
                `/sidechannel/workspace-avatar?engagementId=${encodeURIComponent(selected.id)}`,
                { method: 'POST', body: file },
            );
            if (!response.ok)
                throw new Error(
                    (await response.text()) || 'Image upload failed',
                );
            const payload: unknown = await response.json();
            if (
                typeof payload !== 'object' ||
                payload === null ||
                !('avatarUrl' in payload) ||
                typeof payload.avatarUrl !== 'string'
            )
                throw new Error('Image upload returned an invalid response');
            setAvatarUrl(payload.avatarUrl);
            await workspace.refetch();
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setUploadingAvatar(false);
        }
    };

    const onAvatarFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void uploadAvatar(file);
    };

    const removeAvatar = async () => {
        if (!selected) return;
        setRemovingAvatar(true);
        try {
            const response = await fetch(
                `/sidechannel/workspace-avatar?engagementId=${encodeURIComponent(selected.id)}`,
                { method: 'DELETE' },
            );
            if (!response.ok)
                throw new Error(
                    (await response.text()) || 'Image removal failed',
                );
            setAvatarUrl('');
            await workspace.refetch();
        } catch (error) {
            toast.error(errorMessage(error));
        } finally {
            setRemovingAvatar(false);
        }
    };

    const save = () => {
        if (name.trim() === '') return;
        if (selected) {
            update.mutate(
                {
                    engagementId: selected.id,
                    name: name.trim(),
                    color,
                    avatarUrl: avatarUrl.trim() === '' ? null : avatarUrl,
                },
                {
                    onError: error => toast.error(errorMessage(error)),
                },
            );
            return;
        }
        create.mutate(
            {
                name: name.trim(),
                color,
                avatarUrl:
                    avatarUrl.trim() === '' ? undefined : avatarUrl.trim(),
            },
            {
                onSuccess: next => {
                    const created = next.engagements.at(-1);
                    if (!created) return;
                    setSelectedId(created.id);
                    openEngagement(created.id);
                },
                onError: error => toast.error(errorMessage(error)),
            },
        );
    };

    const addRepository = () => {
        if (!selected) return;
        activate.mutate(selected.id, {
            onSuccess: () => {
                openEngagement(selected.id);
                setOpen(false);
                openSwitcher(true);
            },
        });
    };

    const confirmDelete = () => {
        if (!selected) return;
        removeEngagement.mutate(selected.id, {
            onSuccess: next => {
                const fallback = next.engagements[0];
                if (fallback) {
                    setSelectedId(fallback.id);
                    openEngagement(fallback.id);
                } else {
                    setSelectedId(null);
                    setName('');
                    setAvatarUrl('');
                }
            },
            onError: error => toast.error(errorMessage(error)),
        });
    };

    const pending =
        create.isPending ||
        update.isPending ||
        reorder.isPending ||
        uploadingAvatar ||
        removingAvatar;

    return (
        <>
            <Dialog
                open={open}
                onOpenChange={next => {
                    if (!pending) setOpen(next);
                }}
            >
                <DialogContent className="h-[min(620px,calc(100dvh-32px))] w-[min(760px,calc(100vw-24px))] overflow-hidden">
                    <DialogHeader className="shrink-0 border-b p-3">
                        <div>
                            <DialogTitle>Workspaces</DialogTitle>
                            <DialogDescription>
                                Isolated client contexts and their repository
                                sessions.
                            </DialogDescription>
                        </div>
                    </DialogHeader>
                    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[150px_minmax(0,1fr)] sm:grid-cols-[210px_1fr] sm:grid-rows-1">
                        <div className="bg-muted/50 flex min-h-0 flex-col border-b sm:border-r sm:border-b-0">
                            <div className="flex h-9 shrink-0 items-center justify-between border-b px-2 text-xs font-medium">
                                Workspaces
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-7"
                                    aria-label="New workspace"
                                    onClick={startCreate}
                                >
                                    <Plus className="size-4" />
                                </Button>
                            </div>
                            <div className="min-h-0 flex-1 overflow-auto p-1">
                                {(workspace.data?.engagements ?? []).map(
                                    (engagement, index, engagements) => (
                                        <div
                                            key={engagement.id}
                                            draggable={!reorder.isPending}
                                            onDragStart={event => {
                                                setDraggedId(engagement.id);
                                                event.dataTransfer.effectAllowed =
                                                    'move';
                                            }}
                                            onDragOver={event => {
                                                if (draggedId === null) return;
                                                event.preventDefault();
                                                event.dataTransfer.dropEffect =
                                                    'move';
                                            }}
                                            onDrop={event => {
                                                event.preventDefault();
                                                if (draggedId)
                                                    moveWorkspace(
                                                        draggedId,
                                                        engagement.id,
                                                    );
                                                setDraggedId(null);
                                            }}
                                            onDragEnd={() => setDraggedId(null)}
                                            className={cn(
                                                'flex w-full items-center gap-1 px-1 py-1 text-xs',
                                                selectedId === engagement.id
                                                    ? 'bg-accent text-accent-foreground'
                                                    : 'hover:bg-accent/50',
                                                draggedId === engagement.id &&
                                                    'opacity-40',
                                            )}
                                        >
                                            <GripVertical className="text-muted-foreground size-3 shrink-0" />
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    select(engagement.id)
                                                }
                                                className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left"
                                            >
                                                <WorkspaceAvatar
                                                    name={engagement.name}
                                                    color={engagement.color}
                                                    avatarUrl={
                                                        engagement.avatarUrl
                                                    }
                                                    className="size-7 text-[9px] font-semibold"
                                                />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate font-medium">
                                                        {engagement.name}
                                                    </span>
                                                    <span className="text-muted-foreground">
                                                        {
                                                            engagement
                                                                .repositories
                                                                .length
                                                        }{' '}
                                                        repos
                                                    </span>
                                                </span>
                                            </button>
                                            <div className="flex shrink-0 flex-col">
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="size-4"
                                                    aria-label={`Move ${engagement.name} up`}
                                                    disabled={
                                                        index === 0 ||
                                                        reorder.isPending
                                                    }
                                                    onClick={() =>
                                                        moveWorkspace(
                                                            engagement.id,
                                                            engagements[
                                                                index - 1
                                                            ]!.id,
                                                        )
                                                    }
                                                >
                                                    <ArrowUp className="size-3" />
                                                </Button>
                                                <Button
                                                    type="button"
                                                    variant="ghost"
                                                    size="icon"
                                                    className="size-4"
                                                    aria-label={`Move ${engagement.name} down`}
                                                    disabled={
                                                        index ===
                                                            engagements.length -
                                                                1 ||
                                                        reorder.isPending
                                                    }
                                                    onClick={() =>
                                                        moveWorkspace(
                                                            engagement.id,
                                                            engagements[
                                                                index + 1
                                                            ]!.id,
                                                        )
                                                    }
                                                >
                                                    <ArrowDown className="size-3" />
                                                </Button>
                                            </div>
                                        </div>
                                    ),
                                )}
                            </div>
                        </div>
                        <div className="flex min-h-0 flex-col">
                            <div className="grid shrink-0 gap-3 border-b p-3">
                                <label className="grid gap-1 text-xs">
                                    Workspace name
                                    <Input
                                        autoFocus={selectedId === null}
                                        value={name}
                                        onChange={event =>
                                            setName(event.target.value)
                                        }
                                        placeholder="Client or workspace name"
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Avatar image URL (optional)
                                    <Input
                                        type="text"
                                        value={avatarUrl}
                                        onChange={event =>
                                            setAvatarUrl(event.target.value)
                                        }
                                        placeholder="https://example.com/avatar.png"
                                    />
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        ref={avatarFileInputRef}
                                        type="file"
                                        accept="image/png,image/jpeg,image/gif,image/webp"
                                        className="sr-only"
                                        onChange={onAvatarFileChange}
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        disabled={!selected || pending}
                                        onClick={() =>
                                            avatarFileInputRef.current?.click()
                                        }
                                    >
                                        <ImageUp className="size-3.5" />
                                        Upload image
                                    </Button>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={
                                            !selected ||
                                            pending ||
                                            avatarUrl.trim() === ''
                                        }
                                        onClick={() => void removeAvatar()}
                                    >
                                        <X className="size-3.5" />
                                        Remove image
                                    </Button>
                                </div>
                                <fieldset className="grid gap-1">
                                    <legend className="text-xs">Color</legend>
                                    <div className="flex gap-2">
                                        {ENGAGEMENT_COLORS.map(option => (
                                            <button
                                                key={option}
                                                type="button"
                                                aria-label={option}
                                                aria-pressed={color === option}
                                                onClick={() => setColor(option)}
                                                className={cn(
                                                    'size-7 border-2 border-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                                    engagementSwatchClass[
                                                        option
                                                    ],
                                                    color === option
                                                        ? 'border-foreground ring-1 ring-background ring-offset-1 ring-offset-foreground'
                                                        : 'opacity-65 hover:opacity-100',
                                                )}
                                            />
                                        ))}
                                    </div>
                                </fieldset>
                            </div>
                            <div className="flex min-h-0 flex-1 flex-col">
                                <div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-xs font-medium">
                                    Repositories
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-7"
                                        disabled={!selected}
                                        onClick={addRepository}
                                    >
                                        <FolderPlus className="size-3.5" />
                                        Add
                                    </Button>
                                </div>
                                <div className="min-h-0 flex-1 overflow-auto">
                                    {selected?.repositories.map(repo => (
                                        <div
                                            key={repo.repoId}
                                            className="group flex items-center gap-2 border-b px-3 py-2"
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-xs font-medium">
                                                    {repo.name}
                                                </span>
                                                <span className="text-muted-foreground block truncate font-mono text-[10px]">
                                                    {repo.path}
                                                </span>
                                            </span>
                                            <Button
                                                type="button"
                                                variant="ghost"
                                                size="icon"
                                                className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                                aria-label={`Remove ${repo.name} from workspace`}
                                                onClick={() =>
                                                    removeRepo.mutate({
                                                        engagementId:
                                                            selected.id,
                                                        repoId: repo.repoId,
                                                    })
                                                }
                                            >
                                                <X className="size-3.5" />
                                            </Button>
                                        </div>
                                    ))}
                                    {selected &&
                                    selected.repositories.length === 0 ? (
                                        <p className="text-muted-foreground p-3 text-xs">
                                            No repositories assigned.
                                        </p>
                                    ) : null}
                                    {!selected ? (
                                        <p className="text-muted-foreground p-3 text-xs">
                                            Save the workspace before adding
                                            repositories.
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </div>
                    <DialogFooter className="shrink-0 flex-row items-center justify-between border-t p-3">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={!selected || removeEngagement.isPending}
                            onClick={() => setDeleteOpen(true)}
                        >
                            <Trash2 className="size-3.5" />
                            Delete
                        </Button>
                        <div className="flex gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setOpen(false)}
                                disabled={pending}
                            >
                                Close
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                onClick={save}
                                disabled={pending || name.trim() === ''}
                            >
                                {selected ? 'Save changes' : 'Create workspace'}
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            <DestructiveConfirmDialog
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                title={`Delete ${selected?.name ?? 'workspace'}?`}
                description="The repositories stay on disk and become unassigned. Open tabs and workspace settings are removed."
                confirmLabel="Delete workspace"
                onConfirm={confirmDelete}
                paths={selected?.repositories.map(repo => repo.path)}
            />
        </>
    );
}
