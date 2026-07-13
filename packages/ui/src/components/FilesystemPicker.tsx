// Reusable host filesystem picker for repository and folder inputs. The browser never
// enumerates paths itself; every listing comes from the host-bounded FilesystemListDir RPC.

import {
    ArrowUp,
    Check,
    Eye,
    EyeOff,
    File,
    Folder,
    FolderGit2,
    FolderOpen,
    Link,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import { useFilesystemDirectory } from '../rpc/hooks';
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

type PickerMode = 'directory' | 'file';

const isAbsoluteHostPath = (value: string): boolean =>
    value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

const splitNewLeaf = (value: string): { parent?: string; leaf: string } => {
    const match = /^(.*[\\/])([^\\/]*)$/.exec(value);
    if (!match) return { leaf: '' };
    const rawParent = match[1]!;
    const parent =
        rawParent.endsWith('/') || rawParent.endsWith('\\')
            ? rawParent.slice(0, -1)
            : rawParent;
    return { parent: parent || rawParent, leaf: match[2] ?? '' };
};

const appendLeaf = (parent: string, leaf: string): string =>
    `${parent}${parent.includes('\\') ? '\\' : '/'}${leaf}`;

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : 'Could not list this host folder.';

export function FilesystemPickerButton({
    value,
    onSelect,
    mode = 'directory',
    allowNewLeaf = false,
    disabled = false,
    ariaLabel = 'Browse host folders',
}: {
    readonly value: string;
    readonly onSelect: (path: string) => void;
    readonly mode?: PickerMode;
    readonly allowNewLeaf?: boolean;
    readonly disabled?: boolean;
    readonly ariaLabel?: string;
}) {
    const [open, setOpen] = useState(false);
    const [path, setPath] = useState<string | undefined>();
    const [showHidden, setShowHidden] = useState(false);
    const [leaf, setLeaf] = useState('');
    const directory = useFilesystemDirectory(path, showHidden, open);

    useEffect(() => {
        if (!open) return;
        if (!isAbsoluteHostPath(value)) {
            setPath(undefined);
            setLeaf('');
            return;
        }
        if (allowNewLeaf) {
            const next = splitNewLeaf(value);
            setPath(next.parent);
            setLeaf(next.leaf);
            return;
        }
        setPath(value);
        setLeaf('');
    }, [allowNewLeaf, open, value]);

    const initializePath = () => {
        if (!isAbsoluteHostPath(value)) {
            setPath(undefined);
            setLeaf('');
            return;
        }
        if (allowNewLeaf) {
            const next = splitNewLeaf(value);
            setPath(next.parent);
            setLeaf(next.leaf);
            return;
        }
        setPath(value);
        setLeaf('');
    };

    const selectPath = (selected: string) => {
        onSelect(selected);
        setOpen(false);
    };
    const listing = directory.data;
    const selectedPath =
        listing && allowNewLeaf && leaf.trim() !== ''
            ? appendLeaf(listing.path, leaf.trim())
            : listing?.path;

    return (
        <>
            <Button
                type="button"
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label={ariaLabel}
                title={ariaLabel}
                disabled={disabled}
                onClick={() => {
                    // Set the requested path before mounting the query to avoid an
                    // unnecessary default-Home listing for absolute input values.
                    initializePath();
                    setOpen(true);
                }}
            >
                <FolderOpen className="size-4" aria-hidden="true" />
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="h-[min(680px,calc(100dvh-32px))] w-[min(720px,calc(100vw-24px))] overflow-hidden p-0">
                    <DialogHeader className="shrink-0 border-b px-4 py-3">
                        <DialogTitle>
                            {mode === 'directory'
                                ? 'Choose host folder'
                                : 'Choose host file'}
                        </DialogTitle>
                        <DialogDescription>
                            {mode === 'directory'
                                ? 'Select a folder on the host.'
                                : 'Select a file on the host.'}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
                            <select
                                aria-label="Filesystem root"
                                className="h-8 min-w-0 max-w-48 border bg-background px-2 text-xs"
                                value={
                                    listing?.roots.find(root =>
                                        listing.path.startsWith(root.path),
                                    )?.path ?? ''
                                }
                                onChange={event =>
                                    setPath(event.currentTarget.value)
                                }
                            >
                                {(listing?.roots ?? []).map(root => (
                                    <option key={root.path} value={root.path}>
                                        {root.label}
                                    </option>
                                ))}
                            </select>
                            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                                {listing?.breadcrumbs.map(crumb => (
                                    <Button
                                        key={crumb.path}
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="h-7 shrink-0 px-1.5 text-xs"
                                        onClick={() => setPath(crumb.path)}
                                    >
                                        {crumb.label}
                                    </Button>
                                ))}
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-8 shrink-0"
                                aria-label={
                                    showHidden
                                        ? 'Hide hidden files'
                                        : 'Show hidden files'
                                }
                                onClick={() => setShowHidden(hidden => !hidden)}
                            >
                                {showHidden ? (
                                    <EyeOff className="size-4" />
                                ) : (
                                    <Eye className="size-4" />
                                )}
                            </Button>
                        </div>
                        <div className="min-h-0 flex-1 overflow-auto p-1">
                            {directory.isLoading ? (
                                <p className="text-muted-foreground p-3 text-sm">
                                    Loading folders…
                                </p>
                            ) : null}
                            {directory.isError ? (
                                <p
                                    role="alert"
                                    className="text-destructive p-3 text-sm"
                                >
                                    {errorMessage(directory.error)}
                                </p>
                            ) : null}
                            {listing?.parent ? (
                                <DirectoryRow
                                    icon={<ArrowUp className="size-4" />}
                                    label="Parent folder"
                                    onClick={() =>
                                        setPath(listing.parent ?? undefined)
                                    }
                                />
                            ) : null}
                            {listing?.entries.map(entry => {
                                const canOpen = entry.navigable;
                                const chooseFile =
                                    mode === 'file' && entry.kind === 'file';
                                const target = appendLeaf(
                                    listing.path,
                                    entry.name,
                                );
                                return (
                                    <DirectoryRow
                                        key={entry.name}
                                        icon={
                                            entry.kind === 'symlink' ? (
                                                <Link className="size-4" />
                                            ) : entry.isRepository ? (
                                                <FolderGit2 className="size-4" />
                                            ) : entry.kind === 'file' ? (
                                                <File className="size-4" />
                                            ) : (
                                                <Folder className="size-4" />
                                            )
                                        }
                                        label={entry.name}
                                        detail={
                                            entry.isRepository
                                                ? 'Repository'
                                                : entry.kind === 'symlink' &&
                                                    !entry.navigable
                                                  ? 'Unavailable link'
                                                  : undefined
                                        }
                                        disabled={!canOpen && !chooseFile}
                                        onClick={() => {
                                            if (canOpen) setPath(target);
                                            else if (chooseFile)
                                                selectPath(target);
                                        }}
                                    />
                                );
                            })}
                            {listing?.truncated ? (
                                <p className="text-muted-foreground px-3 py-2 text-xs">
                                    Showing the first 500 entries.
                                </p>
                            ) : null}
                        </div>
                        {allowNewLeaf ? (
                            <div className="shrink-0 border-t p-3">
                                <label className="grid gap-1 text-xs">
                                    New folder name
                                    <Input
                                        value={leaf}
                                        onChange={event =>
                                            setLeaf(event.target.value)
                                        }
                                        placeholder="new-folder"
                                    />
                                </label>
                            </div>
                        ) : null}
                    </div>
                    <DialogFooter className="shrink-0 flex-row items-center justify-between border-t px-4 py-3">
                        <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
                            {selectedPath ?? 'Choose a host folder'}
                        </span>
                        <div className="flex shrink-0 gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setOpen(false)}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                disabled={!selectedPath}
                                onClick={() => {
                                    if (selectedPath) selectPath(selectedPath);
                                }}
                            >
                                <Check className="size-3.5" />
                                Use folder
                            </Button>
                        </div>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

function DirectoryRow({
    icon,
    label,
    detail,
    disabled = false,
    onClick,
}: {
    readonly icon: ReactNode;
    readonly label: string;
    readonly detail?: string;
    readonly disabled?: boolean;
    readonly onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                disabled
                    ? 'text-muted-foreground cursor-not-allowed opacity-60'
                    : 'hover:bg-accent',
            )}
        >
            <span className="text-muted-foreground shrink-0">{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {detail ? (
                <span className="text-muted-foreground shrink-0 text-xs">
                    {detail}
                </span>
            ) : null}
        </button>
    );
}
