import {
    type Engagement,
    type RecentRepo,
    type RepoId,
} from '@cbranch/rpc-contract';
import {
    FolderInput,
    FolderPlus,
    GitBranch,
    LayoutDashboard,
    X,
} from 'lucide-react';
import { type MouseEvent, useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import {
    useActivateEngagement,
    useEngagementWorkspace,
    useSetEngagementSession,
    useStatus,
} from '../rpc/hooks';
import { useInvalidationBus } from '../rpc/use-invalidation-bus';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import { WorkspaceAvatar } from './WorkspaceAvatar';
import { WorkspaceDirectoryImportDialog } from './WorkspaceDirectoryImportDialog';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from './ui/tooltip';

function RepoTab({
    repo,
    active,
    onOpen,
    onClose,
}: {
    readonly repo: RecentRepo;
    readonly active: boolean;
    readonly onOpen: () => void;
    readonly onClose: (event: MouseEvent) => void;
}) {
    const status = useStatus(repo.repoId);
    useInvalidationBus(active ? null : repo.repoId);
    const dirty = (status.data?.entries.length ?? 0) > 0;
    const conflicted = status.data?.hasConflicts ?? false;

    return (
        <div
            className={cn(
                'group flex h-8 min-w-28 max-w-52 shrink-0 items-stretch border-r text-xs',
                active
                    ? 'bg-background text-foreground'
                    : 'bg-muted/60 text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
            title={repo.path}
        >
            <button
                type="button"
                onClick={onOpen}
                className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
                <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{repo.name}</span>
                {dirty ? (
                    <span
                        className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            conflicted
                                ? 'bg-destructive'
                                : 'bg-status-unstaged',
                        )}
                        aria-label={
                            conflicted ? 'Conflicts' : 'Uncommitted changes'
                        }
                    />
                ) : null}
            </button>
            <button
                type="button"
                aria-label={`Close ${repo.name}`}
                onClick={onClose}
                className="grid w-7 shrink-0 place-items-center opacity-0 outline-none hover:bg-accent focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-hover:opacity-100"
            >
                <X className="size-3" aria-hidden="true" />
            </button>
        </div>
    );
}

const orderedOpenRepos = (
    engagement: Engagement,
): ReadonlyArray<RecentRepo> => {
    const byId = new Map(
        engagement.repositories.map(repo => [repo.repoId, repo] as const),
    );
    return engagement.openRepoIds.flatMap(repoId => {
        const repo = byId.get(repoId);
        return repo ? [repo] : [];
    });
};

export function WorkspaceBar() {
    const workspace = useEngagementWorkspace();
    const activeEngagementId = useUiStore(s => s.activeEngagementId);
    const activeRepoId = useUiStore(s => s.activeRepoId);
    const openSwitcher = useUiStore(s => s.setRepoSwitcherOpen);
    const openManager = useUiStore(s => s.setEngagementManagerOpen);
    const [directoryImportOpen, setDirectoryImportOpen] = useState(false);
    const session = useSetEngagementSession();
    const activateEngagement = useActivateEngagement();
    const { openEngagement, openRepo } = useNavigation();
    const engagement = workspace.data?.engagements.find(
        item => item.id === activeEngagementId,
    );
    const openRepos = engagement ? orderedOpenRepos(engagement) : [];

    // A direct/deep workspace route is still a real workspace activation and must be
    // restored on the next launch, not only reflected in this browser tab.
    useEffect(() => {
        if (
            !engagement ||
            workspace.data?.activeEngagementId === engagement.id ||
            activateEngagement.isPending
        )
            return;
        activateEngagement.mutate(engagement.id);
    }, [activateEngagement, engagement, workspace.data?.activeEngagementId]);

    // A direct workspace/repo deep link is also an explicit request to keep that repo open.
    useEffect(() => {
        if (
            !engagement ||
            !activeRepoId ||
            !engagement.repositories.some(
                repo => repo.repoId === activeRepoId,
            ) ||
            session.isPending
        )
            return;
        const alreadyOpen = engagement.openRepoIds.includes(activeRepoId);
        if (alreadyOpen && engagement.activeRepoId === activeRepoId) return;
        session.mutate({
            engagementId: engagement.id,
            openRepoIds: alreadyOpen
                ? engagement.openRepoIds
                : [...engagement.openRepoIds, activeRepoId],
            activeRepoId,
        });
    }, [activeRepoId, engagement, session]);

    if (!engagement) {
        return (
            <div className="bg-muted/60 flex h-8 shrink-0 items-center border-b px-2">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    onClick={() => openManager(true)}
                >
                    Create workspace
                </Button>
                {activeRepoId ? (
                    <span className="text-muted-foreground ml-2 text-xs">
                        Unassigned repository
                    </span>
                ) : null}
            </div>
        );
    }

    const setActiveRepo = (repoId: RepoId) => {
        session.mutate({
            engagementId: engagement.id,
            openRepoIds: engagement.openRepoIds,
            activeRepoId: repoId,
        });
        openRepo(repoId, engagement.slug);
    };

    const closeRepo = (repoId: RepoId) => (event: MouseEvent) => {
        event.stopPropagation();
        const nextOpen = engagement.openRepoIds.filter(id => id !== repoId);
        const nextActive =
            engagement.activeRepoId === repoId
                ? nextOpen.at(-1)
                : engagement.activeRepoId;
        session.mutate({
            engagementId: engagement.id,
            openRepoIds: nextOpen,
            activeRepoId: nextActive,
        });
        if (activeRepoId === repoId) {
            if (nextActive) openRepo(nextActive, engagement.slug);
            else openEngagement(engagement.slug);
        }
    };

    return (
        <TooltipProvider>
            <div className="bg-muted/60 flex h-8 min-w-0 shrink-0 items-stretch border-b">
                <button
                    type="button"
                    onClick={() => openEngagement(engagement.slug)}
                    className={cn(
                        'flex w-44 shrink-0 items-center gap-2 border-r px-2 text-left text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
                        activeRepoId === null
                            ? 'bg-background'
                            : 'hover:bg-accent/60',
                    )}
                >
                    <WorkspaceAvatar
                        name={engagement.name}
                        color={engagement.color}
                        avatarUrl={engagement.avatarUrl}
                        className="size-4 text-[6px] font-semibold"
                    />
                    <span className="truncate">{engagement.name}</span>
                    <LayoutDashboard
                        className="ml-auto size-3.5 shrink-0"
                        aria-hidden="true"
                    />
                </button>
                <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
                    {openRepos.map(repo => (
                        <RepoTab
                            key={repo.repoId}
                            repo={repo}
                            active={repo.repoId === activeRepoId}
                            onOpen={() => setActiveRepo(repo.repoId)}
                            onClose={closeRepo(repo.repoId)}
                        />
                    ))}
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 shrink-0"
                                    aria-label="Add repository to workspace"
                                    onClick={() => openSwitcher(true)}
                                >
                                    <FolderPlus
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                </Button>
                            }
                        />
                        <TooltipContent>Add repository</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-8 shrink-0"
                                    aria-label="Import repositories from folder"
                                    onClick={() => setDirectoryImportOpen(true)}
                                >
                                    <FolderInput
                                        className="size-4"
                                        aria-hidden="true"
                                    />
                                </Button>
                            }
                        />
                        <TooltipContent>
                            Import repositories from folder
                        </TooltipContent>
                    </Tooltip>
                </div>
            </div>
            <WorkspaceDirectoryImportDialog
                open={directoryImportOpen}
                onOpenChange={setDirectoryImportOpen}
                target={{ kind: 'existing', engagementId: engagement.id }}
            />
        </TooltipProvider>
    );
}
