import { type ActionMenuEntry } from './action-menu';

const unavailable =
    'This command needs a Git/RPC capability that is not available in this build.';

export interface CommitActionCallbacks {
    readonly copyRefs?: () => void;
    readonly copyHash?: () => void;
    readonly copyMessage?: () => void;
    readonly copyAuthor?: () => void;
    readonly copyDate?: () => void;
    readonly merge?: () => void;
    readonly rebaseInteractive?: () => void;
    readonly resetCurrent?: () => void;
    readonly createBranch?: () => void;
    readonly createTag?: () => void;
    readonly deleteTags?: ReadonlyArray<{
        readonly name: string;
        readonly onSelect: () => void;
    }>;
    readonly checkoutDetached?: () => void;
    readonly revert?: () => void;
    readonly cherryPick?: () => void;
    readonly archive?: () => void;
    readonly bisect?: () => void;
    readonly rebaseSince?: () => void;
    readonly exportPatch?: () => void;
    readonly compareCurrent?: () => void;
    readonly selectBase?: () => void;
    readonly compareBase?: () => void;
    readonly goCurrent?: () => void;
    readonly goCommit?: () => void;
    readonly goChild?: () => void;
    readonly goParent?: () => void;
    readonly goFirstParent?: () => void;
    readonly goLastParent?: () => void;
    readonly quickSearch?: () => void;
    readonly quickSearchPrevious?: () => void;
    readonly quickSearchNext?: () => void;
    readonly revealRef?: () => void;
}

export interface CommitActionContext {
    readonly callbacks: CommitActionCallbacks;
    readonly hasRefs: boolean;
    readonly hasParent: boolean;
    readonly hasChild: boolean;
    readonly baseSelected: boolean;
    readonly viewEntries?: ReadonlyArray<ActionMenuEntry>;
}

const action = (
    id: string,
    label: string,
    onSelect: (() => void) | undefined,
    disabledReason = unavailable,
    accelerator?: string,
): ActionMenuEntry => ({
    kind: 'action',
    id,
    label,
    onSelect,
    disabledReason: onSelect ? undefined : disabledReason,
    accelerator,
});

/**
 * Resolve the complete revision-row inventory to executable or explained-disabled
 * entries. Both the hover overflow and right-click menu render this exact result.
 */
export const resolveCommitActions = ({
    callbacks: c,
    hasRefs,
    hasParent,
    hasChild,
    baseSelected,
    viewEntries = [],
}: CommitActionContext): ReadonlyArray<ActionMenuEntry> => [
    {
        kind: 'submenu',
        id: 'copy',
        label: 'Copy to clipboard',
        entries: [
            action(
                'copy.refs',
                'Pointing tag/ref names',
                hasRefs ? c.copyRefs : undefined,
                'No tag or ref points at this commit.',
            ),
            action('copy.hash', 'Full commit hash', c.copyHash),
            action('copy.message', 'Commit message', c.copyMessage),
            action('copy.author', 'Author', c.copyAuthor),
            action('copy.date', 'Date', c.copyDate),
        ],
    },
    { kind: 'separator', id: 'sep-target-1' },
    action('commands.merge', 'Merge into current branch…', c.merge),
    {
        kind: 'submenu',
        id: 'commands.rebaseCurrent',
        label: 'Rebase current branch on',
        entries: [
            action(
                'commands.rebaseCurrent.selected',
                'Selected commit',
                undefined,
                'Only the reviewed interactive rebase flow is available.',
            ),
            action(
                'commands.rebaseCurrent.interactive',
                'Selected commit interactively…',
                c.rebaseInteractive,
            ),
            action(
                'commands.rebaseCurrent.advanced',
                'Selected commit with advanced options…',
                undefined,
                'Advanced non-interactive rebase options do not have a host contract yet.',
            ),
        ],
    },
    action('commands.reset', 'Reset current branch to here…', c.resetCurrent),
    action(
        'commands.createBranch',
        'Create new branch here…',
        c.createBranch,
        unavailable,
        'Ctrl+B',
    ),
    action(
        'commands.resetOtherBranch',
        'Reset another branch to here…',
        undefined,
        'The branch-reset host contract has not been implemented.',
    ),
    action(
        'commands.createTag',
        'Create new tag here…',
        c.createTag,
        unavailable,
        'Ctrl+T',
    ),
    {
        kind: 'submenu',
        id: 'commands.deleteTag',
        label: 'Delete tag…',
        disabledReason:
            (c.deleteTags?.length ?? 0) === 0
                ? 'No tag points at this commit.'
                : undefined,
        entries: (c.deleteTags ?? []).map(tag =>
            action(`commands.deleteTag.${tag.name}`, tag.name, tag.onSelect),
        ),
    },
    { kind: 'separator', id: 'sep-target-2' },
    action(
        'commands.checkoutRevision',
        'Checkout this commit…',
        c.checkoutDetached,
    ),
    action('commands.revert', 'Revert this commit…', c.revert),
    action('commands.cherryPick', 'Cherry-pick this commit…', c.cherryPick),
    action('commands.archive', 'Archive this commit…', c.archive),
    action('commands.bisect', 'Bisect from here…', c.bisect),
    action('commands.rebaseSince', 'Rebase commits since here…', c.rebaseSince),
    action('commands.exportPatch', 'Export patch…', c.exportPatch),
    {
        kind: 'submenu',
        id: 'advanced',
        label: 'Advanced',
        entries: [
            action(
                'advanced.edit',
                'Edit commit',
                undefined,
                'Editing an arbitrary historical commit needs a guarded rewrite-range workflow.',
            ),
            action(
                'advanced.reword',
                'Reword commit',
                undefined,
                'Rewording an arbitrary historical commit needs a guarded rewrite-range workflow.',
            ),
            action(
                'advanced.fixup',
                'Create a fixup commit…',
                undefined,
                'The commit composer does not yet expose fixup metadata.',
            ),
            action(
                'advanced.squash',
                'Create a squash commit…',
                undefined,
                'The commit composer does not yet expose squash metadata.',
            ),
            action(
                'advanced.amend',
                'Create an amend commit…',
                undefined,
                'Amend is supported only for HEAD from the commit composer.',
            ),
            action(
                'advanced.help',
                'History rewriting help',
                undefined,
                'The in-app help route for history rewriting has not been added.',
            ),
        ],
    },
    {
        kind: 'submenu',
        id: 'compare',
        label: 'Compare',
        entries: [
            action(
                'compare.external',
                'Open selected commits with difftool',
                undefined,
                'External GUI tools require a reachable desktop companion; use the built-in diff.',
            ),
            action(
                'compare.branch',
                'Compare to branch…',
                undefined,
                'A branch-picker comparison surface has not been implemented.',
            ),
            action(
                'compare.current',
                'Compare with current branch',
                c.compareCurrent,
            ),
            action(
                'compare.selectBase',
                'Select as BASE to compare',
                c.selectBase,
                unavailable,
                'Ctrl+L',
            ),
            action(
                'compare.toBase',
                'Compare to BASE',
                baseSelected ? c.compareBase : undefined,
                'Select a BASE commit first.',
                'Ctrl+R',
            ),
            action(
                'compare.working',
                'Compare to working directory',
                undefined,
                'The commit-to-working-tree range is not exposed by the current diff contract.',
                'Ctrl+D',
            ),
            action(
                'compare.selected',
                'Compare selected commits',
                undefined,
                'Select exactly two commits; multi-selection is not available in the history grid.',
            ),
        ],
    },
    {
        kind: 'submenu',
        id: 'navigate',
        label: 'Navigate',
        entries: [
            action(
                'navigate.toggleArtificial',
                'Toggle between artificial and HEAD commits',
                undefined,
                'Artificial working/index rows are not implemented.',
            ),
            action(
                'navigate.goToCurrent',
                'Go to current revision',
                c.goCurrent,
            ),
            action('navigate.goToCommit', 'Go to commit…', c.goCommit),
            action(
                'navigate.goToChild',
                'Go to child commit',
                hasChild ? c.goChild : undefined,
                'No loaded child commit is available.',
            ),
            action(
                'navigate.goToParent',
                'Go to parent commit',
                hasParent ? c.goParent : undefined,
                'This commit has no parent.',
            ),
            action(
                'navigate.goToFirstParent',
                'Go to first parent commit',
                hasParent ? c.goFirstParent : undefined,
                'This commit has no parent.',
            ),
            action(
                'navigate.goToLastParent',
                'Go to last parent commit',
                hasParent ? c.goLastParent : undefined,
                'This commit has no parent.',
            ),
            action(
                'navigate.goToMergeBase',
                'Go to common ancestor (merge base)',
                undefined,
                'This needs the planned read-only commit.mergeBase RPC.',
            ),
            action(
                'navigate.back',
                'Navigate backward',
                undefined,
                'Commit-selection history is not tracked yet.',
            ),
            action(
                'navigate.forward',
                'Navigate forward',
                undefined,
                'Commit-selection history is not tracked yet.',
            ),
            action('navigate.quickSearch', 'Quick search', c.quickSearch),
            action(
                'navigate.quickSearchPrev',
                'Quick search previous',
                c.quickSearchPrevious,
            ),
            action(
                'navigate.quickSearchNext',
                'Quick search next',
                c.quickSearchNext,
            ),
        ],
    },
    action(
        'selection.revealRef',
        'Select in branches panel',
        hasRefs ? c.revealRef : undefined,
        hasRefs
            ? 'The branches panel does not expose programmatic ref selection yet.'
            : 'No branch or ref points at this commit.',
    ),
    {
        kind: 'submenu',
        id: 'view',
        label: 'View',
        entries: viewEntries,
        disabledReason:
            viewEntries.length === 0
                ? 'No view actions are available in this build.'
                : undefined,
    },
];
