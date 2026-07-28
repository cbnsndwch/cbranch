import {
    type Engagement,
    type RecentRepo,
    type RepoId,
} from '@cbranch/rpc-contract';
import {
    CircleCheck,
    CircleX,
    FolderGit2,
    FolderPlus,
    GitBranchPlus,
    Loader2,
    RefreshCw,
    Square,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { cn } from '../lib/cn';
import {
    useEngagementWorkspace,
    useRepoState,
    useSetEngagementSession,
    useStatus,
} from '../rpc/hooks';
import { useApi } from '../rpc/ApiProvider';
import { useInvalidationBus } from '../rpc/use-invalidation-bus';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { Badge } from './ui/badge';
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
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from './ui/table';
import { EngagementPullRequests } from './EngagementPullRequests';
import { EngagementBranchMatrix } from './EngagementBranchMatrix';
import { EngagementChangeSets } from './EngagementChangeSets';
import { WorkspaceIntelligencePanel } from './WorkspaceIntelligencePanel';

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);

interface FetchOutcome {
    readonly repoId: RepoId;
    readonly name: string;
    readonly status: 'pending' | 'success' | 'failed' | 'cancelled';
    readonly message?: string;
}

interface ActiveFetch {
    readonly unsubscribe: () => void;
    readonly cancel: () => void;
}

const noop = (): void => undefined;

function RepoSummaryRow({
    engagement,
    repo,
    selected,
    onSelectedChange,
}: {
    readonly engagement: Engagement;
    readonly repo: RecentRepo;
    readonly selected: boolean;
    readonly onSelectedChange: (selected: boolean) => void;
}) {
    const state = useRepoState(repo.repoId);
    const status = useStatus(repo.repoId);
    useInvalidationBus(repo.repoId);
    const session = useSetEngagementSession();
    const { openRepo } = useNavigation();
    const entries = status.data?.entries ?? [];
    const staged = entries.filter(
        entry => entry.staged !== 'unmodified',
    ).length;
    const unstaged = entries.filter(
        entry => entry.unstaged !== 'unmodified' || entry.isUntracked,
    ).length;
    const branch = status.data?.branch;

    const activate = () => {
        const openRepoIds = engagement.openRepoIds.includes(repo.repoId)
            ? engagement.openRepoIds
            : [...engagement.openRepoIds, repo.repoId];
        session.mutate({
            engagementId: engagement.id,
            openRepoIds,
            activeRepoId: repo.repoId,
        });
        openRepo(repo.repoId, engagement.slug);
    };

    return (
        <TableRow data-state={selected ? 'selected' : undefined}>
            <TableCell className="w-10">
                <Checkbox
                    checked={selected}
                    onCheckedChange={onSelectedChange}
                    aria-label={`Select ${repo.name}`}
                />
            </TableCell>
            <TableCell>
                <button
                    type="button"
                    onClick={activate}
                    className="flex min-w-0 items-center gap-2 text-left hover:underline"
                >
                    <FolderGit2
                        className="text-muted-foreground size-4 shrink-0"
                        aria-hidden="true"
                    />
                    <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">
                            {repo.name}
                        </span>
                        <span className="text-muted-foreground block max-w-96 truncate font-mono text-[11px]">
                            {repo.path}
                        </span>
                    </span>
                </button>
            </TableCell>
            <TableCell>
                {state.isLoading ? (
                    <span className="text-muted-foreground">Loading...</span>
                ) : state.isError ? (
                    <Badge tone="danger">Unavailable</Badge>
                ) : state.data?.isDetached ? (
                    <Badge tone="warn">Detached</Badge>
                ) : (
                    <span className="font-mono text-xs">
                        {state.data?.currentBranch ?? '(unborn)'}
                    </span>
                )}
            </TableCell>
            <TableCell>
                {status.isLoading ? (
                    <span className="text-muted-foreground">Loading...</span>
                ) : status.data?.hasConflicts ? (
                    <Badge tone="danger">Conflicts</Badge>
                ) : staged + unstaged === 0 ? (
                    <Badge tone="muted">Clean</Badge>
                ) : (
                    <div className="flex items-center gap-1">
                        {staged > 0 ? <Badge>{staged} staged</Badge> : null}
                        {unstaged > 0 ? (
                            <Badge tone="warn">{unstaged} changed</Badge>
                        ) : null}
                    </div>
                )}
            </TableCell>
            <TableCell>
                {branch?.upstream ? (
                    <span className="font-mono text-xs">{branch.upstream}</span>
                ) : (
                    <span className="text-muted-foreground">No upstream</span>
                )}
            </TableCell>
            <TableCell className="w-36">
                <div className="flex gap-1">
                    {(branch?.ahead ?? 0) > 0 ? (
                        <Badge>{branch!.ahead} ahead</Badge>
                    ) : null}
                    {(branch?.behind ?? 0) > 0 ? (
                        <Badge tone="warn">{branch!.behind} behind</Badge>
                    ) : null}
                    {(branch?.ahead ?? 0) === 0 &&
                    (branch?.behind ?? 0) === 0 &&
                    branch?.upstream ? (
                        <span className="text-muted-foreground">
                            Up to date
                        </span>
                    ) : null}
                </div>
            </TableCell>
        </TableRow>
    );
}

export function EngagementOverview() {
    const activeEngagementId = useUiStore(s => s.activeEngagementId);
    const location = useLocation();
    const navigate = useNavigate();
    const openSwitcher = useUiStore(s => s.setRepoSwitcherOpen);
    const workspace = useEngagementWorkspace();
    const engagement = workspace.data?.engagements.find(
        item => item.id === activeEngagementId,
    );
    const api = useApi();
    const [selected, setSelected] = useState<ReadonlySet<RepoId>>(new Set());
    const [view, setView] = useState<
        | 'repositories'
        | 'branches'
        | 'pullRequests'
        | 'changeSets'
        | 'intelligence'
    >('repositories');
    const [fetching, setFetching] = useState(false);
    const [fetchProgress, setFetchProgress] = useState({ done: 0, total: 0 });
    const [fetchDialogOpen, setFetchDialogOpen] = useState(false);
    const [fetchOutcomes, setFetchOutcomes] = useState<
        ReadonlyArray<FetchOutcome>
    >([]);
    const [branchDialogOpen, setBranchDialogOpen] = useState(false);
    const [branchName, setBranchName] = useState('');
    const [branchErrors, setBranchErrors] = useState<ReadonlyArray<string>>([]);
    const [branchOutcomes, setBranchOutcomes] = useState<
        ReadonlyArray<FetchOutcome>
    >([]);
    const [creatingBranch, setCreatingBranch] = useState(false);
    const activeFetches = useRef<Map<RepoId, ActiveFetch>>(new Map());

    const repoKey = engagement?.repositories.map(repo => repo.repoId).join('|');
    useEffect(() => {
        setSelected(
            new Set(engagement?.repositories.map(repo => repo.repoId) ?? []),
        );
    }, [engagement?.id, repoKey]);

    useEffect(
        () => () => {
            for (const operation of activeFetches.current.values())
                operation.cancel();
        },
        [],
    );

    useEffect(() => {
        if (location.pathname.includes('/intelligence'))
            setView('intelligence');
    }, [location.pathname]);

    if (workspace.isLoading)
        return (
            <div className="grid h-full place-items-center">
                <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
        );
    if (!engagement)
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3">
                <BriefcaseEmpty />
                <p className="text-muted-foreground text-sm">
                    Create a workspace to partition client repositories.
                </p>
                <Button
                    onClick={() =>
                        useUiStore.getState().setEngagementManagerOpen(true)
                    }
                >
                    Create workspace
                </Button>
            </div>
        );

    const selectedRepos = engagement.repositories.filter(repo =>
        selected.has(repo.repoId),
    );

    const toggleAll = (checked: boolean) =>
        setSelected(
            checked
                ? new Set(engagement.repositories.map(repo => repo.repoId))
                : new Set(),
        );

    const fetchRepos = async (targets: ReadonlyArray<RecentRepo>) => {
        if (fetching || targets.length === 0) return;
        setFetching(true);
        setFetchDialogOpen(true);
        setFetchProgress({ done: 0, total: targets.length });
        setFetchOutcomes(current => {
            const byId = new Map(current.map(item => [item.repoId, item]));
            for (const repo of targets)
                byId.set(repo.repoId, {
                    repoId: repo.repoId,
                    name: repo.name,
                    status: 'pending',
                });
            return [...byId.values()];
        });
        let completed = 0;
        const tasks = targets.map(
            repo =>
                new Promise<FetchOutcome>(resolve => {
                    let settled = false;
                    let unsubscribe: () => void = noop;
                    const finish = (
                        status: FetchOutcome['status'],
                        message?: string,
                    ) => {
                        if (settled) return;
                        settled = true;
                        activeFetches.current.delete(repo.repoId);
                        completed += 1;
                        const outcome: FetchOutcome = {
                            repoId: repo.repoId,
                            name: repo.name,
                            status,
                            message,
                        };
                        setFetchOutcomes(current =>
                            current.map(item =>
                                item.repoId === repo.repoId ? outcome : item,
                            ),
                        );
                        setFetchProgress({
                            done: completed,
                            total: targets.length,
                        });
                        resolve(outcome);
                    };
                    unsubscribe = api.fetchStream(
                        repo.repoId,
                        { all: true, prune: true },
                        {
                            onItem: () => undefined,
                            onComplete: () => finish('success'),
                            onError: error =>
                                finish('failed', errorMessage(error)),
                        },
                    );
                    if (!settled)
                        activeFetches.current.set(repo.repoId, {
                            unsubscribe,
                            cancel: () => {
                                unsubscribe();
                                finish('cancelled', 'Cancelled by user');
                            },
                        });
                }),
        );
        const results = await Promise.all(tasks);
        activeFetches.current.clear();
        setFetching(false);
        const failed = results.filter(result => result.status === 'failed');
        const cancelled = results.filter(
            result => result.status === 'cancelled',
        );
        if (failed.length > 0)
            toast.error(
                `Fetched ${results.length - failed.length}; ${failed.length} failed`,
            );
        else if (cancelled.length > 0)
            toast.info(`Fetch cancelled in ${cancelled.length} repositories`);
        else toast.success(`Fetched ${results.length} repositories`);
    };

    const fetchSelected = () => fetchRepos(selectedRepos);

    const cancelFetch = () => {
        for (const operation of activeFetches.current.values())
            operation.cancel();
    };

    const failedFetchRepos = fetchOutcomes.flatMap(outcome => {
        if (outcome.status !== 'failed') return [];
        const repo = engagement.repositories.find(
            item => item.repoId === outcome.repoId,
        );
        return repo ? [repo] : [];
    });

    const createBranchAcrossRepos = async (
        targets: ReadonlyArray<RecentRepo>,
    ) => {
        const name = branchName.trim();
        if (name === '' || creatingBranch || targets.length === 0) return;
        setCreatingBranch(true);
        setBranchErrors([]);
        const results = await Promise.allSettled(
            targets.map(repo =>
                api
                    .branchCreate(repo.repoId, name, undefined, false, true)
                    .then(() => repo),
            ),
        );
        const errors = results.flatMap((result, index) =>
            result.status === 'rejected'
                ? [
                      `${targets[index]?.name ?? 'Repository'}: ${errorMessage(result.reason)}`,
                  ]
                : [],
        );
        const nextOutcomes = results.map(
            (result, index): FetchOutcome => ({
                repoId: targets[index]!.repoId,
                name: targets[index]!.name,
                status: result.status === 'fulfilled' ? 'success' : 'failed',
                message:
                    result.status === 'rejected'
                        ? errorMessage(result.reason)
                        : undefined,
            }),
        );
        setBranchOutcomes(current => {
            const byId = new Map(current.map(item => [item.repoId, item]));
            for (const outcome of nextOutcomes)
                byId.set(outcome.repoId, outcome);
            return selectedRepos
                .map(repo => byId.get(repo.repoId)!)
                .filter(Boolean);
        });
        setCreatingBranch(false);
        if (errors.length > 0) {
            setBranchErrors(errors);
            return;
        }
        const priorFailures = branchOutcomes.filter(
            outcome =>
                outcome.status === 'failed' &&
                !targets.some(repo => repo.repoId === outcome.repoId),
        );
        if (priorFailures.length === 0) {
            setBranchDialogOpen(false);
            setBranchName('');
            setBranchOutcomes([]);
            toast.success(
                `Created ${name} in ${selectedRepos.length} repositories`,
            );
        }
    };

    const failedBranchRepos = branchOutcomes.flatMap(outcome => {
        if (outcome.status !== 'failed') return [];
        const repo = selectedRepos.find(item => item.repoId === outcome.repoId);
        return repo ? [repo] : [];
    });

    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:flex-nowrap">
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <h1 className="truncate text-base font-semibold">
                        {engagement.name}
                    </h1>
                    <p className="text-muted-foreground text-xs">
                        {engagement.repositories.length}{' '}
                        {engagement.repositories.length === 1
                            ? 'repository'
                            : 'repositories'}
                        {' · '}
                        {selected.size} selected
                    </p>
                </div>
                <div className="flex h-8 items-stretch border">
                    <button
                        type="button"
                        aria-pressed={view === 'repositories'}
                        onClick={() => setView('repositories')}
                        className={cn(
                            'px-2 text-xs',
                            view === 'repositories'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50',
                        )}
                    >
                        Repositories
                    </button>
                    <button
                        type="button"
                        aria-pressed={view === 'branches'}
                        onClick={() => setView('branches')}
                        className={cn(
                            'border-l px-2 text-xs',
                            view === 'branches'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50',
                        )}
                    >
                        Branch matrix
                    </button>
                    <button
                        type="button"
                        aria-pressed={view === 'pullRequests'}
                        onClick={() => setView('pullRequests')}
                        className={cn(
                            'border-l px-2 text-xs',
                            view === 'pullRequests'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50',
                        )}
                    >
                        Pull requests
                    </button>
                    <button
                        type="button"
                        aria-pressed={view === 'changeSets'}
                        onClick={() => setView('changeSets')}
                        className={cn(
                            'border-l px-2 text-xs',
                            view === 'changeSets'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50',
                        )}
                    >
                        Change sets
                    </button>
                    <button
                        type="button"
                        aria-pressed={view === 'intelligence'}
                        onClick={() => {
                            setView('intelligence');
                            navigate(`/w/${engagement.slug}/intelligence`);
                        }}
                        className={cn(
                            'border-l px-2 text-xs',
                            view === 'intelligence'
                                ? 'bg-accent font-medium'
                                : 'text-muted-foreground hover:bg-accent/50',
                        )}
                    >
                        Intelligence
                    </button>
                </div>
                {view === 'repositories' ? (
                    <>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="px-2 sm:px-3"
                            aria-label={
                                fetching
                                    ? 'Cancel repository fetch'
                                    : 'Fetch selected repositories'
                            }
                            onClick={() =>
                                fetching ? cancelFetch() : void fetchSelected()
                            }
                            disabled={selectedRepos.length === 0}
                        >
                            {fetching ? (
                                <Square className="size-3.5" />
                            ) : (
                                <RefreshCw className="size-3.5" />
                            )}
                            <span className="hidden sm:inline">
                                {fetching
                                    ? `Cancel ${fetchProgress.done}/${fetchProgress.total}`
                                    : 'Fetch selected'}
                            </span>
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="px-2 sm:px-3"
                            aria-label="Create branch across selected repositories"
                            onClick={() => {
                                setBranchOutcomes([]);
                                setBranchErrors([]);
                                setBranchDialogOpen(true);
                            }}
                            disabled={selectedRepos.length === 0}
                        >
                            <GitBranchPlus className="size-3.5" />
                            <span className="hidden sm:inline">New branch</span>
                        </Button>
                    </>
                ) : null}
                {view === 'repositories' ? (
                    <Button
                        type="button"
                        size="sm"
                        className="px-2 sm:px-3"
                        aria-label="Add repository"
                        onClick={() => openSwitcher(true)}
                    >
                        <FolderPlus className="size-3.5 sm:hidden" />
                        <span className="hidden sm:inline">Add repository</span>
                    </Button>
                ) : null}
            </div>

            {view === 'intelligence' ? (
                <WorkspaceIntelligencePanel engagement={engagement} />
            ) : view === 'pullRequests' ? (
                <EngagementPullRequests engagement={engagement} />
            ) : view === 'changeSets' ? (
                <EngagementChangeSets
                    engagement={engagement}
                    onBrowsePullRequests={() => setView('pullRequests')}
                />
            ) : view === 'branches' ? (
                <EngagementBranchMatrix
                    engagement={engagement}
                    selectedRepoIds={selected}
                />
            ) : engagement.repositories.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-3">
                    <FolderGit2 className="text-muted-foreground size-8" />
                    <p className="text-muted-foreground text-sm">
                        No repositories in this workspace.
                    </p>
                    <Button onClick={() => openSwitcher(true)}>
                        Add repository
                    </Button>
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-auto">
                    <Table>
                        <TableHeader className="bg-muted/70 sticky top-0 z-10">
                            <TableRow>
                                <TableHead className="w-10">
                                    <Checkbox
                                        checked={
                                            selected.size ===
                                            engagement.repositories.length
                                        }
                                        onCheckedChange={toggleAll}
                                        aria-label="Select all repositories"
                                    />
                                </TableHead>
                                <TableHead>Repository</TableHead>
                                <TableHead>Branch</TableHead>
                                <TableHead>Working tree</TableHead>
                                <TableHead>Upstream</TableHead>
                                <TableHead>Ahead / behind</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {engagement.repositories.map(repo => (
                                <RepoSummaryRow
                                    key={repo.repoId}
                                    engagement={engagement}
                                    repo={repo}
                                    selected={selected.has(repo.repoId)}
                                    onSelectedChange={checked =>
                                        setSelected(current => {
                                            const next = new Set(current);
                                            if (checked) next.add(repo.repoId);
                                            else next.delete(repo.repoId);
                                            return next;
                                        })
                                    }
                                />
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <Dialog
                open={fetchDialogOpen}
                onOpenChange={open => {
                    if (!fetching) setFetchDialogOpen(open);
                }}
            >
                <DialogContent className="w-[min(500px,calc(100vw-24px))]">
                    <DialogHeader className="border-b p-3">
                        <div>
                            <DialogTitle>Fetch repositories</DialogTitle>
                            <DialogDescription>
                                Fetch and prune each selected repository
                                independently.
                            </DialogDescription>
                        </div>
                    </DialogHeader>
                    <div className="max-h-72 overflow-auto p-3">
                        <div className="border">
                            {fetchOutcomes.map(outcome => (
                                <div
                                    key={outcome.repoId}
                                    className="flex items-start gap-2 border-b px-2 py-1.5 text-xs last:border-b-0"
                                >
                                    {outcome.status === 'pending' ? (
                                        <Loader2 className="mt-0.5 size-3.5 animate-spin" />
                                    ) : outcome.status === 'success' ? (
                                        <CircleCheck className="text-status-staged mt-0.5 size-3.5" />
                                    ) : outcome.status === 'failed' ? (
                                        <CircleX className="text-destructive mt-0.5 size-3.5" />
                                    ) : (
                                        <Square className="text-muted-foreground mt-0.5 size-3.5" />
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-medium">
                                            {outcome.name}
                                        </span>
                                        {outcome.message ? (
                                            <span
                                                className={cn(
                                                    'block',
                                                    outcome.status === 'failed'
                                                        ? 'text-destructive'
                                                        : 'text-muted-foreground',
                                                )}
                                            >
                                                {outcome.message}
                                            </span>
                                        ) : null}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <DialogFooter className="flex-row justify-end gap-2 border-t p-3">
                        {fetching ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={cancelFetch}
                            >
                                <Square className="size-3.5" />
                                Cancel remaining
                            </Button>
                        ) : (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setFetchDialogOpen(false)}
                            >
                                Close
                            </Button>
                        )}
                        {!fetching && failedFetchRepos.length > 0 ? (
                            <Button
                                size="sm"
                                onClick={() =>
                                    void fetchRepos(failedFetchRepos)
                                }
                            >
                                Retry {failedFetchRepos.length} failed
                            </Button>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={branchDialogOpen}
                onOpenChange={open => {
                    if (!creatingBranch) setBranchDialogOpen(open);
                }}
            >
                <DialogContent className="w-[min(460px,calc(100vw-24px))]">
                    <DialogHeader className="border-b p-3">
                        <div>
                            <DialogTitle>Create coordinated branch</DialogTitle>
                            <DialogDescription>
                                Create and switch to the same branch in{' '}
                                {selectedRepos.length} selected repositories.
                            </DialogDescription>
                        </div>
                    </DialogHeader>
                    <div className="space-y-3 p-3">
                        <label className="grid gap-1 text-xs">
                            Branch name
                            <Input
                                autoFocus
                                value={branchName}
                                onChange={event =>
                                    setBranchName(event.target.value)
                                }
                                placeholder="feature/client-ticket"
                                disabled={creatingBranch}
                            />
                        </label>
                        <div className="max-h-36 overflow-auto border">
                            {selectedRepos.map(repo => (
                                <div
                                    key={repo.repoId}
                                    className="flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0"
                                >
                                    {branchOutcomes.find(
                                        outcome =>
                                            outcome.repoId === repo.repoId,
                                    )?.status === 'success' ? (
                                        <CircleCheck className="text-status-staged size-3.5" />
                                    ) : branchOutcomes.find(
                                          outcome =>
                                              outcome.repoId === repo.repoId,
                                      )?.status === 'failed' ? (
                                        <CircleX className="text-destructive size-3.5" />
                                    ) : (
                                        <FolderGit2 className="size-3.5" />
                                    )}
                                    <span className="truncate text-xs">
                                        {repo.name}
                                    </span>
                                </div>
                            ))}
                        </div>
                        {branchErrors.length > 0 ? (
                            <div
                                role="alert"
                                className="border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
                            >
                                {branchErrors.map(message => (
                                    <div key={message}>{message}</div>
                                ))}
                            </div>
                        ) : null}
                    </div>
                    <DialogFooter className="flex-row justify-end gap-2 border-t p-3">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setBranchDialogOpen(false)}
                            disabled={creatingBranch}
                        >
                            Cancel
                        </Button>
                        {failedBranchRepos.length > 0 && !creatingBranch ? (
                            <Button
                                size="sm"
                                onClick={() =>
                                    void createBranchAcrossRepos(
                                        failedBranchRepos,
                                    )
                                }
                            >
                                Retry {failedBranchRepos.length} failed
                            </Button>
                        ) : branchOutcomes.length === 0 ? (
                            <Button
                                size="sm"
                                onClick={() =>
                                    void createBranchAcrossRepos(selectedRepos)
                                }
                                disabled={
                                    creatingBranch || branchName.trim() === ''
                                }
                            >
                                {creatingBranch ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                    <GitBranchPlus className="size-3.5" />
                                )}
                                Create in {selectedRepos.length}
                            </Button>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function BriefcaseEmpty() {
    return (
        <div className="text-muted-foreground grid size-10 place-items-center border">
            <FolderGit2 className="size-5" aria-hidden="true" />
        </div>
    );
}
