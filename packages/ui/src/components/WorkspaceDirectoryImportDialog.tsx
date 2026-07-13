import {
    type EngagementColor,
    type EngagementDirectoryCandidate,
    type EngagementDirectoryImportTarget,
    type EngagementId,
} from '@cbranch/rpc-contract';
import { FolderInput, FolderOpen, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
    useEngagementDirectoryPreview,
    useEngagementWorkspace,
    useImportEngagementDirectory,
} from '../rpc/hooks';
import { useNavigation } from '../state/navigation';
import { FilesystemPickerButton } from './FilesystemPicker';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

type ImportTarget =
    | { readonly kind: 'existing'; readonly engagementId: EngagementId }
    | { readonly kind: 'new' };

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);

const nameFromPath = (path: string): string =>
    path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1) ?? '';

export function WorkspaceDirectoryImportDialog({
    open,
    onOpenChange,
    target,
}: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly target: ImportTarget;
}) {
    const [path, setPath] = useState('');
    const [name, setName] = useState('');
    const [nameEdited, setNameEdited] = useState(false);
    const [selectedRoots, setSelectedRoots] = useState<ReadonlySet<string>>(
        new Set(),
    );
    const workspace = useEngagementWorkspace();
    const preview = useEngagementDirectoryPreview(path, open);
    const importDirectory = useImportEngagementDirectory();
    const { openEngagement } = useNavigation();

    const targetWorkspace =
        target.kind === 'existing'
            ? workspace.data?.engagements.find(
                  engagement => engagement.id === target.engagementId,
              )
            : undefined;
    const ownerByRepo = new Map(
        (workspace.data?.engagements ?? []).flatMap(engagement =>
            engagement.repositories.map(
                repo => [repo.repoId, engagement] as const,
            ),
        ),
    );

    useEffect(() => {
        if (!open) return;
        setPath('');
        setName('');
        setNameEdited(false);
        setSelectedRoots(new Set());
    }, [
        open,
        target.kind,
        target.kind === 'existing' ? target.engagementId : '',
    ]);

    useEffect(() => {
        if (!preview.data) return;
        setSelectedRoots(
            new Set(
                preview.data.candidates
                    .filter(candidate => !ownerByRepo.has(candidate.repoId))
                    .map(candidate => candidate.root),
            ),
        );
    }, [preview.data, workspace.data]);

    const selectPath = (nextPath: string) => {
        setPath(nextPath);
        setSelectedRoots(new Set());
        if (!nameEdited) setName(nameFromPath(nextPath));
    };
    const toggleCandidate = (candidate: EngagementDirectoryCandidate) => {
        if (ownerByRepo.has(candidate.repoId)) return;
        setSelectedRoots(current => {
            const next = new Set(current);
            if (next.has(candidate.root)) next.delete(candidate.root);
            else next.add(candidate.root);
            return next;
        });
    };
    const selectedCount = [...selectedRoots].length;
    const importTarget: EngagementDirectoryImportTarget =
        target.kind === 'existing'
            ? target
            : {
                  kind: 'new',
                  name: name.trim(),
                  color: 'teal' as EngagementColor,
              };
    const canImport =
        selectedCount > 0 &&
        path.trim() !== '' &&
        (target.kind === 'existing' || name.trim() !== '');

    const importSelected = () => {
        if (!canImport) return;
        importDirectory.mutate(
            {
                path,
                candidateRoots: [...selectedRoots],
                target: importTarget,
            },
            {
                onSuccess: next => {
                    const imported = next.engagements.find(
                        engagement => engagement.id === next.activeEngagementId,
                    );
                    if (imported) openEngagement(imported.slug);
                    onOpenChange(false);
                },
                onError: error => toast.error(errorMessage(error)),
            },
        );
    };

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                if (!importDirectory.isPending) onOpenChange(next);
            }}
        >
            <DialogContent className="flex h-[min(620px,calc(100dvh-32px))] w-[min(720px,calc(100vw-24px))] flex-col overflow-hidden p-0">
                <DialogHeader className="shrink-0 border-b px-4 py-3">
                    <DialogTitle>
                        {target.kind === 'existing'
                            ? `Import repositories into ${targetWorkspace?.name ?? 'workspace'}`
                            : 'Import workspace from folder'}
                    </DialogTitle>
                    <DialogDescription>
                        Choose a host folder, then select its immediate
                        repository subfolders. Hidden folders and symlinks are
                        excluded.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="grid shrink-0 gap-3 border-b p-4">
                        {target.kind === 'new' ? (
                            <label className="grid gap-1 text-xs">
                                Workspace name
                                <Input
                                    value={name}
                                    onChange={event => {
                                        setName(event.target.value);
                                        setNameEdited(true);
                                    }}
                                    placeholder="Workspace name"
                                />
                            </label>
                        ) : null}
                        <label className="grid gap-1 text-xs">
                            Host folder
                            <div className="flex gap-2">
                                <Input
                                    value={path}
                                    onChange={event =>
                                        selectPath(event.target.value)
                                    }
                                    placeholder="/home/user/workspace"
                                    spellCheck={false}
                                />
                                <FilesystemPickerButton
                                    value={path}
                                    onSelect={selectPath}
                                    ariaLabel="Browse host folders to import repositories"
                                />
                            </div>
                        </label>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                        {preview.isLoading ? (
                            <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
                                <LoaderCircle className="size-4 animate-spin" />
                                Scanning immediate subfolders…
                            </p>
                        ) : null}
                        {preview.isError ? (
                            <p
                                role="alert"
                                className="text-destructive p-4 text-sm"
                            >
                                {errorMessage(preview.error)}
                            </p>
                        ) : null}
                        {preview.data?.candidates.map(candidate => {
                            const owner = ownerByRepo.get(candidate.repoId);
                            const unavailable = owner !== undefined;
                            const detail = owner
                                ? owner.id === targetWorkspace?.id
                                    ? 'Already in this workspace'
                                    : `Already in ${owner.name}`
                                : candidate.root;
                            return (
                                <label
                                    key={candidate.root}
                                    className="flex cursor-pointer items-center gap-3 border-b px-4 py-3 has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60"
                                >
                                    <Checkbox
                                        checked={selectedRoots.has(
                                            candidate.root,
                                        )}
                                        disabled={unavailable}
                                        onCheckedChange={() =>
                                            toggleCandidate(candidate)
                                        }
                                        aria-label={`Import ${candidate.name}`}
                                    />
                                    <FolderInput className="text-muted-foreground size-4 shrink-0" />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-medium">
                                            {candidate.name}
                                        </span>
                                        <span className="text-muted-foreground block truncate font-mono text-[11px]">
                                            {detail}
                                        </span>
                                    </span>
                                </label>
                            );
                        })}
                        {preview.data &&
                        preview.data.candidates.length === 0 ? (
                            <p className="text-muted-foreground p-4 text-sm">
                                No repositories were found directly in this
                                folder.
                            </p>
                        ) : null}
                        {preview.data?.truncated ? (
                            <p className="text-muted-foreground border-t px-4 py-2 text-xs">
                                Showing the first 200 repository folders.
                            </p>
                        ) : null}
                    </div>
                </div>
                <DialogFooter className="shrink-0 flex-row items-center justify-between border-t px-4 py-3">
                    <span className="text-muted-foreground text-xs">
                        {selectedCount} selected
                    </span>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={importDirectory.isPending}
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            disabled={!canImport || importDirectory.isPending}
                            onClick={importSelected}
                        >
                            <FolderOpen className="size-3.5" />
                            Import {selectedCount || ''} repositories
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
