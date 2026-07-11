import {
    type BranchListing,
    type BranchSwitchStrategy,
    type Engagement,
    type RecentRepo,
    type RepoId,
} from '@cbranch/rpc-contract';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
    CloudUpload,
    GitBranch,
    GitCompareArrows,
    Loader2,
    RefreshCw,
    Repeat2,
    Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { cn } from '../lib/cn';
import { useApi } from '../rpc/ApiProvider';
import { queryKeys } from '../rpc/query-keys';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from './ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from './ui/table';

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);

export interface BranchMatrixEntry {
    readonly repo: RecentRepo;
    readonly listing?: BranchListing;
    readonly local?: BranchListing['localBranches'][number];
    readonly remote?: BranchListing['remoteBranches'][number];
}

export const buildBranchMatrix = (
    repos: ReadonlyArray<RecentRepo>,
    listings: ReadonlyMap<RepoId, BranchListing>,
    branchName: string,
): ReadonlyArray<BranchMatrixEntry> =>
    repos.map(repo => {
        const listing = listings.get(repo.repoId);
        return {
            repo,
            listing,
            local: listing?.localBranches.find(
                branch => branch.name === branchName,
            ),
            remote: listing?.remoteBranches.find(branch =>
                branch.name.endsWith(`/${branchName}`),
            ),
        };
    });

interface SwitchOutcome {
    readonly repoId: RepoId;
    readonly name: string;
    readonly status: 'pending' | 'success' | 'failed';
    readonly message?: string;
}

const streamOperation = (
    start: (
        onComplete: () => void,
        onError: (error: unknown) => void,
    ) => () => void,
) =>
    new Promise<void>((resolve, reject) => {
        start(resolve, reject);
    });

export function EngagementBranchMatrix({
    engagement,
    selectedRepoIds,
}: {
    readonly engagement: Engagement;
    readonly selectedRepoIds: ReadonlySet<RepoId>;
}) {
    const api = useApi();
    const queryClient = useQueryClient();
    const repos = engagement.repositories.filter(repo =>
        selectedRepoIds.has(repo.repoId),
    );
    const branchQueries = useQueries({
        queries: repos.map(repo => ({
            queryKey: queryKeys.branches(repo.repoId),
            queryFn: () => api.branchList(repo.repoId),
        })),
    });
    const statusQueries = useQueries({
        queries: repos.map(repo => ({
            queryKey: queryKeys.status(repo.repoId),
            queryFn: () => api.statusGet(repo.repoId),
        })),
    });
    const listings = useMemo(
        () =>
            new Map(
                repos.flatMap((repo, index) => {
                    const listing = branchQueries[index]?.data;
                    return listing
                        ? ([[repo.repoId, listing]] as const)
                        : ([] as const);
                }),
            ),
        [branchQueries, repos],
    );
    const branchNames = useMemo(
        () =>
            [
                ...new Set(
                    [...listings.values()]
                        .flatMap(listing =>
                            listing.localBranches
                                .map(branch => branch.name)
                                .concat(
                                    listing.remoteBranches.map(branch =>
                                        branch.remoteName
                                            ? branch.name.slice(
                                                  branch.remoteName.length + 1,
                                              )
                                            : branch.name,
                                    ),
                                ),
                        )
                        .filter(Boolean),
                ),
            ].toSorted(),
        [listings],
    );
    const commonBranches = branchNames.filter(name =>
        repos.every(repo =>
            listings
                .get(repo.repoId)
                ?.localBranches.some(branch => branch.name === name),
        ),
    );
    const [requestedBranch, setRequestedBranch] = useState('');
    const branchName = branchNames.includes(requestedBranch)
        ? requestedBranch
        : (commonBranches[0] ?? branchNames[0] ?? '');

    const rows = buildBranchMatrix(repos, listings, branchName);
    const canSwitch =
        rows.length > 0 &&
        branchName !== '' &&
        rows.every(row => row.local !== undefined);
    const dirtyCount = statusQueries.filter(result =>
        result.data?.entries.some(
            entry =>
                entry.staged !== 'unmodified' ||
                entry.unstaged !== 'unmodified' ||
                entry.isUntracked,
        ),
    ).length;
    const loading = branchQueries.some(query => query.isLoading);
    const [switchOpen, setSwitchOpen] = useState(false);
    const [strategy, setStrategy] =
        useState<Exclude<BranchSwitchStrategy, 'discard'>>('carry');
    const [switching, setSwitching] = useState(false);
    const [outcomes, setOutcomes] = useState<ReadonlyArray<SwitchOutcome>>([]);
    const [repairing, setRepairing] = useState<RepoId | null>(null);
    const [repairErrors, setRepairErrors] = useState<
        ReadonlyMap<RepoId, string>
    >(new Map());

    const invalidateRepo = async (repoId: RepoId) => {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: queryKeys.branches(repoId),
            }),
            queryClient.invalidateQueries({
                queryKey: queryKeys.status(repoId),
            }),
        ]);
    };

    const runSwitch = async (targets: ReadonlyArray<RecentRepo>) => {
        setSwitching(true);
        setOutcomes(current => {
            const byId = new Map(current.map(item => [item.repoId, item]));
            for (const repo of targets)
                byId.set(repo.repoId, {
                    repoId: repo.repoId,
                    name: repo.name,
                    status: 'pending',
                });
            return repos.map(
                repo =>
                    byId.get(repo.repoId) ?? {
                        repoId: repo.repoId,
                        name: repo.name,
                        status: 'pending',
                    },
            );
        });
        await Promise.all(
            targets.map(async repo => {
                try {
                    await api.branchSwitch(
                        repo.repoId,
                        branchName,
                        dirtyCount > 0 ? strategy : undefined,
                        strategy === 'stash' ? true : undefined,
                    );
                    await invalidateRepo(repo.repoId);
                    setOutcomes(current =>
                        current.map(item =>
                            item.repoId === repo.repoId
                                ? { ...item, status: 'success' }
                                : item,
                        ),
                    );
                } catch (error) {
                    setOutcomes(current =>
                        current.map(item =>
                            item.repoId === repo.repoId
                                ? {
                                      ...item,
                                      status: 'failed',
                                      message: errorMessage(error),
                                  }
                                : item,
                        ),
                    );
                }
            }),
        );
        setSwitching(false);
    };

    const repair = async (
        row: BranchMatrixEntry,
        action: 'fetch' | 'create' | 'track' | 'publish' | 'switch',
    ) => {
        setRepairing(row.repo.repoId);
        setRepairErrors(current => {
            const next = new Map(current);
            next.delete(row.repo.repoId);
            return next;
        });
        try {
            if (action === 'fetch')
                await streamOperation((onComplete, onError) =>
                    api.fetchStream(
                        row.repo.repoId,
                        { all: true, prune: true },
                        { onItem: () => undefined, onComplete, onError },
                    ),
                );
            if (action === 'create' && row.remote)
                await api.branchCreate(
                    row.repo.repoId,
                    branchName,
                    row.remote.name,
                    true,
                    false,
                );
            if (action === 'track' && row.remote)
                await api.branchSetUpstream(
                    row.repo.repoId,
                    branchName,
                    row.remote.name,
                );
            if (action === 'publish')
                await streamOperation((onComplete, onError) =>
                    api.pushStream(
                        row.repo.repoId,
                        'origin',
                        { branch: branchName, setUpstream: true },
                        { onItem: () => undefined, onComplete, onError },
                    ),
                );
            if (action === 'switch')
                await api.branchSwitch(row.repo.repoId, branchName, 'carry');
            await invalidateRepo(row.repo.repoId);
        } catch (error) {
            setRepairErrors(current =>
                new Map(current).set(row.repo.repoId, errorMessage(error)),
            );
        } finally {
            setRepairing(null);
        }
    };

    const failedRepos = outcomes.flatMap(outcome => {
        if (outcome.status !== 'failed') return [];
        const repo = repos.find(item => item.repoId === outcome.repoId);
        return repo ? [repo] : [];
    });

    if (repos.length === 0)
        return (
            <div className="grid flex-1 place-items-center p-6 text-center">
                <div>
                    <GitCompareArrows className="text-muted-foreground mx-auto mb-2 size-7" />
                    <p className="text-muted-foreground text-xs">
                        No repositories selected.
                    </p>
                </div>
            </div>
        );

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
                <GitCompareArrows className="text-muted-foreground size-4" />
                <Select
                    value={branchName}
                    onValueChange={value => {
                        if (value !== null) setRequestedBranch(value);
                    }}
                >
                    <SelectTrigger
                        size="sm"
                        aria-label="Branch to compare"
                        className="min-w-48"
                    >
                        <SelectValue placeholder="Choose branch" />
                    </SelectTrigger>
                    <SelectContent>
                        {branchNames.map(name => (
                            <SelectItem key={name} value={name}>
                                {name}
                                {commonBranches.includes(name)
                                    ? ' (common)'
                                    : ''}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <span className="text-muted-foreground text-[10px]">
                    {commonBranches.length} common across {repos.length}{' '}
                    selected
                </span>
                <Button
                    type="button"
                    size="sm"
                    className="ml-auto"
                    disabled={!canSwitch || loading}
                    onClick={() => {
                        setOutcomes([]);
                        setSwitchOpen(true);
                    }}
                >
                    <Repeat2 className="size-3.5" />
                    Switch selected
                </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
                <Table>
                    <TableHeader className="bg-muted/70 sticky top-0 z-10">
                        <TableRow>
                            <TableHead>Repository</TableHead>
                            <TableHead>Current</TableHead>
                            <TableHead>Local</TableHead>
                            <TableHead>Remote</TableHead>
                            <TableHead>Upstream</TableHead>
                            <TableHead>Ahead / behind</TableHead>
                            <TableHead className="text-right">Repair</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map(row => {
                            const busy = repairing === row.repo.repoId;
                            const current = row.listing?.currentBranch;
                            return (
                                <TableRow key={row.repo.repoId}>
                                    <TableCell>
                                        <span className="block font-medium">
                                            {row.repo.name}
                                        </span>
                                        {repairErrors.get(row.repo.repoId) ? (
                                            <span className="text-destructive block max-w-72 text-[10px]">
                                                {repairErrors.get(
                                                    row.repo.repoId,
                                                )}
                                            </span>
                                        ) : null}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {current ?? 'Detached'}
                                    </TableCell>
                                    <TableCell>
                                        {row.local ? (
                                            <Badge>Present</Badge>
                                        ) : (
                                            <Badge tone="danger">Missing</Badge>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {row.remote ? (
                                            <span className="font-mono text-xs">
                                                {row.remote.name}
                                            </span>
                                        ) : (
                                            <Badge tone="warn">
                                                Unpublished
                                            </Badge>
                                        )}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {row.local?.upstream?.name ?? 'None'}
                                    </TableCell>
                                    <TableCell>
                                        {row.local?.upstream ? (
                                            <div className="flex gap-1">
                                                <Badge>
                                                    {row.local.upstream.ahead}{' '}
                                                    ahead
                                                </Badge>
                                                <Badge tone="warn">
                                                    {row.local.upstream.behind}{' '}
                                                    behind
                                                </Badge>
                                            </div>
                                        ) : (
                                            <span className="text-muted-foreground">
                                                --
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <div className="flex justify-end gap-1">
                                            {!row.local && row.remote ? (
                                                <RepairButton
                                                    label="Create local branch"
                                                    busy={busy}
                                                    onClick={() =>
                                                        void repair(
                                                            row,
                                                            'create',
                                                        )
                                                    }
                                                >
                                                    <GitBranch />
                                                    Create local
                                                </RepairButton>
                                            ) : null}
                                            {row.local && !row.remote ? (
                                                <RepairButton
                                                    label="Publish branch"
                                                    busy={busy}
                                                    onClick={() =>
                                                        void repair(
                                                            row,
                                                            'publish',
                                                        )
                                                    }
                                                >
                                                    <CloudUpload />
                                                    Publish
                                                </RepairButton>
                                            ) : null}
                                            {row.local &&
                                            row.remote &&
                                            !row.local.upstream ? (
                                                <RepairButton
                                                    label="Set upstream"
                                                    busy={busy}
                                                    onClick={() =>
                                                        void repair(
                                                            row,
                                                            'track',
                                                        )
                                                    }
                                                >
                                                    <Wrench />
                                                    Track
                                                </RepairButton>
                                            ) : null}
                                            {row.local &&
                                            current !== branchName ? (
                                                <RepairButton
                                                    label="Switch repository"
                                                    busy={busy}
                                                    onClick={() =>
                                                        void repair(
                                                            row,
                                                            'switch',
                                                        )
                                                    }
                                                >
                                                    <Repeat2 />
                                                    Switch
                                                </RepairButton>
                                            ) : null}
                                            {!row.remote ? (
                                                <RepairButton
                                                    label="Fetch repository"
                                                    busy={busy}
                                                    onClick={() =>
                                                        void repair(
                                                            row,
                                                            'fetch',
                                                        )
                                                    }
                                                >
                                                    <RefreshCw />
                                                </RepairButton>
                                            ) : null}
                                        </div>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>

            <Dialog
                open={switchOpen}
                onOpenChange={open => {
                    if (!switching) setSwitchOpen(open);
                }}
            >
                <DialogContent className="w-[min(520px,calc(100vw-24px))]">
                    <DialogHeader className="border-b p-3">
                        <div>
                            <DialogTitle>Switch coordinated branch</DialogTitle>
                            <DialogDescription>
                                Switch {repos.length} repositories to{' '}
                                {branchName}. Successful repositories are not
                                rolled back if another fails.
                            </DialogDescription>
                        </div>
                    </DialogHeader>
                    <div className="space-y-3 p-3">
                        {dirtyCount > 0 && outcomes.length === 0 ? (
                            <fieldset className="grid gap-2">
                                <legend className="text-xs font-medium">
                                    {dirtyCount}{' '}
                                    {dirtyCount === 1
                                        ? 'repository has'
                                        : 'repositories have'}{' '}
                                    local changes
                                </legend>
                                <div className="grid grid-cols-2 border">
                                    <button
                                        type="button"
                                        aria-pressed={strategy === 'carry'}
                                        onClick={() => setStrategy('carry')}
                                        className={cn(
                                            'p-2 text-left text-xs',
                                            strategy === 'carry'
                                                ? 'bg-accent font-medium'
                                                : 'hover:bg-accent/50',
                                        )}
                                    >
                                        Carry changes
                                        <span className="text-muted-foreground mt-0.5 block text-[10px] font-normal">
                                            Git refuses only conflicting paths.
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        aria-pressed={strategy === 'stash'}
                                        onClick={() => setStrategy('stash')}
                                        className={cn(
                                            'border-l p-2 text-left text-xs',
                                            strategy === 'stash'
                                                ? 'bg-accent font-medium'
                                                : 'hover:bg-accent/50',
                                        )}
                                    >
                                        Stash and reapply
                                        <span className="text-muted-foreground mt-0.5 block text-[10px] font-normal">
                                            Includes untracked files per
                                            repository.
                                        </span>
                                    </button>
                                </div>
                            </fieldset>
                        ) : null}
                        <div className="max-h-64 overflow-auto border">
                            {(outcomes.length > 0
                                ? outcomes
                                : repos.map(repo => ({
                                      repoId: repo.repoId,
                                      name: repo.name,
                                      status: 'pending' as const,
                                      message: undefined,
                                  }))
                            ).map(outcome => (
                                <div
                                    key={outcome.repoId}
                                    className="flex items-start gap-2 border-b px-2 py-1.5 text-xs last:border-b-0"
                                >
                                    {outcome.status === 'pending' &&
                                    switching ? (
                                        <Loader2 className="mt-0.5 size-3.5 animate-spin" />
                                    ) : (
                                        <span
                                            className={cn(
                                                'mt-1 size-2 shrink-0',
                                                outcome.status === 'success'
                                                    ? 'bg-status-staged'
                                                    : outcome.status ===
                                                        'failed'
                                                      ? 'bg-destructive'
                                                      : 'bg-muted-foreground',
                                            )}
                                        />
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-medium">
                                            {outcome.name}
                                        </span>
                                        {outcome.message ? (
                                            <span className="text-destructive block">
                                                {outcome.message}
                                            </span>
                                        ) : null}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                    <DialogFooter className="flex-row justify-end gap-2 border-t p-3">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSwitchOpen(false)}
                            disabled={switching}
                        >
                            {outcomes.length > 0 ? 'Close' : 'Cancel'}
                        </Button>
                        {failedRepos.length > 0 && !switching ? (
                            <Button
                                size="sm"
                                onClick={() => void runSwitch(failedRepos)}
                            >
                                Retry {failedRepos.length} failed
                            </Button>
                        ) : outcomes.length === 0 ? (
                            <Button
                                size="sm"
                                onClick={() => void runSwitch(repos)}
                                disabled={switching}
                            >
                                {switching ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                    <Repeat2 className="size-3.5" />
                                )}
                                Switch {repos.length}
                            </Button>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function RepairButton({
    label,
    busy,
    onClick,
    children,
}: {
    readonly label: string;
    readonly busy: boolean;
    readonly onClick: () => void;
    readonly children: React.ReactNode;
}) {
    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2"
            aria-label={label}
            disabled={busy}
            onClick={onClick}
        >
            {busy ? <Loader2 className="size-3 animate-spin" /> : children}
        </Button>
    );
}
