import { type RepoId } from '@cbranch/rpc-contract';
import { Command } from 'cmdk';
import {
    BriefcaseBusiness,
    FolderGit2,
    LoaderCircle,
    Plus,
} from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { toast } from 'sonner';

import {
    useAssignEngagementRepo,
    useEngagementWorkspace,
    useOpenRepo,
    useRecentList,
    useSetEngagementSession,
} from '../rpc/hooks';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { useMenuActions } from './menu/use-menu-actions';
import { FilesystemPickerButton } from './FilesystemPicker';

// Repo open / switcher (P1-UI-OPEN-1/4): fuzzy-match recent repositories or type an
// absolute path to open. A custom overlay hosts the cmdk menu (keyboard nav + filtering)
// so styling/focus stay under our control. Open failures keep the switcher open (P1-UI-OPEN-4).
// Kept as its own surface — separate from the run-a-command <CommandPalette> — so the long
// commands list doesn't bury the recent-repos list when the user just wants to switch repos.
const looksLikePath = (value: string): boolean =>
    value.startsWith('/') || (value.length > 2 && value[1] === ':');

export function RepoSwitcher() {
    const open = useUiStore(s => s.repoSwitcherOpen);
    const setOpen = useUiStore(s => s.setRepoSwitcherOpen);
    const activeEngagementId = useUiStore(s => s.activeEngagementId);
    const { openRepo } = useNavigation();
    const recent = useRecentList();
    const workspace = useEngagementWorkspace();
    const openRepoMutation = useOpenRepo();
    const assignRepo = useAssignEngagementRepo();
    const setSession = useSetEngagementSession();
    const menuActions = useMenuActions();
    const [query, setQuery] = useState('');
    const [pendingLabel, setPendingLabel] = useState<string>();

    if (!open) return null;

    const finish = () => {
        setPendingLabel(undefined);
        setOpen(false);
        setQuery('');
    };
    const reportError = (error: unknown) => {
        setPendingLabel(undefined);
        toast.error(
            typeof error === 'object' && error !== null && 'message' in error
                ? String(error.message)
                : 'Could not update the workspace.',
        );
    };

    const routeRepo = (repoId: RepoId) => {
        const owner = workspace.data?.engagements.find(engagement =>
            engagement.repositories.some(repo => repo.repoId === repoId),
        );
        if (owner) {
            setPendingLabel(`Opening ${owner.name}…`);
            const openRepoIds = owner.openRepoIds.includes(repoId)
                ? owner.openRepoIds
                : [...owner.openRepoIds, repoId];
            setSession.mutate(
                {
                    engagementId: owner.id,
                    openRepoIds,
                    activeRepoId: repoId,
                },
                {
                    onSuccess: () => {
                        openRepo(repoId, owner.slug);
                        finish();
                    },
                    onError: reportError,
                },
            );
            return;
        }
        if (activeEngagementId) {
            setPendingLabel('Adding to workspace…');
            assignRepo.mutate(
                { engagementId: activeEngagementId, repoId },
                {
                    onSuccess: next => {
                        const assignedEngagement = next.engagements.find(
                            engagement => engagement.id === activeEngagementId,
                        );
                        openRepo(repoId, assignedEngagement?.slug);
                        finish();
                    },
                    onError: reportError,
                },
            );
            return;
        }
        openRepo(repoId);
        finish();
    };

    const activate = (path: string) => {
        if (pendingLabel) return;
        setPendingLabel('Opening repository…');
        openRepoMutation.mutate(path, {
            onSuccess: handle => {
                routeRepo(handle.repoId);
            },
            onError: error => {
                setPendingLabel(undefined);
                toast.error(
                    typeof error === 'object' &&
                        error !== null &&
                        'message' in error
                        ? String(error.message)
                        : 'Could not open this repository.',
                );
            },
        });
    };

    const term = query.trim().toLowerCase();
    const matches = (recent.data ?? []).filter(
        r =>
            term === '' ||
            r.name.toLowerCase().includes(term) ||
            r.path.toLowerCase().includes(term),
    );
    const ownerByRepo = new Map(
        (workspace.data?.engagements ?? []).flatMap(engagement =>
            engagement.repositories.map(
                repo => [repo.repoId, engagement] as const,
            ),
        ),
    );
    const currentMatches = matches.filter(
        repo => ownerByRepo.get(repo.repoId)?.id === activeEngagementId,
    );
    const unassignedMatches = matches.filter(
        repo => !ownerByRepo.has(repo.repoId),
    );
    const otherGroups = (workspace.data?.engagements ?? [])
        .filter(engagement => engagement.id !== activeEngagementId)
        .map(engagement => ({
            engagement,
            repos: matches.filter(
                repo => ownerByRepo.get(repo.repoId)?.id === engagement.id,
            ),
        }))
        .filter(group => group.repos.length > 0);

    const runCommand = (id: string) => {
        if (pendingLabel) return;
        menuActions.run(id);
        setOpen(false);
        setQuery('');
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && !pendingLabel) setOpen(false);
    };

    return (
        <div
            className="fixed inset-0 z-50 bg-black/40"
            onClick={() => {
                if (!pendingLabel) setOpen(false);
            }}
        >
            <div
                className="bg-popover text-popover-foreground mx-auto mt-[15vh] w-[min(640px,90vw)] overflow-hidden border shadow-lg"
                onClick={event => event.stopPropagation()}
                onKeyDown={onKeyDown}
            >
                <Command
                    shouldFilter={false}
                    label="Open or switch repository"
                    aria-busy={pendingLabel !== undefined}
                >
                    <div className="flex items-center border-b px-2">
                        <Command.Input
                            autoFocus
                            value={query}
                            onValueChange={setQuery}
                            disabled={pendingLabel !== undefined}
                            placeholder="Search recent repositories or type an absolute path…"
                            className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent px-1 py-2.5 text-sm outline-none"
                        />
                        <FilesystemPickerButton
                            value={query}
                            onSelect={setQuery}
                            disabled={pendingLabel !== undefined}
                            ariaLabel="Browse host folders to open a repository"
                        />
                    </div>
                    <Command.List className="max-h-80 overflow-auto p-1">
                        {pendingLabel ? (
                            <div
                                role="status"
                                className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs"
                            >
                                <LoaderCircle className="size-3.5 animate-spin" />
                                {pendingLabel}
                            </div>
                        ) : null}
                        {openRepoMutation.isError ? (
                            <div className="text-destructive px-3 py-2 text-xs">
                                Could not open that path.
                            </div>
                        ) : null}
                        {/* New repository is available even with no repo open (REQ-P6-INIT-001). */}
                        {term === '' ||
                        'new repository'.includes(term) ||
                        'init'.includes(term) ? (
                            <Command.Item
                                value="command:repository.new"
                                disabled={pendingLabel !== undefined}
                                onSelect={() => runCommand('repository.new')}
                                className="data-[selected=true]:bg-accent flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
                            >
                                <Plus className="size-4" aria-hidden="true" />
                                New repository…
                            </Command.Item>
                        ) : null}
                        {looksLikePath(query) ? (
                            <Command.Item
                                value="open-path"
                                disabled={pendingLabel !== undefined}
                                onSelect={() => activate(query.trim())}
                                className="data-[selected=true]:bg-accent flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
                            >
                                Open path:{' '}
                                <span className="font-mono text-xs">
                                    {query.trim()}
                                </span>
                            </Command.Item>
                        ) : null}
                        {matches.length === 0 && !looksLikePath(query) ? (
                            <div className="text-muted-foreground px-3 py-2 text-xs">
                                No recent repositories.
                            </div>
                        ) : null}
                        {currentMatches.length > 0 ? (
                            <Command.Group
                                heading="Current workspace"
                                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground"
                            >
                                {currentMatches.map(repo => (
                                    <RepoItem
                                        key={repo.repoId}
                                        repo={repo}
                                        onSelect={() => activate(repo.path)}
                                        disabled={pendingLabel !== undefined}
                                    />
                                ))}
                            </Command.Group>
                        ) : null}
                        {unassignedMatches.length > 0 ? (
                            <Command.Group
                                heading={
                                    activeEngagementId
                                        ? 'Unassigned · add to current workspace'
                                        : 'Unassigned repositories'
                                }
                                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground"
                            >
                                {unassignedMatches.map(repo => (
                                    <RepoItem
                                        key={repo.repoId}
                                        repo={repo}
                                        onSelect={() => activate(repo.path)}
                                        disabled={pendingLabel !== undefined}
                                    />
                                ))}
                            </Command.Group>
                        ) : null}
                        {otherGroups.map(({ engagement, repos }) => (
                            <Command.Group
                                key={engagement.id}
                                heading={engagement.name}
                                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-muted-foreground"
                            >
                                {repos.map(repo => (
                                    <RepoItem
                                        key={repo.repoId}
                                        repo={repo}
                                        onSelect={() => activate(repo.path)}
                                        engagement
                                        disabled={pendingLabel !== undefined}
                                    />
                                ))}
                            </Command.Group>
                        ))}
                    </Command.List>
                </Command>
            </div>
        </div>
    );
}

function RepoItem({
    repo,
    onSelect,
    engagement = false,
    disabled = false,
}: {
    readonly repo: {
        readonly repoId: string;
        readonly name: string;
        readonly path: string;
    };
    readonly onSelect: () => void;
    readonly engagement?: boolean;
    readonly disabled?: boolean;
}) {
    const Icon = engagement ? BriefcaseBusiness : FolderGit2;
    return (
        <Command.Item
            value={repo.repoId}
            onSelect={onSelect}
            disabled={disabled}
            className="data-[selected=true]:bg-accent data-[disabled=true]:cursor-wait data-[disabled=true]:opacity-60 flex cursor-pointer items-center gap-2 px-3 py-2"
        >
            <Icon
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden="true"
            />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                    {repo.name}
                </span>
                <span className="text-muted-foreground block truncate text-xs">
                    {repo.path}
                </span>
            </span>
        </Command.Item>
    );
}
