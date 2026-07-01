import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import {
    type KeyboardEvent,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';

import {
    buildDiffSpec,
    defaultDiffOptions,
    type DiffOptions,
    filePath,
} from '../lib/diff';
import { useCommitDetail, useCommitDiff } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { ChangedFileList } from './ChangedFileList';
import { DiffControls } from './DiffControls';
import { FileAtRevision } from './FileAtRevision';
import { RenderedDiffFile } from './RenderedDiffFile';
import { Placeholder } from './ui/placeholder';

// Read-only diff (P1-DIFF-*): the changed-file list, the diff controls, and the selected
// file's patch. Whitespace/context/base/combined drive the server DiffSpec; inline/split is
// a client preference. Next/prev change steps hunks within the file and crosses to the
// adjacent changed file (P1-DIFF-6). The rendered patch (react-diff-view + Shiki) and the
// binary/submodule/large-diff cards land in the next diff-viewer slice.
export function DiffPanel({
    repoId,
    oid,
}: {
    readonly repoId: RepoId;
    readonly oid: Oid | null;
}) {
    const diffView = useUiStore(s => s.diffView);
    const setDiffView = useUiStore(s => s.setDiffView);
    const setBlameTarget = useUiStore(s => s.setBlameTarget);
    const setHistoryTarget = useUiStore(s => s.setHistoryTarget);
    const [options, setOptions] = useState<DiffOptions>(defaultDiffOptions);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [activeHunk, setActiveHunk] = useState(0);
    // Paths the user chose to render despite the large-diff deferral (P1-DIFF-9).
    const [forced, setForced] = useState<ReadonlySet<string>>(new Set());
    // "View file at revision" mode for the active file (P1-DIFF-7).
    const [viewingFile, setViewingFile] = useState(false);

    // Reset transient diff state when the selected commit changes (P1-X-4).
    useEffect(() => {
        setOptions(defaultDiffOptions);
        setSelectedPath(null);
        setActiveHunk(0);
        setForced(new Set());
        setViewingFile(false);
    }, [oid]);

    const spec = useMemo(
        () => (oid ? buildDiffSpec(repoId, oid, options) : null),
        [repoId, oid, options],
    );
    const { data: files, isLoading, isError } = useCommitDiff(spec);
    const { data: detail } = useCommitDetail(repoId, oid);
    const parents = detail?.parents ?? [];

    const scrollRef = useRef<HTMLDivElement>(null);

    // Surface load failures as a toast in addition to the in-panel alert (NF-ERR-2).
    useEffect(() => {
        if (isError) toast.error('Could not load the diff.');
    }, [isError]);

    if (oid === null)
        return <Placeholder>Select a commit to see its changes.</Placeholder>;
    if (isLoading) return <Placeholder>Loading diff…</Placeholder>;
    if (isError || !files)
        return (
            <Placeholder tone="danger">Could not load the diff.</Placeholder>
        );
    if (files.length === 0)
        return <Placeholder>No changes in this commit.</Placeholder>;

    const activeIndex = Math.max(
        0,
        files.findIndex(f => filePath(f) === selectedPath),
    );
    const active = files[activeIndex]!;

    // Blame the active file at this commit (REQ-UX-012). `oid` is narrowed to a concrete oid
    // by the guard above, so the blame read is content-addressed/cacheable (spec 15 §8).
    const openBlame = (path: string) => setBlameTarget({ rev: oid, path });

    // Open this file's history starting at the viewed commit (REQ-FH-005 / REQ-UX-012);
    // `oid` (concrete) keys a cacheable listing.
    const openHistory = (path: string) =>
        setHistoryTarget({ path, startRev: oid });

    const goToHunk = (fileIndex: number, hunkIndex: number) => {
        const file = files[fileIndex]!;
        if (filePath(file) !== filePath(active))
            setSelectedPath(filePath(file));
        setActiveHunk(hunkIndex);
        requestAnimationFrame(() => {
            document
                .getElementById(`hunk-${hunkIndex}`)
                ?.scrollIntoView({ block: 'nearest' });
        });
    };

    // Next/prev change: step hunks within the file, then cross to the adjacent changed file.
    const step = (direction: 1 | -1) => {
        const next = activeHunk + direction;
        if (next >= 0 && next < active.hunks.length) {
            goToHunk(activeIndex, next);
            return;
        }
        const nextFile = activeIndex + direction;
        if (nextFile < 0 || nextFile >= files.length) return;
        const target = files[nextFile]!;
        goToHunk(
            nextFile,
            direction === 1 ? 0 : Math.max(0, target.hunks.length - 1),
        );
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'n' || event.key === 'j') {
            event.preventDefault();
            step(1);
        } else if (event.key === 'p' || event.key === 'k') {
            event.preventDefault();
            step(-1);
        }
    };

    return (
        <div className="flex h-full flex-col">
            {viewingFile ? null : (
                <DiffControls
                    diffView={diffView}
                    onDiffViewChange={setDiffView}
                    options={options}
                    onOptionsChange={setOptions}
                    parents={parents}
                    onPrevChange={() => step(-1)}
                    onNextChange={() => step(1)}
                />
            )}
            <div className="flex min-h-0 flex-1">
                <div className="w-1/3 min-w-44">
                    <ChangedFileList
                        files={files}
                        selectedPath={filePath(active)}
                        onSelect={setSelectedPath}
                        onBlame={openBlame}
                        onHistory={openHistory}
                    />
                </div>
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="text-muted-foreground flex items-center gap-2 border-b px-2 py-0.5 text-[11px]">
                        <span className="truncate font-mono">
                            {filePath(active)}
                        </span>
                        <button
                            type="button"
                            onClick={() => openBlame(filePath(active))}
                            className="hover:bg-accent ml-auto shrink-0 border px-1.5"
                        >
                            Blame
                        </button>
                        <button
                            type="button"
                            onClick={() => openHistory(filePath(active))}
                            className="hover:bg-accent shrink-0 border px-1.5"
                        >
                            History
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewingFile(v => !v)}
                            className="hover:bg-accent shrink-0 border px-1.5"
                        >
                            {viewingFile ? 'Back to diff' : 'View at revision'}
                        </button>
                    </div>
                    <div
                        ref={scrollRef}
                        tabIndex={0}
                        onKeyDown={onKeyDown}
                        className="min-h-0 flex-1 overflow-auto outline-none"
                    >
                        {viewingFile ? (
                            <FileAtRevision
                                repoId={repoId}
                                rev={oid}
                                path={filePath(active)}
                            />
                        ) : (
                            <RenderedDiffFile
                                file={active}
                                diffView={diffView}
                                forced={forced.has(filePath(active))}
                                onForce={() =>
                                    setForced(prev =>
                                        new Set(prev).add(filePath(active)),
                                    )
                                }
                            />
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
