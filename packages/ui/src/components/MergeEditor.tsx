// The built-in 3-way merge editor (docs/spec/11 REQ-MERGE-010..020, REQ-UX-082..085;
// DECISIONS D17). Opened from a conflicted text row's "Edit…" action (UI-A seam).
//
// Design: the editable **Result** is a plain textarea bound to LF-normalized working text
// (REQ-MERGE-013 "freely editable as plain text at all times"), seeded from the working-tree
// bytes git wrote (markers + non-conflicting context, REQ-MERGE-015). Per-hunk Accept
// actions splice a chosen side into the Result through the pure `mergeMarkers` model. The
// CodeMirror 6 + `@codemirror/merge` surface (REQ-STACK-021) renders a read-only,
// Shiki-highlighted side-by-side compare of the Result against a selectable contributing
// side (Base / Ours / Incoming) so all three versions stay inspectable (REQ-MERGE-010/019);
// it is loaded lazily (REQ-STACK-019) and degrades to the textarea alone when unavailable.
// Saving sends base64 of the exact assembled buffer — the detected EOL/BOM are restored onto
// the LF-normalized text before encoding so the host writes byte-faithful content
// (REQ-MERGE-019 edge / spec 11 "CRLF / BOM"), then stages the path (REQ-MERGE-016).
import {
    type ConflictResolution,
    type ConflictSides,
    type RepoId,
} from '@cbranch/rpc-contract';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { languageForPath, loadShikiLines } from '../lib/shiki-highlighter';
import {
    type AcceptChoice,
    applyResolution,
    type ConflictBlock,
    fromWorkingText,
    hasConflictMarkers,
    parseConflicts,
    toWorkingText,
    utf8ToBase64,
    type WorkingText,
} from '../lib/mergeMarkers';
import {
    useConflictResolve,
    useConflictSaveMerged,
    useConflictSides,
} from '../rpc/hooks';
import { useUiStore } from '../state/store';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogClose,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from './ui/dialog';

const LF = String.fromCharCode(10);

type CompareSide = 'base' | 'ours' | 'theirs';

const COMPARE_LABELS: Record<CompareSide, string> = {
    base: 'Base',
    ours: 'Ours',
    theirs: 'Incoming',
};

const stageOf = (data: ConflictSides, side: CompareSide) =>
    side === 'base' ? data.base : side === 'ours' ? data.ours : data.theirs;

const sideContent = (data: ConflictSides, side: CompareSide): string => {
    const stage = stageOf(data, side);
    return stage.present ? stage.content : '';
};

interface MergeEditorProps {
    readonly repoId: RepoId;
    readonly path: string;
    readonly onClose: () => void;
}

export function MergeEditor({ repoId, path, onClose }: MergeEditorProps) {
    const sidesQ = useConflictSides(repoId, path);
    const saveMut = useConflictSaveMerged(repoId);
    const resolveMut = useConflictResolve(repoId);
    const theme = useUiStore(s => s.theme);

    const data = sidesQ.data;

    // LF-normalized editable Result; `seedRef` keeps the EOL/BOM + original for discard.
    const [resultText, setResultText] = useState<string | null>(null);
    const seedRef = useRef<WorkingText | null>(null);
    const [compareSide, setCompareSide] = useState<CompareSide>('theirs');
    const [markerWarn, setMarkerWarn] = useState(false);
    const [cmFailed, setCmFailed] = useState(false);
    const [activeHunk, setActiveHunk] = useState(0);
    // Bumped only on structural Result changes (init / accept) — never per keystroke — so the
    // lazy compare surface rebuilds then, not on every character typed in the textarea.
    const [cmEpoch, setCmEpoch] = useState(0);

    const hostRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const resultRef = useRef('');
    resultRef.current = resultText ?? '';

    // Seed the Result once the sides load (mergeable text only).
    useEffect(() => {
        if (!data || !data.mergeable) return;
        if (seedRef.current !== null) return;
        const wt = toWorkingText(data.merged.content);
        seedRef.current = wt;
        setResultText(wt.working);
        // Default the compare pane to a side that is actually present (incoming first), so
        // an add/add or add/by-them conflict never opens onto a blank, unlabeled pane.
        setCompareSide(
            data.theirs.present
                ? 'theirs'
                : data.ours.present
                  ? 'ours'
                  : 'base',
        );
        setCmEpoch(e => e + 1);
    }, [data]);

    const parsed = useMemo(
        () =>
            resultText === null
                ? {
                      blocks: [] as ReadonlyArray<ConflictBlock>,
                      ambiguous: false,
                  }
                : parseConflicts(resultText),
        [resultText],
    );

    // Build the read-only CodeMirror merge compare on structural changes / side switches.
    useEffect(() => {
        if (!data || !data.mergeable || resultText === null) return;
        const host = hostRef.current;
        if (!host) return;
        let cancelled = false;
        let view: { destroy(): void } | null = null;

        void (async () => {
            try {
                const [stateMod, viewMod, mergeMod] = await Promise.all([
                    import('@codemirror/state'),
                    import('@codemirror/view'),
                    import('@codemirror/merge'),
                ]);
                if (cancelled) return;
                const dark =
                    theme === 'dark' ||
                    (typeof document !== 'undefined' &&
                        document.documentElement.classList.contains('dark'));

                const highlight = async (content: string) => {
                    const language = languageForPath(path);
                    if (!language) return [];
                    const lines = await loadShikiLines({
                        code: content,
                        language,
                        dark,
                    });
                    if (!lines) return [];
                    const probe = stateMod.EditorState.create({ doc: content });
                    const builder = new stateMod.RangeSetBuilder<
                        ReturnType<typeof viewMod.Decoration.mark>
                    >();
                    for (
                        let i = 0;
                        i < lines.length && i < probe.doc.lines;
                        i++
                    ) {
                        const docLine = probe.doc.line(i + 1);
                        let col = 0;
                        for (const token of lines[i]!) {
                            const len = token.content.length;
                            const from = docLine.from + col;
                            const to = from + len;
                            if (
                                token.color &&
                                token.content.trim().length > 0 &&
                                to <= docLine.to
                            )
                                builder.add(
                                    from,
                                    to,
                                    viewMod.Decoration.mark({
                                        attributes: {
                                            style: `color:${token.color}`,
                                        },
                                    }),
                                );
                            col += len;
                        }
                    }
                    const decorations = builder.finish();
                    const field = stateMod.StateField.define({
                        create: () => decorations,
                        update: (value: typeof decorations) => value,
                        provide: (f: unknown) =>
                            viewMod.EditorView.decorations.from(f as never),
                    });
                    return [field];
                };

                const compareContent = sideContent(data, compareSide);
                const current = resultRef.current;
                const [aHi, bHi] = await Promise.all([
                    highlight(compareContent),
                    highlight(current),
                ]);
                if (cancelled) return;

                const readOnly = [
                    viewMod.lineNumbers(),
                    viewMod.EditorView.editable.of(false),
                    stateMod.EditorState.readOnly.of(true),
                    viewMod.EditorView.theme({
                        '&': { height: '100%', fontSize: '12px' },
                        '.cm-scroller': {
                            fontFamily:
                                'var(--font-mono, ui-monospace, monospace)',
                        },
                    }),
                ];

                view = new mergeMod.MergeView({
                    a: {
                        doc: compareContent,
                        extensions: [...readOnly, ...aHi],
                    },
                    b: { doc: current, extensions: [...readOnly, ...bHi] },
                    parent: host,
                    collapseUnchanged: { margin: 3, minSize: 4 },
                    gutter: true,
                    highlightChanges: true,
                });
                setCmFailed(false);
            } catch {
                if (!cancelled) setCmFailed(true);
            }
        })();

        return () => {
            cancelled = true;
            view?.destroy();
            host.replaceChildren();
        };
        // resultText is read through resultRef; cmEpoch gates the structural rebuild.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cmEpoch, compareSide, theme, data, path]);

    const accept = (index: number, choice: AcceptChoice) => {
        if (resultText === null) return;
        setResultText(applyResolution(resultText, index, choice));
        setCmEpoch(e => e + 1);
    };

    const jumpTo = (block: ConflictBlock) => {
        const ta = textareaRef.current;
        if (!ta || resultText === null) return;
        const lines = resultText.split(LF);
        let offset = 0;
        for (let k = 0; k < block.startLine && k < lines.length; k++)
            offset += (lines[k]?.length ?? 0) + 1;
        ta.focus();
        ta.setSelectionRange(offset, offset);
        const ratio = block.startLine / Math.max(1, lines.length);
        ta.scrollTop = ratio * ta.scrollHeight;
    };

    const navHunk = (delta: number) => {
        const n = parsed.blocks.length;
        if (n === 0) return;
        const next = (((activeHunk + delta) % n) + n) % n;
        setActiveHunk(next);
        jumpTo(parsed.blocks[next]!);
    };

    const discard = () => {
        if (seedRef.current === null) return;
        setResultText(seedRef.current.working);
        setCmEpoch(e => e + 1);
    };

    const dirty =
        resultText !== null &&
        seedRef.current !== null &&
        resultText !== seedRef.current.working;

    const doSave = () => {
        if (resultText === null || seedRef.current === null) return;
        const { bom, eol } = seedRef.current;
        const content = utf8ToBase64(fromWorkingText(resultText, bom, eol));
        saveMut.mutate(
            { path, content, encoding: 'base64' },
            {
                onSuccess: () => {
                    toast.success(`Resolved ${path}`);
                    onClose();
                },
                onError: err => toast.error(String(err)),
            },
        );
    };

    const onSaveClick = () => {
        if (resultText !== null && hasConflictMarkers(resultText))
            setMarkerWarn(true);
        else doSave();
    };

    const wholeFile = (resolution: ConflictResolution) =>
        resolveMut.mutate(
            { paths: [path], resolution },
            {
                onSuccess: () => {
                    toast.success(`Resolved ${path}`);
                    onClose();
                },
                onError: err => toast.error(String(err)),
            },
        );

    const notMergeable = data !== undefined && !data.mergeable;
    const remaining = parsed.blocks.length;
    const activeClamped =
        remaining === 0 ? 0 : Math.min(activeHunk, remaining - 1);

    return (
        <Dialog
            open
            onOpenChange={open => {
                if (!open && !saveMut.isPending) onClose();
            }}
        >
            <DialogContent
                className="flex h-[85vh] w-[92vw] max-w-6xl flex-col"
                // F8 / Shift+F8 jump to the next / previous conflict hunk (REQ-UX-083).
                onKeyDown={e => {
                    if (e.key === 'F8') {
                        e.preventDefault();
                        navHunk(e.shiftKey ? -1 : 1);
                    }
                }}
            >
                <DialogHeader className="justify-between border-b px-4 py-2">
                    <div className="min-w-0">
                        <DialogTitle>Resolve conflict</DialogTitle>
                        <DialogDescription
                            className="truncate font-mono"
                            title={path}
                        >
                            {path}
                        </DialogDescription>
                    </div>
                    {data?.mergeable && !parsed.ambiguous && (
                        <div className="flex items-center gap-2 text-xs">
                            <span
                                className="text-muted-foreground"
                                aria-live="polite"
                            >
                                {remaining === 0
                                    ? 'All conflicts addressed'
                                    : `Conflict ${activeClamped + 1} of ${remaining}`}
                            </span>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={remaining === 0}
                                onClick={() => navHunk(-1)}
                                aria-label="Previous conflict"
                            >
                                Prev
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                disabled={remaining === 0}
                                onClick={() => navHunk(1)}
                                aria-label="Next conflict"
                            >
                                Next
                            </Button>
                        </div>
                    )}
                </DialogHeader>

                {sidesQ.isLoading && (
                    <div className="text-muted-foreground flex-1 p-6 text-sm">
                        Loading conflict…
                    </div>
                )}
                {sidesQ.isError && (
                    <div className="text-destructive flex-1 p-6 text-sm">
                        Could not load this conflict.
                    </div>
                )}

                {notMergeable && data && (
                    <div className="flex-1 p-6 text-sm">
                        <p className="font-medium">
                            This file can&apos;t be opened in the text merge
                            editor.
                        </p>
                        <p className="text-muted-foreground mt-1">
                            {data.reason === 'oversize'
                                ? 'It is too large to edit inline.'
                                : data.reason === 'binary'
                                  ? 'It is a binary file.'
                                  : data.reason === 'submodule'
                                    ? 'It is a submodule reference.'
                                    : 'It is not editable as text.'}{' '}
                            Resolve it by taking one whole side.
                        </p>
                        <div className="mt-4 flex gap-2">
                            <Button
                                onClick={() => wholeFile('ours')}
                                disabled={
                                    resolveMut.isPending || !data.ours.present
                                }
                            >
                                Take ours
                            </Button>
                            <Button
                                onClick={() => wholeFile('theirs')}
                                disabled={
                                    resolveMut.isPending || !data.theirs.present
                                }
                            >
                                Take theirs
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => wholeFile('base')}
                                disabled={
                                    resolveMut.isPending || !data.base.present
                                }
                            >
                                Take base
                            </Button>
                        </div>
                    </div>
                )}

                {data?.mergeable && resultText !== null && (
                    <div className="grid min-h-0 flex-1 grid-cols-2">
                        <div className="flex min-h-0 flex-col border-r">
                            <div className="bg-muted flex items-center gap-1 border-b px-2 py-1 text-[11px]">
                                <span className="text-muted-foreground mr-1">
                                    Compare:
                                </span>
                                {(['base', 'ours', 'theirs'] as const).map(
                                    side => (
                                        <button
                                            key={side}
                                            type="button"
                                            onClick={() => setCompareSide(side)}
                                            className={
                                                side === compareSide
                                                    ? 'bg-background border px-1.5'
                                                    : 'hover:bg-accent px-1.5'
                                            }
                                        >
                                            {COMPARE_LABELS[side]}
                                            {!stageOf(data, side).present
                                                ? ' (none)'
                                                : ''}
                                        </button>
                                    ),
                                )}
                            </div>
                            <div
                                ref={hostRef}
                                className="min-h-0 flex-1 overflow-auto"
                            />
                            {cmFailed && (
                                <div className="text-muted-foreground border-t p-2 text-[11px]">
                                    Side-by-side compare unavailable; edit the
                                    result directly.
                                </div>
                            )}
                        </div>

                        <div className="flex min-h-0 flex-col">
                            <div className="max-h-[40%] space-y-1.5 overflow-auto border-b p-2">
                                {parsed.ambiguous ? (
                                    <p className="text-status-behind text-xs">
                                        Conflict markers are unbalanced or
                                        nested — per-hunk actions are
                                        unavailable; edit the result as plain
                                        text and save.
                                    </p>
                                ) : remaining === 0 ? (
                                    <p className="text-muted-foreground text-xs">
                                        No remaining conflict regions. Review
                                        and save.
                                    </p>
                                ) : (
                                    parsed.blocks.map((block, i) => (
                                        <HunkActions
                                            key={`${block.startLine}:${i}`}
                                            index={i}
                                            active={i === activeClamped}
                                            hasBase={block.base !== undefined}
                                            onAccept={accept}
                                            onJump={() => {
                                                setActiveHunk(i);
                                                jumpTo(block);
                                            }}
                                        />
                                    ))
                                )}
                            </div>
                            <textarea
                                ref={textareaRef}
                                aria-label="Merged result"
                                value={resultText}
                                onChange={e => setResultText(e.target.value)}
                                onBlur={() => setCmEpoch(e => e + 1)}
                                spellCheck={false}
                                className="min-h-0 flex-1 resize-none p-2 font-mono text-xs outline-none"
                            />
                        </div>
                    </div>
                )}

                <DialogFooter className="flex-row justify-between border-t px-4 py-2">
                    <Button variant="ghost" onClick={discard} disabled={!dirty}>
                        Discard changes
                    </Button>
                    <div className="flex gap-2">
                        <Button
                            variant="ghost"
                            onClick={onClose}
                            disabled={saveMut.isPending}
                        >
                            Cancel
                        </Button>
                        {data?.mergeable && (
                            <Button
                                onClick={onSaveClick}
                                disabled={saveMut.isPending}
                            >
                                Save &amp; mark resolved
                            </Button>
                        )}
                    </div>
                </DialogFooter>
            </DialogContent>

            <AlertDialog open={markerWarn} onOpenChange={setMarkerWarn}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Conflict markers remain
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            The result still contains unresolved conflict
                            markers. Saving now writes them to the file, which
                            likely still needs attention.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogClose>Keep editing</AlertDialogClose>
                        <AlertDialogAction
                            onClick={() => {
                                setMarkerWarn(false);
                                doSave();
                            }}
                        >
                            Save anyway
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Dialog>
    );
}

interface HunkActionsProps {
    readonly index: number;
    readonly active: boolean;
    readonly hasBase: boolean;
    readonly onAccept: (index: number, choice: AcceptChoice) => void;
    readonly onJump: () => void;
}

function HunkActions({
    index,
    active,
    hasBase,
    onAccept,
    onJump,
}: HunkActionsProps) {
    return (
        <div
            className={
                active
                    ? 'bg-accent/50 flex flex-wrap items-center gap-1 rounded px-1 text-[11px]'
                    : 'flex flex-wrap items-center gap-1 rounded px-1 text-[11px]'
            }
        >
            <button
                type="button"
                onClick={onJump}
                aria-label={`Jump to conflict ${index + 1}`}
                className="text-muted-foreground mr-1 shrink-0 hover:underline"
            >
                #{index + 1}
            </button>
            <HunkButton onClick={() => onAccept(index, 'ours')}>
                Accept ours
            </HunkButton>
            <HunkButton onClick={() => onAccept(index, 'theirs')}>
                Accept theirs
            </HunkButton>
            <HunkButton onClick={() => onAccept(index, 'both')}>
                Accept both
            </HunkButton>
            <HunkButton onClick={() => onAccept(index, 'both-reversed')}>
                Accept both (reversed)
            </HunkButton>
            {hasBase && (
                <HunkButton onClick={() => onAccept(index, 'base')}>
                    Accept base
                </HunkButton>
            )}
        </div>
    );
}

function HunkButton({
    onClick,
    children,
}: {
    readonly onClick: () => void;
    readonly children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="hover:bg-accent border px-1.5 py-0.5"
        >
            {children}
        </button>
    );
}
