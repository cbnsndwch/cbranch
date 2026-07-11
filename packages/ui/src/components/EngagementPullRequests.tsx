import {
    ChangeSetPullRequest,
    type Engagement,
    type GitHubPullRequest,
    type PullRequestListState,
} from '@cbranch/rpc-contract';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import {
    CircleCheck,
    CircleDot,
    CircleX,
    ExternalLink,
    GitCommitHorizontal,
    GitPullRequest,
    Loader2,
    Plus,
    RefreshCw,
    Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { cn } from '../lib/cn';
import { useApi } from '../rpc/ApiProvider';
import { useCreateChangeSet, useSetChangeSetItems } from '../rpc/hooks';
import { queryKeys } from '../rpc/query-keys';
import { PullRequestCreateDialog } from './PullRequestCreateDialog';
import { Badge, type BadgeTone } from './ui/badge';
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

const REVIEW_LABEL: Record<
    GitHubPullRequest['reviewDecision'],
    { readonly label: string; readonly tone: BadgeTone }
> = {
    approved: { label: 'Approved', tone: 'default' },
    changesRequested: { label: 'Changes requested', tone: 'danger' },
    reviewRequired: { label: 'Review required', tone: 'warn' },
    none: { label: 'No review', tone: 'muted' },
};

const prKey = (pull: GitHubPullRequest): string =>
    `${pull.repoId}/${pull.number}`;

function Checks({ pull }: { readonly pull: GitHubPullRequest }) {
    const checks = pull.checks;
    if (checks.total === 0)
        return <span className="text-muted-foreground">No checks</span>;
    if (checks.failed > 0)
        return (
            <span className="text-destructive flex items-center gap-1">
                <CircleX className="size-3.5" />
                {checks.failed} failed
            </span>
        );
    if (checks.pending > 0)
        return (
            <span className="text-status-behind flex items-center gap-1">
                <CircleDot className="size-3.5" />
                {checks.pending} pending
            </span>
        );
    return (
        <span className="text-status-staged flex items-center gap-1">
            <CircleCheck className="size-3.5" />
            {checks.passed} passed
        </span>
    );
}

export function EngagementPullRequests({
    engagement,
}: {
    readonly engagement: Engagement;
}) {
    const api = useApi();
    const queryClient = useQueryClient();
    const createChangeSet = useCreateChangeSet();
    const setChangeSetItems = useSetChangeSetItems();
    const [state, setState] = useState<PullRequestListState>('open');
    const [search, setSearch] = useState('');
    const [repository, setRepository] = useState('all');
    const [author, setAuthor] = useState('all');
    const [reviewer, setReviewer] = useState('all');
    const [branch, setBranch] = useState('all');
    const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
        new Set(),
    );
    const [createOpen, setCreateOpen] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [targetChangeSet, setTargetChangeSet] = useState(
        engagement.changeSets[0]?.id ?? 'new',
    );
    const [newChangeSetName, setNewChangeSetName] = useState('');
    const results = useQueries({
        queries: engagement.repositories.map(repo => ({
            queryKey: queryKeys.githubPulls(repo.repoId, state),
            queryFn: () => api.githubPullsList(repo.repoId, state),
            staleTime: 60_000,
            refetchOnWindowFocus: false,
        })),
    });
    const pulls = useMemo(
        () => results.flatMap(result => result.data?.pullRequests ?? []),
        [results],
    );
    const repositories = [
        ...new Set(pulls.map(pull => pull.repository)),
    ].toSorted();
    const authors = [
        ...new Set(pulls.map(pull => pull.authorLogin).filter(Boolean)),
    ].toSorted();
    const reviewers = [
        ...new Set(pulls.flatMap(pull => pull.reviewerLogins)),
    ].toSorted();
    const branches = [
        ...new Set(pulls.flatMap(pull => [pull.headRefName, pull.baseRefName])),
    ].toSorted();
    const term = search.trim().toLowerCase();
    const filtered = pulls.filter(
        pull =>
            (term === '' ||
                [
                    pull.title,
                    String(pull.number),
                    pull.repository,
                    pull.authorLogin,
                    pull.headRefName,
                    pull.baseRefName,
                    ...pull.reviewerLogins,
                ].some(value => value.toLowerCase().includes(term))) &&
            (repository === 'all' || pull.repository === repository) &&
            (author === 'all' || pull.authorLogin === author) &&
            (reviewer === 'all' || pull.reviewerLogins.includes(reviewer)) &&
            (branch === 'all' ||
                pull.headRefName === branch ||
                pull.baseRefName === branch),
    );
    const selectedPulls = pulls.filter(pull => selectedKeys.has(prKey(pull)));
    const errors = results.flatMap((result, index) =>
        result.isError
            ? [
                  {
                      repo:
                          engagement.repositories[index]?.name ?? 'Repository',
                      message: errorMessage(result.error),
                  },
              ]
            : [],
    );
    const loading = results.some(result => result.isLoading);
    const fetching = results.some(result => result.isFetching);
    const rateLimits = results.flatMap(result =>
        result.data?.rateLimit ? [result.data.rateLimit] : [],
    );
    const rateLimit = rateLimits.toSorted(
        (a, b) => a.remaining - b.remaining,
    )[0];
    const focusedRepo = engagement.repositories.find(
        repo => repo.repoId === engagement.activeRepoId,
    );

    const refresh = () =>
        void queryClient.invalidateQueries({ queryKey: ['github', 'pulls'] });

    const allFilteredSelected =
        filtered.length > 0 &&
        filtered.every(pull => selectedKeys.has(prKey(pull)));

    const toggleAll = (checked: boolean) =>
        setSelectedKeys(current => {
            const next = new Set(current);
            for (const pull of filtered) {
                if (checked) next.add(prKey(pull));
                else next.delete(prKey(pull));
            }
            return next;
        });

    const openAddDialog = () => {
        setTargetChangeSet(engagement.changeSets[0]?.id ?? 'new');
        setNewChangeSetName('');
        setAddOpen(true);
    };

    const addToChangeSet = async () => {
        if (selectedPulls.length === 0) return;
        try {
            let workspace = await api.engagementList();
            let changeSetId: string = targetChangeSet;
            if (targetChangeSet === 'new') {
                const name = newChangeSetName.trim();
                if (name === '') return;
                workspace = await createChangeSet.mutateAsync({
                    engagementId: engagement.id,
                    name,
                });
                changeSetId =
                    workspace.engagements
                        .find(item => item.id === engagement.id)
                        ?.changeSets.at(-1)?.id ?? '';
            }
            const current = workspace.engagements
                .find(item => item.id === engagement.id)
                ?.changeSets.find(changeSet => changeSet.id === changeSetId);
            if (!current) throw new Error('Change set is no longer available');
            const byKey = new Map(
                current.pullRequests.map(item => [
                    `${item.repoId}/${item.number}`,
                    item,
                ]),
            );
            for (const pull of selectedPulls)
                byKey.set(
                    prKey(pull),
                    new ChangeSetPullRequest({
                        repoId: pull.repoId,
                        repository: pull.repository,
                        number: pull.number,
                        title: pull.title,
                        url: pull.url,
                        headRefName: pull.headRefName,
                        headRefOid: pull.headRefOid,
                        baseRefName: pull.baseRefName,
                        dependencyNote: '',
                    }),
                );
            await setChangeSetItems.mutateAsync({
                engagementId: engagement.id,
                changeSetId: current.id,
                items: [...byKey.values()],
            });
            setSelectedKeys(new Set());
            setAddOpen(false);
            toast.success(`Added ${selectedPulls.length} pull requests`);
        } catch (error) {
            toast.error(errorMessage(error));
        }
    };

    const adding = createChangeSet.isPending || setChangeSetItems.isPending;

    return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
                <div
                    className="flex h-7 items-stretch border"
                    aria-label="Pull request state"
                >
                    {(['open', 'closed', 'merged', 'all'] as const).map(
                        value => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={state === value}
                                onClick={() => {
                                    setState(value);
                                    setSelectedKeys(new Set());
                                }}
                                className={cn(
                                    'min-w-14 px-2 text-xs capitalize',
                                    state === value
                                        ? 'bg-accent font-medium text-accent-foreground'
                                        : 'text-muted-foreground hover:bg-accent/50',
                                )}
                            >
                                {value}
                            </button>
                        ),
                    )}
                </div>
                <label className="relative min-w-40 flex-1 sm:max-w-72">
                    <Search
                        className="text-muted-foreground pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2"
                        aria-hidden="true"
                    />
                    <Input
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        placeholder="Filter title or number..."
                        aria-label="Filter pull requests"
                        className="h-7 pl-7"
                    />
                </label>
                <PullFilter
                    label="Repository"
                    value={repository}
                    values={repositories}
                    onChange={setRepository}
                />
                <PullFilter
                    label="Author"
                    value={author}
                    values={authors}
                    onChange={setAuthor}
                />
                <PullFilter
                    label="Reviewer"
                    value={reviewer}
                    values={reviewers}
                    onChange={setReviewer}
                />
                <PullFilter
                    label="Branch"
                    value={branch}
                    values={branches}
                    onChange={setBranch}
                />
                {rateLimit ? (
                    <span className="text-muted-foreground text-[10px]">
                        GitHub API {rateLimit.remaining} remaining
                    </span>
                ) : null}
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-7"
                    aria-label="Refresh pull requests"
                    onClick={refresh}
                    disabled={fetching}
                >
                    <RefreshCw
                        className={cn('size-3.5', fetching && 'animate-spin')}
                    />
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={openAddDialog}
                    disabled={selectedPulls.length === 0}
                >
                    <Plus className="size-3.5" />
                    Change set
                    {selectedPulls.length > 0
                        ? ` (${selectedPulls.length})`
                        : ''}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    className="h-7"
                    onClick={() => setCreateOpen(true)}
                    disabled={!focusedRepo}
                >
                    <GitPullRequest className="size-3.5" />
                    New PR
                </Button>
            </div>
            {loading ? (
                <div className="grid flex-1 place-items-center">
                    <Loader2 className="text-muted-foreground size-5 animate-spin" />
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-auto">
                    {errors.length > 0 ? (
                        <div className="border-b bg-muted/30 px-3 py-2">
                            {errors.map(error => (
                                <div
                                    key={error.repo}
                                    className="flex gap-2 text-xs"
                                >
                                    <span className="font-medium">
                                        {error.repo}
                                    </span>
                                    <span className="text-muted-foreground">
                                        {error.message}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {filtered.length === 0 ? (
                        <div className="flex min-h-48 flex-col items-center justify-center gap-2">
                            <GitPullRequest className="text-muted-foreground size-7" />
                            <span className="text-muted-foreground text-xs">
                                {term ||
                                repository !== 'all' ||
                                author !== 'all' ||
                                reviewer !== 'all' ||
                                branch !== 'all'
                                    ? 'No pull requests match these filters.'
                                    : 'No pull requests in this view.'}
                            </span>
                        </div>
                    ) : (
                        <Table>
                            <TableHeader className="bg-muted/70 sticky top-0 z-10">
                                <TableRow>
                                    <TableHead className="w-10">
                                        <Checkbox
                                            checked={allFilteredSelected}
                                            onCheckedChange={toggleAll}
                                            aria-label="Select visible pull requests"
                                        />
                                    </TableHead>
                                    <TableHead>Repository</TableHead>
                                    <TableHead>Pull request</TableHead>
                                    <TableHead>Branch</TableHead>
                                    <TableHead>Author</TableHead>
                                    <TableHead>Review</TableHead>
                                    <TableHead>Checks</TableHead>
                                    <TableHead>Updated</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {filtered.map(pull => (
                                    <PullRequestRow
                                        key={prKey(pull)}
                                        pull={pull}
                                        selected={selectedKeys.has(prKey(pull))}
                                        onSelected={checked =>
                                            setSelectedKeys(current => {
                                                const next = new Set(current);
                                                if (checked)
                                                    next.add(prKey(pull));
                                                else next.delete(prKey(pull));
                                                return next;
                                            })
                                        }
                                    />
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </div>
            )}

            <PullRequestCreateDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                repo={focusedRepo}
            />
            <Dialog
                open={addOpen}
                onOpenChange={next => {
                    if (!adding) setAddOpen(next);
                }}
            >
                <DialogContent className="w-[min(460px,calc(100vw-24px))]">
                    <DialogHeader className="border-b p-3">
                        <div>
                            <DialogTitle>Add to change set</DialogTitle>
                            <DialogDescription>
                                Add {selectedPulls.length} selected pull
                                requests in their current table order.
                            </DialogDescription>
                        </div>
                    </DialogHeader>
                    <div className="grid gap-3 p-3">
                        <label className="grid gap-1 text-xs">
                            Change set
                            <Select
                                value={targetChangeSet}
                                onValueChange={value => {
                                    if (value !== null)
                                        setTargetChangeSet(value);
                                }}
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {engagement.changeSets.map(changeSet => (
                                        <SelectItem
                                            key={changeSet.id}
                                            value={changeSet.id}
                                        >
                                            {changeSet.name}
                                        </SelectItem>
                                    ))}
                                    <SelectItem value="new">
                                        New change set
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </label>
                        {targetChangeSet === 'new' ? (
                            <label className="grid gap-1 text-xs">
                                New change set name
                                <Input
                                    autoFocus
                                    value={newChangeSetName}
                                    onChange={event =>
                                        setNewChangeSetName(event.target.value)
                                    }
                                />
                            </label>
                        ) : null}
                        <div className="max-h-40 overflow-auto border">
                            {selectedPulls.map(pull => (
                                <div
                                    key={prKey(pull)}
                                    className="border-b px-2 py-1.5 text-xs last:border-b-0"
                                >
                                    <span className="font-mono">
                                        {pull.repository}#{pull.number}
                                    </span>{' '}
                                    {pull.title}
                                </div>
                            ))}
                        </div>
                    </div>
                    <DialogFooter className="flex-row justify-end gap-2 border-t p-3">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setAddOpen(false)}
                            disabled={adding}
                        >
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            onClick={() => void addToChangeSet()}
                            disabled={
                                adding ||
                                (targetChangeSet === 'new' &&
                                    newChangeSetName.trim() === '')
                            }
                        >
                            {adding ? (
                                <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                                <Plus className="size-3.5" />
                            )}
                            Add pull requests
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function PullFilter({
    label,
    value,
    values,
    onChange,
}: {
    readonly label: string;
    readonly value: string;
    readonly values: ReadonlyArray<string>;
    readonly onChange: (value: string) => void;
}) {
    return (
        <Select
            value={value}
            onValueChange={next => {
                if (next !== null) onChange(next);
            }}
        >
            <SelectTrigger
                size="sm"
                aria-label={`Filter by ${label.toLowerCase()}`}
                className="max-w-36"
            >
                <SelectValue>{value === 'all' ? label : value}</SelectValue>
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">
                    All{' '}
                    {label === 'Repository'
                        ? 'repositories'
                        : `${label.toLowerCase()}s`}
                </SelectItem>
                {values.map(option => (
                    <SelectItem key={option} value={option}>
                        {option}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function PullRequestRow({
    pull,
    selected,
    onSelected,
}: {
    readonly pull: GitHubPullRequest;
    readonly selected: boolean;
    readonly onSelected: (selected: boolean) => void;
}) {
    const review = REVIEW_LABEL[pull.reviewDecision];
    const repositoryUrl = `https://github.com/${pull.repository}`;
    return (
        <TableRow data-state={selected ? 'selected' : undefined}>
            <TableCell>
                <Checkbox
                    checked={selected}
                    onCheckedChange={onSelected}
                    aria-label={`Select ${pull.repository} pull request ${pull.number}`}
                />
            </TableCell>
            <TableCell className="font-mono text-xs">
                <a
                    href={repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                >
                    {pull.repository}
                </a>
            </TableCell>
            <TableCell className="min-w-72">
                <a
                    href={pull.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex items-start gap-2 hover:underline"
                >
                    <GitPullRequest className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0">
                        <span className="block font-medium">{pull.title}</span>
                        <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
                            #{pull.number}
                            {pull.isDraft ? ' / Draft' : ''}
                            {' / '}
                            {pull.state}
                        </span>
                    </span>
                    <ExternalLink className="mt-0.5 size-3 shrink-0 opacity-0 group-hover:opacity-100" />
                </a>
            </TableCell>
            <TableCell className="font-mono text-xs whitespace-nowrap">
                <a
                    href={`${repositoryUrl}/tree/${encodeURIComponent(pull.headRefName)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                >
                    {pull.headRefName}
                </a>{' '}
                -&gt;{' '}
                <a
                    href={`${repositoryUrl}/tree/${encodeURIComponent(pull.baseRefName)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline"
                >
                    {pull.baseRefName}
                </a>
                {pull.headRefOid ? (
                    <a
                        href={`${repositoryUrl}/commit/${pull.headRefOid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground mt-0.5 flex items-center gap-1 hover:underline"
                    >
                        <GitCommitHorizontal className="size-3" />
                        {pull.headRefOid.slice(0, 8)}
                    </a>
                ) : null}
            </TableCell>
            <TableCell>
                {pull.authorLogin ? (
                    <a
                        href={`https://github.com/${pull.authorLogin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                    >
                        @{pull.authorLogin}
                    </a>
                ) : (
                    <span className="text-muted-foreground">@unknown</span>
                )}
                {pull.reviewerLogins.length > 0 ? (
                    <span className="text-muted-foreground block text-[10px]">
                        Review: {pull.reviewerLogins.join(', ')}
                    </span>
                ) : null}
            </TableCell>
            <TableCell>
                <Badge tone={review.tone}>{review.label}</Badge>
            </TableCell>
            <TableCell>
                <Checks pull={pull} />
            </TableCell>
            <TableCell className="text-muted-foreground whitespace-nowrap">
                {pull.updatedAt
                    ? new Date(pull.updatedAt).toLocaleDateString()
                    : 'Unknown'}
            </TableCell>
        </TableRow>
    );
}
