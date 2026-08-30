// Working-tree diff with per-hunk AND per-line staging (docs/spec/06 REQ-P2-HUNK-*;
// docs/spec/17 REQ-P6-LINE-001..003). Each hunk keeps its whole-hunk Stage/Unstage/
// Discard buttons; on top of that the user can click/shift-click individual added or
// removed lines across the file and Stage/Unstage/Discard exactly that selection. A
// line selection maps to HunkSelection.selectedLines (indices into the hunk's line
// array, empty = whole hunk) — the same contract the core patch builder already slices
// by line. Partial discard is destructive and goes behind the confirmation guard.

import {
    type Hunk,
    HunkSelection,
    PatchSelection,
    type RepoId,
} from '@cbranch/rpc-contract';
import { useState } from 'react';

import {
    useDiscardHunks,
    useStageHunks,
    useUnstageHunks,
    useWorkingDiff,
} from '../rpc/hooks';
import { isLargeDiff } from '../lib/diff';
import { useUiStore } from '../state/store';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { LargeDiffCard } from './DiffPlaceholders';
import { Button } from './ui/button';
import { Placeholder } from './ui/placeholder';

/** A selected line, keyed by its hunk index and its index into that hunk's line array. */
const lineKey = (hunkIndex: number, lineIndex: number) =>
    `${hunkIndex}:${lineIndex}`;

/** Whether a diff line can be individually staged (only +/- lines, never context). */
const isSelectableLine = (kind: string) => kind === 'add' || kind === 'delete';

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
    hunkIndex,
    staged,
    selected,
    onToggleLine,
}: {
    readonly repoId: RepoId;
    readonly path: string;
    readonly hunk: Hunk;
    readonly hunkIndex: number;
    readonly staged: boolean;
    readonly selected: ReadonlySet<string>;
    readonly onToggleLine: (
        hunkIndex: number,
        lineIndex: number,
        extend: boolean,
    ) => void;
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
            <div className="overflow-x-auto p-1">
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

                    if (!isSelectableLine(line.kind)) {
                        return (
                            <div key={i} className={`whitespace-pre ${cls}`}>
                                {prefix}
                                {line.content}
                            </div>
                        );
                    }

                    const isSelected = selected.has(lineKey(hunkIndex, i));
                    return (
                        <div
                            key={i}
                            role="button"
                            tabIndex={0}
                            aria-pressed={isSelected}
                            title="Click to select this line; shift-click to extend"
                            className={`hover:bg-accent/60 flex cursor-pointer whitespace-pre ${cls} ${
                                isSelected ? 'bg-accent' : ''
                            }`}
                            onClick={e =>
                                onToggleLine(hunkIndex, i, e.shiftKey)
                            }
                            onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onToggleLine(hunkIndex, i, e.shiftKey);
                                }
                            }}
                        >
                            <span
                                aria-hidden="true"
                                className="text-muted-foreground mr-1 select-none"
                            >
                                {isSelected ? '☑' : '☐'}
                            </span>
                            {prefix}
                            {line.content}
                        </div>
                    );
                })}
            </div>
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

    // Per-line selection across the whole file. Reset whenever the shown file/side
    // changes (the fileKey below), which forces this component's state to remount.
    return (
        <WorkingDiffBody
            key={`${selectedDiffFile?.path ?? ''}:${selectedDiffFile?.staged ?? false}`}
            repoId={repoId}
            selectedDiffFile={selectedDiffFile}
            setSelectedDiffFile={setSelectedDiffFile}
            data={data}
            isLoading={isLoading}
            isError={isError}
        />
    );
}

function WorkingDiffBody({
    repoId,
    selectedDiffFile,
    setSelectedDiffFile,
    data,
    isLoading,
    isError,
}: {
    readonly repoId: RepoId;
    readonly selectedDiffFile: { path: string; staged: boolean } | null;
    readonly setSelectedDiffFile: (
        file: { path: string; staged: boolean } | null,
    ) => void;
    readonly data: ReturnType<typeof useWorkingDiff>['data'];
    readonly isLoading: boolean;
    readonly isError: boolean;
}) {
    const stageHunks = useStageHunks(repoId);
    const unstageHunks = useUnstageHunks(repoId);
    const discardHunks = useDiscardHunks(repoId);

    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    // Anchor for shift-click range selection, within a single hunk.
    const [anchor, setAnchor] = useState<{ hunk: number; line: number } | null>(
        null,
    );
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [largeDiffLoaded, setLargeDiffLoaded] = useState(false);

    const hunks = data?.hunks ?? [];

    const toggleLine = (
        hunkIndex: number,
        lineIndex: number,
        extend: boolean,
    ) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (extend && anchor !== null && anchor.hunk === hunkIndex) {
                // Range-select every +/- line between the anchor and this line.
                const hunk = hunks[hunkIndex];
                const lo = Math.min(anchor.line, lineIndex);
                const hi = Math.max(anchor.line, lineIndex);
                for (let i = lo; i <= hi; i++) {
                    const l = hunk?.lines[i];
                    if (l && isSelectableLine(l.kind))
                        next.add(lineKey(hunkIndex, i));
                }
            } else {
                const key = lineKey(hunkIndex, lineIndex);
                if (next.has(key)) next.delete(key);
                else next.add(key);
            }
            return next;
        });
        setAnchor({ hunk: hunkIndex, line: lineIndex });
    };

    // Turn the file-wide line selection into a per-hunk PatchSelection (empty result
    // means nothing selected). Only hunks with at least one selected line are included.
    const buildLineSelection = (): PatchSelection | null => {
        if (selectedDiffFile === null) return null;
        const byHunk = new Map<number, number[]>();
        for (const key of selected) {
            const [h, l] = key.split(':').map(Number);
            const arr = byHunk.get(h) ?? [];
            arr.push(l);
            byHunk.set(h, arr);
        }
        const hunkSelections: HunkSelection[] = [];
        for (const [h, lineIndices] of byHunk) {
            const hunk = hunks[h];
            if (hunk === undefined) continue;
            hunkSelections.push(
                new HunkSelection({
                    oldStart: hunk.oldStart,
                    oldLines: hunk.oldLines,
                    newStart: hunk.newStart,
                    newLines: hunk.newLines,
                    selectedLines: lineIndices.toSorted((a, b) => a - b),
                }),
            );
        }
        if (hunkSelections.length === 0) return null;
        return new PatchSelection({
            repoId,
            path: selectedDiffFile.path,
            hunks: hunkSelections,
        });
    };

    const clearSelection = () => {
        setSelected(new Set());
        setAnchor(null);
    };

    const stageLines = () => {
        const sel = buildLineSelection();
        if (sel !== null) stageHunks.mutate(sel, { onSuccess: clearSelection });
    };
    const unstageLines = () => {
        const sel = buildLineSelection();
        if (sel !== null)
            unstageHunks.mutate(sel, { onSuccess: clearSelection });
    };
    const discardLines = () => {
        const sel = buildLineSelection();
        if (sel !== null)
            discardHunks.mutate(sel, { onSuccess: clearSelection });
    };

    const selectionCount = selected.size;

    if (selectedDiffFile === null)
        return <Placeholder>Select a file to see its diff.</Placeholder>;

    const { path, staged } = selectedDiffFile;

    if (isLoading) return <Placeholder>Loading diff…</Placeholder>;
    if (isError) return <Placeholder>Failed to load diff.</Placeholder>;
    if (!data) return <Placeholder>No diff data.</Placeholder>;
    if (data.isBinary)
        return <Placeholder>Binary file — cannot diff.</Placeholder>;
    if (isLargeDiff(data) && !largeDiffLoaded)
        return (
            <LargeDiffCard
                file={data}
                onLoad={() => setLargeDiffLoaded(true)}
            />
        );
    if (
        data.status === 'added' &&
        data.additions === 0 &&
        data.deletions === 0 &&
        data.hunks.length === 0
    )
        return (
            <Placeholder>
                Empty new file — {path} has no content to display.
            </Placeholder>
        );
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

            {/* Line-selection action bar (REQ-P6-LINE-001): acts on the current line
          selection across the file. */}
            {selectionCount > 0 && (
                <div className="bg-muted/50 flex shrink-0 items-center gap-2 border-b px-2 py-1 text-xs">
                    <span className="text-muted-foreground">
                        {selectionCount} line
                        {selectionCount === 1 ? '' : 's'} selected
                    </span>
                    <div className="ml-auto flex gap-1">
                        {staged ? (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={unstageLines}
                                disabled={unstageHunks.isPending}
                            >
                                Unstage lines
                            </Button>
                        ) : (
                            <>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={stageLines}
                                    disabled={stageHunks.isPending}
                                >
                                    Stage lines
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => setConfirmDiscard(true)}
                                    disabled={discardHunks.isPending}
                                >
                                    Discard lines
                                </Button>
                            </>
                        )}
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={clearSelection}
                        >
                            Clear
                        </Button>
                    </div>
                </div>
            )}

            {/* Hunks */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {data.hunks.map((hunk, i) => (
                    <HunkBlock
                        key={i}
                        repoId={repoId}
                        path={path}
                        hunk={hunk}
                        hunkIndex={i}
                        staged={staged}
                        selected={selected}
                        onToggleLine={toggleLine}
                    />
                ))}
            </div>

            <DestructiveConfirmDialog
                open={confirmDiscard}
                onOpenChange={setConfirmDiscard}
                title="Discard selected lines?"
                description={`This permanently discards ${selectionCount} selected line${
                    selectionCount === 1 ? '' : 's'
                } from ${path} in the working tree. This is irreversible and cannot be undone.`}
                confirmLabel="Discard lines"
                onConfirm={discardLines}
            />
        </div>
    );
}
