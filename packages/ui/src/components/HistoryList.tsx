import {
    HistoryColumnVisibility,
    type LogQuery,
    type Oid,
} from '@cbranch/rpc-contract';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
    type KeyboardEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { toast } from 'sonner';

import { layoutCommits, maxLaneCount } from '../graph/layout';
import { cn } from '../lib/cn';
import { commitAvatarUrls } from '../lib/avatars';
import {
    type DateMode,
    formatDate,
    formatIso,
    formatRelativeMs,
    shortOid,
} from '../lib/format';
import { findMatches, stepMatch } from '../lib/quick-find';
import { useApi } from '../rpc/ApiProvider';
import {
    useLogStream,
    useNotedObjects,
    useRepoState,
    useSetAppSettings,
    useTagList,
} from '../rpc/hooks';
import { repoScopeKey } from '../rpc/query-keys';
import { useUiStore } from '../state/store';
import { ActionMenuItems, type ActionMenuEntry } from './action-menu';
import { resolveCommitActions } from './commit-action-model';
import { DestructiveConfirmDialog } from './DestructiveConfirmDialog';
import { FindBar } from './FindBar';
import { GraphCell } from './GraphCell';
import { HistoryColumnMenu, useHistoryColumns } from './HistoryColumnMenu';
import { RefChips } from './RefChips';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuTrigger,
} from './ui/context-menu';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Placeholder } from './ui/placeholder';

const ROW_HEIGHT = 26;
const DEFAULT_PAGE = 10;
// Upper bound on how far go-to-commit will page history in before giving up (a commit
// beyond this, or not reachable in the current ref scope, is reported as not found).
const MAX_LOG_LIMIT = 100_000;

const initials = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    return (
        parts
            .map(p => p[0] ?? '')
            .join('')
            .slice(0, 2)
            .toUpperCase() || '?'
    );
};

const copyText = async (label: string, value: string) => {
    try {
        if (!navigator.clipboard?.writeText)
            throw new Error('Clipboard access is unavailable');
        await navigator.clipboard.writeText(value);
        toast.success(`${label} copied`);
    } catch (error) {
        toast.error(`Could not copy ${label.toLowerCase()}: ${String(error)}`);
    }
};

const viewAction = (
    id: string,
    label: string,
    onSelect?: () => void,
    disabledReason?: string,
): ActionMenuEntry => ({
    kind: 'action',
    id,
    label,
    onSelect,
    disabledReason,
});

function CommitAvatar({
    name,
    email,
}: {
    readonly name: string;
    readonly email: string;
}) {
    const urls = commitAvatarUrls(name, email);
    const [urlIndex, setUrlIndex] = useState(0);
    const url = urls[urlIndex];
    if (url)
        return (
            <img
                src={url}
                alt=""
                className="size-5.5 shrink-0 object-cover"
                onError={() => setUrlIndex(index => index + 1)}
            />
        );
    return (
        <div
            className="flex size-5.5 shrink-0 items-center justify-center text-[9px] font-semibold text-white"
            style={{ background: 'var(--color-status-staged)' }}
            aria-hidden="true"
        >
            {initials(name)}
        </div>
    );
}

// Virtualized streaming history (P1-HIST-1/2/3 + P1-UI-HIST-1): only visible rows render
// (NF-PERF-3); rows append as the feed streams in. The lane/edge commit graph (spec 10) is
// laid out incrementally from parent data and rendered per row in the graph cell. Dates
// honor the relative/absolute preference with the alternate available on hover (P1-HIST-8).
// Full keyboard navigation (P1-HIST-6) and a quick incremental find (P1-FILT-7) operate
// over the loaded window.
export function HistoryList({
    query,
    dateMode,
    filtersActive,
    selectedOid,
    onSelectOid,
}: {
    readonly query: LogQuery | null;
    readonly dateMode: DateMode;
    readonly filtersActive: boolean;
    readonly selectedOid: Oid | null;
    readonly onSelectOid: (oid: Oid) => void;
}) {
    const { rows, status } = useLogStream(query);
    const api = useApi();
    const queryClient = useQueryClient();
    const cols = useHistoryColumns();
    const saveColumns = useSetAppSettings();
    const repoState = useRepoState(query?.repoId ?? null).data;
    const tags = useTagList(query?.repoId ?? null).data ?? [];
    // "Show git notes" gates the per-row note indicator (REQ-P6-NOTE-003).
    const showNotes = useUiStore(s => s.showNotes);
    const repoIdForNotes = query?.repoId ?? null;
    const notedQuery = useNotedObjects(repoIdForNotes, showNotes);
    const notedOids = useMemo(
        () => new Set((notedQuery.data ?? []).map(n => n.oid)),
        [notedQuery.data],
    );
    const setKnownRefStrings = useUiStore(s => s.setKnownRefStrings);
    const setPickDialog = useUiStore(s => s.setPickDialog);
    const setArchiveDialog = useUiStore(s => s.setArchiveDialog);
    const setBisectStartDialog = useUiStore(s => s.setBisectStartDialog);
    const setRebaseDialog = useUiStore(s => s.setRebaseDialog);
    const setResetDialog = useUiStore(s => s.setResetDialog);
    const setPatchExportDialog = useUiStore(s => s.setPatchExportDialog);
    const compareBaseOid = useUiStore(s => s.compareBaseOid);
    const setCompareBaseOid = useUiStore(s => s.setCompareBaseOid);
    const setDiffComparison = useUiStore(s => s.setDiffComparison);
    const setActiveView = useUiStore(s => s.setActiveView);
    const setBranchCreate = useUiStore(s => s.setBranchCreate);
    const setTagCreateOpen = useUiStore(s => s.setTagCreateOpen);
    const setTagCreateTarget = useUiStore(s => s.setTagCreateTarget);
    const setDateMode = useUiStore(s => s.setDateMode);
    const setShowNotes = useUiStore(s => s.setShowNotes);
    const [pendingAction, setPendingAction] = useState<{
        readonly kind: 'merge' | 'checkout' | 'deleteTag';
        readonly oid: Oid;
        readonly tag?: string;
    } | null>(null);
    useEffect(() => {
        const allRefs = [...new Set(rows.flatMap(r => r.refs))];
        setKnownRefStrings(allRefs);
    }, [rows, setKnownRefStrings]);

    // Lane layout is append-only and viewport-independent, so recomputing from the streamed
    // window stays stable across scrolling (spec 10 REQ-GRAPH-008/020).
    const graphRows = useMemo(
        () =>
            layoutCommits(rows.map(r => ({ oid: r.oid, parents: r.parents }))),
        [rows],
    );
    const columns = useMemo(
        () => Math.max(1, maxLaneCount(graphRows)),
        [graphRows],
    );
    const parentRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    // Find-bar open state lives in the store so the central keybinding dispatcher
    // (App → useKeybindings, Ctrl/Cmd+F) can open it without its own window listener.
    const findOpen = useUiStore(s => s.findOpen);
    const setFindOpen = useUiStore(s => s.setFindOpen);
    const [findQuery, setFindQuery] = useState('');
    const [findPos, setFindPos] = useState(-1);
    const matches = useMemo(
        () => findMatches(rows, findQuery),
        [rows, findQuery],
    );
    const matchOids = useMemo(
        () => new Set(matches.map(i => rows[i]!.oid)),
        [matches, rows],
    );
    const currentMatchOid =
        findPos >= 0 && findPos < matches.length
            ? rows[matches[findPos]!]?.oid
            : undefined;

    const selectIndex = useCallback(
        (index: number) => {
            const row = rows[index];
            if (!row) return;
            onSelectOid(row.oid);
            virtualizer.scrollToIndex(index);
        },
        [rows, onSelectOid, virtualizer],
    );

    // Go-to-commit (REQ-P6-NAV-001): fulfil a resolved-oid request by scrolling to and
    // selecting its row, paging more history in first when the target is beyond the loaded
    // window. When the log is fully loaded and the commit still isn't present (e.g. it is
    // filtered out of the current ref scope), report it and clear the request.
    const gotoRequest = useUiStore(s => s.gotoRequest);
    const setGotoRequest = useUiStore(s => s.setGotoRequest);
    const logLimit = useUiStore(s => s.logLimit);
    const setLogLimit = useUiStore(s => s.setLogLimit);
    useEffect(() => {
        if (gotoRequest === null) return;
        const idx = rows.findIndex(r => r.oid === gotoRequest.oid);
        if (idx >= 0) {
            selectIndex(idx);
            setGotoRequest(null);
            return;
        }
        // Still streaming this window — wait for it to settle before deciding.
        if (status === 'loading' || status === 'streaming' || status === 'idle')
            return;
        // Window is capped (full page loaded) and there may be more: page in and retry.
        if (rows.length >= logLimit && logLimit < MAX_LOG_LIMIT) {
            setLogLimit(Math.min(logLimit * 2, MAX_LOG_LIMIT));
            return;
        }
        // Everything reachable is loaded and the commit isn't here — leave selection intact.
        setGotoRequest(null);
        toast.error(
            `Commit ${shortOid(gotoRequest.oid)} is not in the current history view (it may be filtered out).`,
        );
    }, [
        gotoRequest,
        rows,
        status,
        logLimit,
        selectIndex,
        setGotoRequest,
        setLogLimit,
    ]);

    // Changing any filter resets virtualization/scroll to the top of the new results (P1-FILT-8).
    const queryKey = query === null ? null : JSON.stringify(query);
    useEffect(() => {
        parentRef.current?.scrollTo({ top: 0 });
    }, [queryKey]);

    // The quick-find shortcut (Ctrl/Cmd+F, P1-UI-FILT-2) now rides the central keybinding
    // dispatcher (App → useKeybindings → setFindOpen), which is remappable (REQ-P5-CFG-006).

    // As the find query changes, jump to the first match (responsive find, P1-FILT-7).
    const firstMatch = matches[0];
    useEffect(() => {
        if (findQuery.trim() === '' || matches.length === 0) {
            setFindPos(-1);
            return;
        }
        setFindPos(0);
        if (firstMatch !== undefined) selectIndex(firstMatch);
        // selectIndex is stable per rows; intentionally keyed on the query + match set only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [findQuery, matches.length]);

    const stepFind = (direction: 1 | -1) => {
        const next = stepMatch(matches.length, findPos, direction);
        setFindPos(next);
        if (next >= 0) selectIndex(matches[next]!);
    };

    const closeFind = () => {
        setFindOpen(false);
        setFindQuery('');
        setFindPos(-1);
    };

    // Full keyboard navigation over the list (P1-HIST-6): arrows, page up/down, home/end.
    const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (
            event.key === 'ContextMenu' ||
            (event.shiftKey && event.key === 'F10')
        ) {
            const target = event.currentTarget.querySelector<HTMLElement>(
                '[role="option"][aria-selected="true"]',
            );
            if (!target) return;
            event.preventDefault();
            const rect = target.getBoundingClientRect();
            target.dispatchEvent(
                new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect.left + 12,
                    clientY: rect.top + rect.height / 2,
                }),
            );
            return;
        }
        const page = Math.max(
            1,
            Math.floor((parentRef.current?.clientHeight ?? 0) / ROW_HEIGHT) ||
                DEFAULT_PAGE,
        );
        const current =
            selectedOid === null
                ? -1
                : rows.findIndex(r => r.oid === selectedOid);
        const last = rows.length - 1;
        let next: number | null = null;
        switch (event.key) {
            case 'ArrowDown':
                next = current < 0 ? 0 : Math.min(current + 1, last);
                break;
            case 'ArrowUp':
                next = current < 0 ? 0 : Math.max(current - 1, 0);
                break;
            case 'PageDown':
                next = current < 0 ? 0 : Math.min(current + page, last);
                break;
            case 'PageUp':
                next = current < 0 ? 0 : Math.max(current - page, 0);
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = last;
                break;
            default:
                return;
        }
        event.preventDefault();
        if (next !== null) selectIndex(next);
    };

    // Target operations are resolved once and rendered by both the hover overflow and the
    // right-click adapters. This keeps labels, guards and handlers from drifting.
    const cherryPickCommit = (target: Oid, subject: string) =>
        setPickDialog({
            kind: 'cherryPick',
            commits: [{ oid: target, subject }],
        });
    const revertCommit = (target: Oid, subject: string) =>
        setPickDialog({ kind: 'revert', commits: [{ oid: target, subject }] });
    const archiveCommit = (target: Oid) =>
        setArchiveDialog({ treeish: target });
    const bisectFrom = (target: Oid) => setBisectStartDialog({ bad: target });
    const resetToCommit = (target: Oid) => setResetDialog({ target });
    // "Export patch" seeds a single-commit range (parent..commit).
    const exportPatch = (target: Oid) =>
        setPatchExportDialog({ range: `${target}~1..${target}` });
    // "Rebase commits since here" seeds the upstream to the commit's first parent, so the
    // replayed range (parent..HEAD) includes the selected commit (REQ-P5-IR-001).
    const rebaseSince = (parents: ReadonlyArray<Oid>) =>
        setRebaseDialog({ upstream: parents[0] ?? null });
    // This mode keeps the selected commit as the fixed upstream and asks which existing
    // local branch to replay; the dialog passes that branch to `git rebase -i <commit> <branch>`.
    const rebaseBranchOnto = (target: Oid) =>
        setRebaseDialog({ upstream: target, branch: null });

    const goToOid = (oid: Oid) => {
        setActiveView('history');
        setGotoRequest({ oid });
    };

    const viewActions = (): ReadonlyArray<ActionMenuEntry> => {
        const state = useUiStore.getState();
        const filters = state.filters;
        const toggleColumn = (key: keyof HistoryColumnVisibility) =>
            saveColumns.mutate({
                columns: new HistoryColumnVisibility({
                    ...cols,
                    [key]: !cols[key],
                }),
            });
        return [
            viewAction('view.showAllBranches', 'Show all branches', () =>
                state.setFilters({ ...filters, refScope: 'all' }),
            ),
            viewAction(
                'view.showCurrentBranch',
                'Show current branch only',
                () => state.setFilters({ ...filters, refScope: 'current' }),
            ),
            viewAction(
                'view.showFilteredBranches',
                'Show filtered branches',
                filters.refPattern
                    ? () =>
                          state.setFilters({ ...filters, refScope: 'pattern' })
                    : undefined,
                filters.refPattern
                    ? undefined
                    : 'Enter a ref pattern in the history filters first.',
            ),
            viewAction(
                'view.showReflog',
                'Show reflog references',
                undefined,
                'Inline reflog tips are not implemented; use the Reflog view instead.',
            ),
            { kind: 'separator', id: 'view-sep-1' },
            viewAction(
                'view.advancedFilter',
                'Advanced filter…',
                undefined,
                'The current history filter bar provides the supported filters.',
            ),
            viewAction(
                'view.drawNonRelativesGray',
                'Draw non-relatives gray',
                undefined,
                'Reachability emphasis has not been implemented.',
            ),
            viewAction(
                'view.highlightSelectedBranch',
                'Highlight selected branch',
                undefined,
                'Branch-highlight state has not been implemented.',
            ),
            { kind: 'separator', id: 'view-sep-2' },
            viewAction(
                'view.showArtificial',
                'Show artificial commits',
                undefined,
                'Artificial working/index rows are not implemented.',
            ),
            viewAction(
                'view.showStashes',
                'Show stashes',
                undefined,
                'Inline stash rows are not implemented; use the Stashes view instead.',
            ),
            viewAction(
                'view.showNotes',
                `${showNotes ? '✓ ' : ''}Show git notes`,
                () => setShowNotes(!showNotes),
            ),
            viewAction(
                'view.showRemoteBranches',
                'Show remote branches',
                undefined,
                'Ref-chip visibility state has not been implemented.',
            ),
            viewAction(
                'view.showTags',
                'Show tags',
                undefined,
                'Ref-chip visibility state has not been implemented.',
            ),
            viewAction(
                'view.showSuperprojectTags',
                'Show superproject tags',
                undefined,
                'Superproject labels are not present in the log contract.',
            ),
            viewAction(
                'view.showSuperprojectBranches',
                'Show superproject branches',
                undefined,
                'Superproject labels are not present in the log contract.',
            ),
            { kind: 'separator', id: 'view-sep-3' },
            viewAction(
                'view.showMessageBody',
                'Show commit-message body',
                undefined,
                'Bodies are available in the commit detail panel, not light log rows.',
            ),
            viewAction(
                'view.showAuthorDate',
                'Show author date',
                undefined,
                'History rows currently always show author date.',
            ),
            viewAction(
                'view.showRelativeDate',
                `${dateMode === 'relative' ? '✓ ' : ''}Show relative date`,
                () =>
                    setDateMode(
                        dateMode === 'relative' ? 'absolute' : 'relative',
                    ),
            ),
            viewAction(
                'view.showBuildStatusIcon',
                'Show build-status icon',
                undefined,
                'Build status is not present in the log contract.',
            ),
            viewAction(
                'view.showBuildStatusText',
                'Show build-status text',
                undefined,
                'Build status is not present in the log contract.',
            ),
            { kind: 'separator', id: 'view-sep-4' },
            viewAction(
                'view.showGraphColumn',
                '✓ Show revision graph column',
                undefined,
                'The revision graph is currently an always-visible core column.',
            ),
            viewAction(
                'view.showAvatarColumn',
                `${cols.avatar ? '✓ ' : ''}Show author avatar column`,
                () => toggleColumn('avatar'),
            ),
            viewAction(
                'view.showAuthorColumn',
                `${cols.authorName ? '✓ ' : ''}Show author name column`,
                () => toggleColumn('authorName'),
            ),
            viewAction(
                'view.showDateColumn',
                `${cols.date ? '✓ ' : ''}Show date column`,
                () => toggleColumn('date'),
            ),
            viewAction(
                'view.showShaColumn',
                `${cols.sha ? '✓ ' : ''}Show SHA column`,
                () => toggleColumn('sha'),
            ),
            { kind: 'separator', id: 'view-sep-5' },
            viewAction(
                'view.sortByAuthorDate',
                'Sort commits by author date',
                undefined,
                'The log contract fixes topological/date ordering.',
            ),
            viewAction(
                'view.arrangeTopo',
                '✓ Arrange by topological order',
                undefined,
                'Topological order is always enforced by the log contract.',
            ),
            viewAction(
                'view.saveAsDefault',
                'Save current view settings as default',
                undefined,
                'Column preferences are saved immediately; other view defaults are not persisted yet.',
            ),
        ];
    };

    const actionsFor = (
        row: (typeof rows)[number],
    ): ReadonlyArray<ActionMenuEntry> => {
        const child = rows.find(candidate =>
            candidate.parents.includes(row.oid),
        );
        const repoId = query?.repoId;
        const headOid = repoState?.headOid;
        const pointingTags = tags.filter(tag => tag.targetOid === row.oid);
        return resolveCommitActions({
            hasRefs: row.refs.length > 0,
            hasParent: row.parents.length > 0,
            hasChild: Boolean(child),
            baseSelected: compareBaseOid !== null,
            viewEntries: viewActions(),
            callbacks: {
                copyRefs: () =>
                    void copyText('References', row.refs.join('\n')),
                copyHash: () => void copyText('Commit hash', row.oid),
                copyMessage: repoId
                    ? () =>
                          void api
                              .commitDetail(repoId, row.oid)
                              .then(detail =>
                                  copyText('Commit message', detail.messageRaw),
                              )
                              .catch(error =>
                                  toast.error(
                                      `Could not load commit message: ${String(error)}`,
                                  ),
                              )
                    : undefined,
                copyAuthor: () =>
                    void copyText(
                        'Author',
                        `${row.authorName} <${row.authorEmail}>`,
                    ),
                copyDate: () => void copyText('Date', row.authorDate),
                merge: repoId
                    ? () => setPendingAction({ kind: 'merge', oid: row.oid })
                    : undefined,
                rebaseInteractive: () => rebaseBranchOnto(row.oid),
                resetCurrent: () => resetToCommit(row.oid),
                createBranch: () => {
                    setActiveView('branches');
                    setBranchCreate({ startPoint: row.oid });
                },
                createTag: () => {
                    setTagCreateTarget(row.oid);
                    setActiveView('tags');
                    setTagCreateOpen(true);
                },
                deleteTags: pointingTags.map(tag => ({
                    name: tag.name,
                    onSelect: () =>
                        setPendingAction({
                            kind: 'deleteTag',
                            oid: row.oid,
                            tag: tag.name,
                        }),
                })),
                checkoutDetached: repoId
                    ? () => setPendingAction({ kind: 'checkout', oid: row.oid })
                    : undefined,
                revert: () => revertCommit(row.oid, row.subject),
                cherryPick: () => cherryPickCommit(row.oid, row.subject),
                archive: () => archiveCommit(row.oid),
                bisect: () => bisectFrom(row.oid),
                rebaseSince: () => rebaseSince(row.parents),
                exportPatch: () => exportPatch(row.oid),
                compareCurrent: headOid
                    ? () => {
                          setDiffComparison({
                              base: row.oid,
                              target: headOid,
                          });
                          goToOid(headOid);
                      }
                    : undefined,
                selectBase: () => {
                    setCompareBaseOid(row.oid);
                    toast.success(`BASE set to ${shortOid(row.oid)}`);
                },
                compareBase: compareBaseOid
                    ? () => {
                          setDiffComparison({
                              base: compareBaseOid,
                              target: row.oid,
                          });
                          onSelectOid(row.oid);
                      }
                    : undefined,
                goCurrent: headOid ? () => goToOid(headOid) : undefined,
                goCommit: () => useUiStore.getState().setGoToDialogOpen(true),
                goChild: child ? () => goToOid(child.oid) : undefined,
                goParent: row.parents[0]
                    ? () => goToOid(row.parents[0]!)
                    : undefined,
                goFirstParent: row.parents[0]
                    ? () => goToOid(row.parents[0]!)
                    : undefined,
                goLastParent: row.parents.at(-1)
                    ? () => goToOid(row.parents.at(-1)!)
                    : undefined,
                quickSearch: () => setFindOpen(true),
                quickSearchPrevious: () => {
                    setFindOpen(true);
                    stepFind(-1);
                },
                quickSearchNext: () => {
                    setFindOpen(true);
                    stepFind(1);
                },
            },
        });
    };

    if (status === 'error')
        return <Placeholder tone="danger">Could not load history.</Placeholder>;

    const findBar = findOpen ? (
        <FindBar
            query={findQuery}
            matchCount={matches.length}
            current={findPos}
            onQueryChange={setFindQuery}
            onStep={stepFind}
            onClose={closeFind}
        />
    ) : null;

    if (rows.length === 0) {
        const loading = status === 'loading' || status === 'streaming';
        const message = loading
            ? 'Loading history…'
            : filtersActive
              ? 'No commits match the current filters.'
              : 'No commits yet.';
        return (
            <div className="flex h-full flex-col">
                {findBar}
                <Placeholder>{message}</Placeholder>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col">
            {findBar}
            <div className="flex shrink-0 items-center justify-end border-b px-2 py-0.5">
                <HistoryColumnMenu />
            </div>
            <div
                ref={parentRef}
                tabIndex={0}
                onKeyDown={onListKeyDown}
                role="listbox"
                aria-label="Commit history"
                className="min-h-0 flex-1 overflow-auto outline-none"
            >
                <div
                    style={{
                        height: virtualizer.getTotalSize(),
                        position: 'relative',
                        width: '100%',
                    }}
                >
                    {virtualizer.getVirtualItems().map(item => {
                        const row = rows[item.index]!;
                        const selected = row.oid === selectedOid;
                        const matched = matchOids.has(row.oid);
                        const isCurrentMatch = row.oid === currentMatchOid;
                        const date = new Date(row.authorDate);
                        const valid = !Number.isNaN(date.getTime());
                        const alternate = !valid
                            ? row.authorDate
                            : dateMode === 'relative'
                              ? formatIso(row.authorDate)
                              : formatRelativeMs(date.getTime());
                        const commitActions = actionsFor(row);
                        return (
                            <ContextMenu key={row.oid}>
                                <ContextMenuTrigger
                                    render={
                                        <div
                                            role="option"
                                            aria-selected={selected}
                                            onClick={() => onSelectOid(row.oid)}
                                            onContextMenu={() =>
                                                onSelectOid(row.oid)
                                            }
                                            className={cn(
                                                'group hover:bg-accent absolute top-0 left-0 flex w-full cursor-pointer items-center gap-2 border-b pr-2 text-xs',
                                                selected
                                                    ? 'bg-(--color-selection-bg) text-(--color-selection-fg)'
                                                    : '',
                                                matched
                                                    ? 'bg-status-ahead/10'
                                                    : '',
                                                isCurrentMatch
                                                    ? 'ring-ring ring-1 ring-inset'
                                                    : '',
                                            )}
                                            style={{
                                                height: item.size,
                                                transform: `translateY(${item.start}px)`,
                                            }}
                                        />
                                    }
                                >
                                    <GraphCell
                                        row={graphRows[item.index]!}
                                        columns={columns}
                                        height={item.size}
                                        selected={selected}
                                    />
                                    {row.refs.length > 0 ? (
                                        <RefChips refs={row.refs} />
                                    ) : null}
                                    <span className="flex-1 truncate">
                                        {showNotes &&
                                            notedOids.has(row.oid) && (
                                                <span
                                                    title="This commit has a git note"
                                                    aria-label="Has a git note"
                                                    className="text-muted-foreground mr-1"
                                                >
                                                    🗒
                                                </span>
                                            )}
                                        {row.subject}
                                    </span>
                                    {cols.avatar && (
                                        <CommitAvatar
                                            name={row.authorName}
                                            email={row.authorEmail}
                                        />
                                    )}
                                    {cols.authorName && (
                                        <span className="w-30 truncate">
                                            {row.authorName}
                                        </span>
                                    )}
                                    {cols.date && (
                                        <span
                                            className="w-27.5 truncate"
                                            title={alternate}
                                        >
                                            {formatDate(
                                                row.authorDate,
                                                dateMode,
                                            )}
                                        </span>
                                    )}
                                    {cols.sha && (
                                        <span className="w-20 font-mono">
                                            {shortOid(row.oid)}
                                        </span>
                                    )}
                                    <DropdownMenu>
                                        <DropdownMenuTrigger
                                            onClick={e => e.stopPropagation()}
                                            aria-label={`Actions for ${shortOid(row.oid)}`}
                                            className="hover:bg-accent flex size-5 shrink-0 items-center justify-center opacity-0 group-hover:opacity-100 data-popup-open:opacity-100"
                                        >
                                            …
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent
                                            side="bottom"
                                            align="end"
                                        >
                                            <ActionMenuItems
                                                entries={commitActions}
                                                surface="dropdown"
                                            />
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </ContextMenuTrigger>
                                <ContextMenuContent>
                                    <ActionMenuItems
                                        entries={commitActions}
                                        surface="context"
                                    />
                                </ContextMenuContent>
                            </ContextMenu>
                        );
                    })}
                </div>
                {status === 'streaming' || status === 'loading' ? (
                    <div className="text-muted-foreground p-2 text-center text-xs">
                        Loading more…
                    </div>
                ) : null}
            </div>
            <DestructiveConfirmDialog
                open={pendingAction !== null}
                onOpenChange={open => {
                    if (!open) setPendingAction(null);
                }}
                title={
                    pendingAction?.kind === 'checkout'
                        ? 'Checkout detached commit?'
                        : pendingAction?.kind === 'deleteTag'
                          ? 'Delete tag?'
                          : 'Merge commit into current branch?'
                }
                description={
                    pendingAction?.kind === 'checkout'
                        ? 'This checks out the selected commit in detached HEAD state. New commits will not advance a branch unless you create one.'
                        : pendingAction?.kind === 'deleteTag'
                          ? `Delete the local tag "${pendingAction.tag}" pointing at this commit? The remote tag, if any, is not changed.`
                          : 'This merges the selected revision into the current branch using fast-forward when possible.'
                }
                confirmLabel={
                    pendingAction?.kind === 'checkout'
                        ? 'Checkout detached'
                        : pendingAction?.kind === 'deleteTag'
                          ? 'Delete tag'
                          : 'Merge'
                }
                onConfirm={() => {
                    const action = pendingAction;
                    const repoId = query?.repoId;
                    if (!action || !repoId) return;
                    const operation =
                        action.kind === 'checkout'
                            ? api.branchCheckoutDetached(repoId, action.oid)
                            : action.kind === 'deleteTag' && action.tag
                              ? api.tagDelete(repoId, action.tag)
                              : api.mergeCreate(repoId, action.oid, 'ff');
                    void operation
                        .then(() => {
                            toast.success(
                                action.kind === 'checkout'
                                    ? `Checked out ${shortOid(action.oid)} (detached)`
                                    : action.kind === 'deleteTag'
                                      ? `Deleted tag ${action.tag}`
                                      : `Merged ${shortOid(action.oid)}`,
                            );
                            return queryClient.invalidateQueries({
                                queryKey: repoScopeKey(repoId),
                            });
                        })
                        .catch(error => toast.error(String(error)));
                }}
            />
        </div>
    );
}
