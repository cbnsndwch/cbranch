import { type RecentRepo, type RepoId } from '@cbranch/rpc-contract';
import {
    ExternalLink,
    GitCommitHorizontal,
    GitPullRequest,
    Loader2,
    RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { useCreateGitHubPullRequest, useGitHubPullPreview } from '../rpc/hooks';
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
import { Textarea } from './ui/textarea';

const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : String(error);

export function PullRequestCreateDialog({
    open,
    onOpenChange,
    repo,
}: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly repo: RecentRepo | undefined;
}) {
    const repoId: RepoId | null = repo?.repoId ?? null;
    const [base, setBase] = useState('');
    const [previewBase, setPreviewBase] = useState<string | undefined>();
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [draft, setDraft] = useState(false);
    const preview = useGitHubPullPreview(repoId, previewBase, open);
    const create = useCreateGitHubPullRequest();

    useEffect(() => {
        if (!open) return;
        setBase('');
        setPreviewBase(undefined);
        setTitle('');
        setBody('');
        setDraft(false);
        create.reset();
    }, [open]);

    useEffect(() => {
        if (!preview.data) return;
        setBase(current => current || preview.data!.baseRefName);
        setTitle(
            current => current || preview.data!.commits.at(-1)?.subject || '',
        );
    }, [preview.data]);

    const refreshPreview = () => {
        const next = base.trim() || undefined;
        if (next === previewBase) void preview.refetch();
        else setPreviewBase(next);
    };

    const createPullRequest = () => {
        if (!repo) return;
        create.mutate({
            repoId: repo.repoId,
            title: title.trim(),
            body,
            baseRefName: base.trim(),
            draft,
        });
    };

    const exactPreview =
        preview.data !== undefined && preview.data.baseRefName === base.trim();
    const canCreate =
        exactPreview &&
        preview.data.headPublished &&
        preview.data.commits.length > 0 &&
        title.trim() !== '' &&
        !create.isPending;

    return (
        <Dialog
            open={open}
            onOpenChange={next => {
                if (!create.isPending) onOpenChange(next);
            }}
        >
            <DialogContent className="h-[min(720px,calc(100dvh-24px))] w-[min(680px,calc(100vw-24px))] overflow-hidden">
                <DialogHeader className="shrink-0 border-b p-3">
                    <div>
                        <DialogTitle>Create pull request</DialogTitle>
                        <DialogDescription>
                            {repo
                                ? `${repo.name} is the focused repository.`
                                : 'Focus a repository before creating a pull request.'}
                        </DialogDescription>
                    </div>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                    {!repo ? (
                        <p className="text-muted-foreground text-xs">
                            No focused repository is available in this
                            workspace.
                        </p>
                    ) : create.data ? (
                        <div className="grid min-h-48 place-items-center text-center">
                            <div>
                                <GitPullRequest className="text-status-staged mx-auto mb-2 size-8" />
                                <p className="text-sm font-medium">
                                    Pull request #{create.data.number} created
                                </p>
                                <a
                                    href={create.data.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-primary mt-2 inline-flex items-center gap-1 text-xs hover:underline"
                                >
                                    Open on GitHub
                                    <ExternalLink className="size-3" />
                                </a>
                            </div>
                        </div>
                    ) : (
                        <div className="grid gap-3">
                            <label className="grid gap-1 text-xs">
                                Base branch
                                <span className="flex gap-1">
                                    <Input
                                        value={base}
                                        onChange={event =>
                                            setBase(event.target.value)
                                        }
                                        placeholder="main"
                                        disabled={preview.isLoading}
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="icon"
                                        aria-label="Refresh pull request preview"
                                        onClick={refreshPreview}
                                        disabled={
                                            preview.isFetching ||
                                            base.trim() === ''
                                        }
                                    >
                                        <RefreshCw className="size-3.5" />
                                    </Button>
                                </span>
                            </label>
                            <label className="grid gap-1 text-xs">
                                Title
                                <Input
                                    value={title}
                                    onChange={event =>
                                        setTitle(event.target.value)
                                    }
                                    disabled={create.isPending}
                                />
                            </label>
                            <label className="grid gap-1 text-xs">
                                Body
                                <Textarea
                                    value={body}
                                    onChange={event =>
                                        setBody(event.target.value)
                                    }
                                    rows={6}
                                    disabled={create.isPending}
                                />
                            </label>
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox
                                    checked={draft}
                                    onCheckedChange={setDraft}
                                    disabled={create.isPending}
                                />
                                Create as draft
                            </label>

                            {preview.isLoading ? (
                                <div className="grid min-h-32 place-items-center border">
                                    <Loader2 className="text-muted-foreground size-5 animate-spin" />
                                </div>
                            ) : preview.isError ? (
                                <div
                                    role="alert"
                                    className="border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
                                >
                                    {errorMessage(preview.error)}
                                </div>
                            ) : preview.data ? (
                                <div className="border">
                                    <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 text-xs">
                                        <span className="font-mono">
                                            {preview.data.headRefName}
                                        </span>
                                        <span className="text-muted-foreground">
                                            -&gt;
                                        </span>
                                        <span className="font-mono">
                                            {preview.data.baseRefName}
                                        </span>
                                        <Badge
                                            tone={
                                                preview.data.headPublished
                                                    ? 'default'
                                                    : 'danger'
                                            }
                                        >
                                            {preview.data.headPublished
                                                ? 'Published head'
                                                : 'Push required'}
                                        </Badge>
                                        <span className="text-muted-foreground ml-auto">
                                            {preview.data.commits.length}{' '}
                                            {preview.data.commits.length === 1
                                                ? 'commit'
                                                : 'commits'}
                                        </span>
                                    </div>
                                    <div className="max-h-40 overflow-auto">
                                        {preview.data.commits.map(commit => (
                                            <a
                                                key={commit.oid}
                                                href={`${preview.data!.repositoryUrl}/commit/${commit.oid}`}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="flex items-start gap-2 border-b px-2 py-1.5 text-xs last:border-b-0 hover:bg-accent/50"
                                            >
                                                <GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0" />
                                                <span className="min-w-0 flex-1">
                                                    <span className="block font-medium">
                                                        {commit.subject}
                                                    </span>
                                                    <span className="text-muted-foreground">
                                                        {commit.oid.slice(0, 8)}{' '}
                                                        / {commit.authorName}
                                                    </span>
                                                </span>
                                            </a>
                                        ))}
                                        {preview.data.commits.length === 0 ? (
                                            <p className="text-muted-foreground p-2 text-xs">
                                                No commits are ahead of the
                                                selected base.
                                            </p>
                                        ) : null}
                                    </div>
                                </div>
                            ) : null}
                            {!exactPreview && preview.data ? (
                                <p className="text-status-behind text-xs">
                                    Refresh the preview after changing the base
                                    branch.
                                </p>
                            ) : null}
                            {create.isError ? (
                                <div
                                    role="alert"
                                    className="border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive"
                                >
                                    {errorMessage(create.error)}
                                </div>
                            ) : null}
                        </div>
                    )}
                </div>
                <DialogFooter className="shrink-0 flex-row justify-end gap-2 border-t p-3">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onOpenChange(false)}
                        disabled={create.isPending}
                    >
                        {create.data ? 'Close' : 'Cancel'}
                    </Button>
                    {!create.data && repo ? (
                        <Button
                            size="sm"
                            onClick={createPullRequest}
                            disabled={!canCreate}
                        >
                            {create.isPending ? (
                                <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                                <GitPullRequest className="size-3.5" />
                            )}
                            Create pull request
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
