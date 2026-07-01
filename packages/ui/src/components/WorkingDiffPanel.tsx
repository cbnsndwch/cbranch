import {
    type Hunk,
    HunkSelection,
    PatchSelection,
    type RepoId,
} from '@cbranch/rpc-contract';

import {
    useWorkingDiff,
    useDiscardHunks,
    useStageHunks,
    useUnstageHunks,
} from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Button } from './ui/button';
import { Placeholder } from './ui/placeholder';

function HunkActions({
    repoId,
    path,
    hunk,
    staged,
}: {
    readonly repoId: RepoId;
    readonly path: string;
    readonly hunk: Hunk;
    readonly staged: boolean;
}) {
    const stageHunks = useStageHunks(repoId);
    const unstageHunks = useUnstageHunks(repoId);
    const discardHunks = useDiscardHunks(repoId);

    const makeSelection = () =>
        new PatchSelection({
            repoId,
            path,
            hunks: [
                new HunkSelection({
                    oldStart: hunk.oldStart,
                    oldLines: hunk.oldLines,
                    newStart: hunk.newStart,
                    newLines: hunk.newLines,
                    selectedLines: [],
                }),
            ],
        });

    if (staged) {
        return (
            <Button
                size="sm"
                variant="outline"
                onClick={() => unstageHunks.mutate(makeSelection())}
                disabled={unstageHunks.isPending}
            >
                Unstage Hunk
            </Button>
        );
    }

    return (
        <div className="flex gap-1">
            <Button
                size="sm"
                variant="outline"
                onClick={() => stageHunks.mutate(makeSelection())}
                disabled={stageHunks.isPending}
            >
                Stage Hunk
            </Button>
            <Button
                size="sm"
                variant="outline"
                onClick={() => discardHunks.mutate(makeSelection())}
                disabled={discardHunks.isPending}
            >
                Discard Hunk
            </Button>
        </div>
    );
}

function HunkBlock({
    repoId,
    path,
    hunk,
    staged,
}: {
    readonly repoId: RepoId;
    readonly path: string;
    readonly hunk: Hunk;
    readonly staged: boolean;
}) {
    return (
        <div className="mb-2 rounded border font-mono text-xs">
            <div className="bg-muted flex items-center justify-between px-2 py-1">
                <span className="text-muted-foreground">{hunk.header}</span>
                <HunkActions
                    repoId={repoId}
                    path={path}
                    hunk={hunk}
                    staged={staged}
                />
            </div>
            <pre className="overflow-x-auto p-1">
                {hunk.lines.map((line, i) => {
                    let prefix = ' ';
                    let cls = '';
                    if (line.kind === 'add') {
                        prefix = '+';
                        cls = 'text-green-600 dark:text-green-400';
                    } else if (line.kind === 'delete') {
                        prefix = '-';
                        cls = 'text-red-600 dark:text-red-400';
                    } else if (line.kind === 'noNewlineAtEof') {
                        prefix = '\\';
                        cls = 'text-muted-foreground';
                    }
                    return (
                        <div key={i} className={cls}>
                            {prefix}
                            {line.content}
                        </div>
                    );
                })}
            </pre>
        </div>
    );
}

export function WorkingDiffPanel({ repoId }: { readonly repoId: RepoId }) {
    const selectedDiffFile = useUiStore(s => s.selectedDiffFile);
    const setSelectedDiffFile = useUiStore(s => s.setSelectedDiffFile);

    const { data, isLoading, isError } = useWorkingDiff(
        repoId,
        selectedDiffFile?.path ?? null,
        selectedDiffFile?.staged ?? false,
    );

    if (!selectedDiffFile) {
        return <Placeholder>Select a file to see its diff.</Placeholder>;
    }

    const { path, staged } = selectedDiffFile;

    if (isLoading) return <Placeholder>Loading diff…</Placeholder>;
    if (isError) return <Placeholder>Failed to load diff.</Placeholder>;
    if (!data) return <Placeholder>No diff data.</Placeholder>;
    if (data.isBinary)
        return <Placeholder>Binary file — cannot diff.</Placeholder>;
    if (data.hunks.length === 0) return <Placeholder>No changes.</Placeholder>;

    return (
        <div className="flex h-full flex-col overflow-hidden">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b px-2 py-1 text-xs">
                <span className="text-muted-foreground truncate font-mono">
                    {path}
                </span>
                <div className="flex gap-1">
                    <Button
                        size="sm"
                        variant={staged ? 'default' : 'outline'}
                        onClick={() =>
                            setSelectedDiffFile({ path, staged: true })
                        }
                    >
                        Staged
                    </Button>
                    <Button
                        size="sm"
                        variant={staged ? 'outline' : 'default'}
                        onClick={() =>
                            setSelectedDiffFile({ path, staged: false })
                        }
                    >
                        Worktree
                    </Button>
                </div>
            </div>
            {/* Hunks */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {data.hunks.map((hunk, i) => (
                    <HunkBlock
                        key={i}
                        repoId={repoId}
                        path={path}
                        hunk={hunk}
                        staged={staged}
                    />
                ))}
            </div>
        </div>
    );
}
