import { type ActionMenuEntry } from './action-menu';

export interface BranchActionContext {
    readonly isCurrent: boolean;
    readonly isRemote: boolean;
    readonly hasRemoteTarget: boolean;
    readonly busy: boolean;
    readonly callbacks: {
        readonly switchTo: () => void;
        readonly createFrom: () => void;
        readonly merge: () => void;
        readonly checkoutDetached: () => void;
        readonly setUpstream: () => void;
        readonly push: () => void;
        readonly pull: () => void;
        readonly rename: () => void;
        readonly deleteLocal: () => void;
        readonly deleteRemote: () => void;
        readonly resetCurrent: () => void;
        readonly rebaseCurrent: () => void;
        readonly createTag: () => void;
        readonly cherryPickTip: () => void;
        readonly revertTip: () => void;
        readonly archiveTip: () => void;
    };
}

const item = (
    id: string,
    label: string,
    onSelect: (() => void) | undefined,
    disabledReason?: string,
    variant?: 'default' | 'destructive',
): ActionMenuEntry => ({
    kind: 'action',
    id,
    label,
    onSelect,
    disabledReason,
    variant,
});

/** One enablement matrix shared by a branch row's overflow and context menus. */
export const resolveBranchActions = ({
    isCurrent,
    isRemote,
    hasRemoteTarget,
    busy,
    callbacks: c,
}: BranchActionContext): ReadonlyArray<ActionMenuEntry> => {
    const busyReason = busy
        ? 'Another branch operation is in progress.'
        : undefined;
    const enabled = (callback: () => void, reason?: string) =>
        busyReason || reason ? undefined : callback;
    return [
        item(
            'branch.switch',
            'Switch to',
            enabled(
                c.switchTo,
                isCurrent
                    ? 'This is already the current branch.'
                    : isRemote
                      ? 'Create a local branch from this remote-tracking ref first.'
                      : undefined,
            ),
            busyReason ??
                (isCurrent
                    ? 'This is already the current branch.'
                    : isRemote
                      ? 'Create a local branch from this remote-tracking ref first.'
                      : undefined),
        ),
        item(
            'branch.createFrom',
            'Create branch from here',
            enabled(c.createFrom),
            busyReason,
        ),
        item(
            'branch.merge',
            'Merge into current',
            enabled(
                c.merge,
                isCurrent
                    ? 'A branch cannot be merged into itself.'
                    : undefined,
            ),
            busyReason ??
                (isCurrent
                    ? 'A branch cannot be merged into itself.'
                    : undefined),
        ),
        item(
            'branch.checkoutDetached',
            'Checkout detached',
            enabled(c.checkoutDetached),
            busyReason,
        ),
        { kind: 'separator', id: 'branch-sep-1' },
        item(
            'branch.setUpstream',
            'Set / change upstream',
            enabled(
                c.setUpstream,
                isRemote ? 'Upstreams belong to local branches.' : undefined,
            ),
            busyReason ??
                (isRemote ? 'Upstreams belong to local branches.' : undefined),
        ),
        item(
            'branch.push',
            'Push',
            enabled(
                c.push,
                isRemote
                    ? 'Push the corresponding local branch instead.'
                    : undefined,
            ),
            busyReason ??
                (isRemote
                    ? 'Push the corresponding local branch instead.'
                    : undefined),
        ),
        item(
            'branch.pull',
            'Pull',
            enabled(
                c.pull,
                !isCurrent
                    ? 'Pull is available only for the current local branch.'
                    : undefined,
            ),
            busyReason ??
                (!isCurrent
                    ? 'Pull is available only for the current local branch.'
                    : undefined),
        ),
        item(
            'branch.rename',
            'Rename',
            enabled(
                c.rename,
                isRemote
                    ? 'Remote-tracking branches cannot be renamed locally.'
                    : undefined,
            ),
            busyReason ??
                (isRemote
                    ? 'Remote-tracking branches cannot be renamed locally.'
                    : undefined),
        ),
        {
            kind: 'submenu',
            id: 'branch.tipActions',
            label: 'Tip commit actions',
            disabledReason: busyReason,
            entries: [
                item(
                    'branch.resetCurrent',
                    'Reset current branch to here…',
                    enabled(c.resetCurrent),
                    busyReason,
                ),
                item(
                    'branch.rebaseCurrent',
                    'Rebase current branch on this tip…',
                    enabled(c.rebaseCurrent),
                    busyReason,
                ),
                item(
                    'branch.createTag',
                    'Create tag here…',
                    enabled(c.createTag),
                    busyReason,
                ),
                item(
                    'branch.cherryPickTip',
                    'Cherry-pick tip commit…',
                    enabled(c.cherryPickTip),
                    busyReason,
                ),
                item(
                    'branch.revertTip',
                    'Revert tip commit…',
                    enabled(c.revertTip),
                    busyReason,
                ),
                item(
                    'branch.archiveTip',
                    'Archive tip commit…',
                    enabled(c.archiveTip),
                    busyReason,
                ),
            ],
        },
        { kind: 'separator', id: 'branch-sep-2' },
        item(
            'branch.deleteLocal',
            'Delete',
            enabled(
                c.deleteLocal,
                isRemote
                    ? 'Use Delete remote branch for this ref.'
                    : isCurrent
                      ? 'Switch away before deleting the current branch.'
                      : undefined,
            ),
            busyReason ??
                (isRemote
                    ? 'Use Delete remote branch for this ref.'
                    : isCurrent
                      ? 'Switch away before deleting the current branch.'
                      : undefined),
            'destructive',
        ),
        item(
            'branch.deleteRemote',
            'Delete remote branch',
            enabled(
                c.deleteRemote,
                hasRemoteTarget
                    ? undefined
                    : 'This branch has no remote target.',
            ),
            busyReason ??
                (hasRemoteTarget
                    ? undefined
                    : 'This branch has no remote target.'),
            'destructive',
        ),
    ];
};
