// New-repository dialog (docs/spec/17 REQ-P6-INIT-001..005). Collects a destination path,
// an optional initial branch name, and a bare checkbox, then calls repo.init and switches
// the app to the freshly created repository. If the destination already contains a
// repository, init fails with `repoExists` and this dialog offers to OPEN it instead of
// reinitializing (REQ-P6-INIT-003). `git clone` remains out of scope.

import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';

import {
    useAssignEngagementRepo,
    useInitRepo,
    useOpenRepo,
} from '../rpc/hooks';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';
import { FilesystemPickerButton } from './FilesystemPicker';

const errorCode = (error: unknown): string | undefined =>
    error != null && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : undefined;

const errorMessage = (error: unknown): string =>
    error != null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : 'Could not create the repository.';

export function NewRepoDialog() {
    const open = useUiStore(s => s.newRepoDialogOpen);
    if (!open) return null;
    return <NewRepoDialogBody />;
}

function NewRepoDialogBody() {
    const setOpen = useUiStore(s => s.setNewRepoDialogOpen);
    const engagementId = useUiStore(s => s.activeEngagementId);
    const { openRepo } = useNavigation();
    const initRepo = useInitRepo();
    const openRepoMutation = useOpenRepo();
    const assignRepo = useAssignEngagementRepo();

    const [path, setPath] = useState('');
    const [branch, setBranch] = useState('');
    const [bare, setBare] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // When init reports an existing repository, offer to open it instead.
    const [existing, setExisting] = useState(false);

    const busy =
        initRepo.isPending ||
        openRepoMutation.isPending ||
        assignRepo.isPending;
    const trimmedPath = path.trim();

    const finishOpen = (repoId: Parameters<typeof openRepo>[0]) => {
        if (!engagementId) {
            openRepo(repoId);
            setOpen(false);
            return;
        }
        assignRepo.mutate(
            { engagementId, repoId },
            {
                onSuccess: next => {
                    const engagement = next.engagements.find(
                        item => item.id === engagementId,
                    );
                    openRepo(repoId, engagement?.slug);
                    setOpen(false);
                },
                onError: e => setError(errorMessage(e)),
            },
        );
    };

    const close = () => {
        if (!busy) setOpen(false);
    };

    const openExisting = () =>
        openRepoMutation.mutate(trimmedPath, {
            onSuccess: handle => {
                finishOpen(handle.repoId);
            },
            onError: e => setError(errorMessage(e)),
        });

    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (trimmedPath === '' || busy) return;
        setError(null);
        setExisting(false);
        initRepo.mutate(
            {
                path: trimmedPath,
                defaultBranch: branch.trim() === '' ? undefined : branch.trim(),
                bare,
            },
            {
                onSuccess: result => {
                    toast.success('Repository created.');
                    finishOpen(result.repoId);
                },
                onError: err => {
                    if (errorCode(err) === 'repoExists') {
                        setExisting(true);
                        setError(
                            'A repository already exists at that path. Open it instead?',
                        );
                    } else {
                        setError(errorMessage(err));
                    }
                },
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
            <DialogContent style={{ width: 'min(520px, 92vw)' }}>
                <form onSubmit={submit} className="flex flex-col gap-3 p-4">
                    <DialogTitle>New repository</DialogTitle>
                    <DialogDescription>
                        Initialize a new Git repository on the host at a
                        destination path, then open it. Cloning is not
                        supported.
                    </DialogDescription>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Destination path</span>
                        <div className="flex gap-2">
                            <Input
                                autoFocus
                                aria-label="Destination path"
                                value={path}
                                onChange={e => {
                                    setPath(e.target.value);
                                    setError(null);
                                    setExisting(false);
                                }}
                                placeholder="/absolute/path/to/new-repo"
                                disabled={busy}
                            />
                            <FilesystemPickerButton
                                value={path}
                                onSelect={selected => {
                                    setPath(selected);
                                    setError(null);
                                    setExisting(false);
                                }}
                                allowNewLeaf
                                disabled={busy}
                                ariaLabel="Browse host folders for repository destination"
                            />
                        </div>
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">
                            Initial branch (optional)
                        </span>
                        <Input
                            aria-label="Initial branch"
                            value={branch}
                            onChange={e => setBranch(e.target.value)}
                            placeholder="defaults to git's init.defaultBranch"
                            disabled={busy}
                        />
                    </label>

                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            aria-label="Bare repository"
                            checked={bare}
                            onCheckedChange={c => setBare(c === true)}
                            disabled={busy}
                        />
                        Bare repository (no working tree)
                    </label>

                    {error !== null && (
                        <p role="alert" className="text-destructive text-xs">
                            {error}
                        </p>
                    )}

                    <div className="flex justify-end gap-2 pt-1">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={close}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        {existing ? (
                            <Button
                                type="button"
                                size="sm"
                                onClick={openExisting}
                                disabled={busy}
                            >
                                {openRepoMutation.isPending
                                    ? 'Opening…'
                                    : 'Open existing'}
                            </Button>
                        ) : (
                            <Button
                                type="submit"
                                size="sm"
                                disabled={trimmedPath === '' || busy}
                            >
                                {initRepo.isPending ? 'Creating…' : 'Create'}
                            </Button>
                        )}
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
