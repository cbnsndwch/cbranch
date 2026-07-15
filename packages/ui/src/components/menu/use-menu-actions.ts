// Capability layer for the menu (menu-hierarchy.md §"Implementation notes"). Enablement is
// driven from a single registry of wired command handlers — an item is enabled iff a handler
// exists, so unwired commands grey out without per-item conditionals. As later phases land,
// they register handlers here; the menu model and rendering stay untouched.

import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { requestDesktopUpdateCheck } from '../../desktop/DesktopUpdater';
import { isDesktopSurface } from '../../desktop/bridge';
import { useApi } from '../../rpc/ApiProvider';
import {
    useEngagementWorkspace,
    useRecentList,
    useRepoState,
} from '../../rpc/hooks';
import { repoScopeKey } from '../../rpc/query-keys';
import { useNavigation } from '../../state/navigation';
import { useUiStore } from '../../state/store';

/** Pull a human message off an unknown error (mirrors the P5 dialogs). */
const errorMessage = (error: unknown): string =>
    typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error);

export interface DynamicItem {
    readonly id: string;
    readonly label: string;
    readonly onSelect: () => void;
}

export interface MenuActions {
    /** Run a command by id (no-op if it has no wired handler). */
    readonly run: (id: string) => void;
    /** Whether a command/checkbox id has a wired handler (drives the disabled state). */
    readonly isEnabled: (id: string) => boolean;
    /** Checked state for a checkbox item, or undefined when it is not state-bound. */
    readonly checkboxState: (id: string) => boolean | undefined;
    /** Runtime-populated submenu contents, keyed by the submenu's `dynamic` tag. */
    readonly recent: ReadonlyArray<DynamicItem>;
    readonly favorites: ReadonlyArray<DynamicItem>;
}

export function useMenuActions(): MenuActions {
    const navigate = useNavigate();
    const { openRepo } = useNavigation();
    const queryClient = useQueryClient();
    const repoId = useUiStore(s => s.activeRepoId);
    const activeEngagementId = useUiStore(s => s.activeEngagementId);
    const selectedOid = useUiStore(s => s.selectedOid);
    const dateMode = useUiStore(s => s.dateMode);
    const recentQuery = useRecentList();
    const workspaceQuery = useEngagementWorkspace();
    // The Conflicts view/tab only exists while a conflict-capable op is in progress
    // (mirrors AppShell), so "Solve merge conflicts…" is gated on the same signal.
    const inProgress = useRepoState(repoId).data?.inProgress ?? 'none';
    const api = useApi();

    return useMemo(() => {
        // Settings is app-global (the App-settings tab works with no repo open); the
        // git-config tab inside it prompts to open a repository (REQ-P5-CFG-005/006). The
        // Tools and Repository entry points open the same dialog.
        const openSettings = () =>
            useUiStore.getState().setSettingsDialogOpen(true);
        // Only wired commands appear here; everything else greys out automatically.
        const handlers: Record<string, () => void> = {
            'start.open': () => useUiStore.getState().setRepoSwitcherOpen(true),
            'start.exit': () => navigate('/'),
            'repository.close': () => navigate('/'),
            // Browser-style history navigation is meaningful app-wide (no repo required).
            'navigate.back': () => navigate(-1),
            'navigate.forward': () => navigate(1),
            'help.about': () => useUiStore.getState().setAboutDialogOpen(true),
            'tools.settings': openSettings,
            // Execution remains deliberately unavailable until a supported OS sandbox
            // supervisor is installed; never offer an unsafe in-process fallback.
            'plugins.settings': () =>
                void api
                    .pluginRuntimeStatus()
                    .then(status =>
                        toast.message(
                            status.available
                                ? 'Plugin settings are not available yet'
                                : 'Plugin runtime unavailable',
                            {
                                description:
                                    status.reason ??
                                    'Installing and running plugins requires a supported sandbox runtime.',
                            },
                        ),
                    )
                    .catch(error =>
                        toast.error(
                            'Could not check plugin runtime: ' +
                                errorMessage(error),
                        ),
                    ),
            // New repository is app-global (usable with no repo open). REQ-P6-INIT-001.
            'repository.new': () =>
                useUiStore.getState().setNewRepoDialogOpen(true),
        };
        if (isDesktopSurface())
            handlers['help.checkUpdates'] = requestDesktopUpdateCheck;
        // Repo-scoped commands need an open repository.
        if (repoId) {
            handlers['repository.refresh'] = () =>
                void queryClient.invalidateQueries({
                    queryKey: repoScopeKey(repoId),
                });
            handlers['commands.stageAll'] = () =>
                void api
                    .stageFiles(repoId, [], true)
                    .then(() =>
                        queryClient.invalidateQueries({
                            queryKey: [repoId, 'status'],
                        }),
                    )
                    .catch(e =>
                        toast.error('Stage all failed: ' + errorMessage(e)),
                    );
            handlers['commands.unstageAll'] = () =>
                void api
                    .unstageFiles(repoId, [], true)
                    .then(() =>
                        queryClient.invalidateQueries({
                            queryKey: [repoId, 'status'],
                        }),
                    )
                    .catch(e =>
                        toast.error('Unstage all failed: ' + errorMessage(e)),
                    );
            // Commands → Commit… opens the dedicated commit dialog (commit-surface.md §9.4).
            handlers['commands.commit'] = () =>
                useUiStore.getState().setCommitDialogOpen(true);
            // Commands → Reset to commit… opens the reset dialog, pre-seeding the selected
            // commit as the target when one is selected, else empty (REQ-P6-RESET-001).
            handlers['commands.reset'] = () =>
                useUiStore
                    .getState()
                    .setResetDialog({ target: selectedOid ?? '' });
            // Go to commit… opens the hash/ref input (also bound to Ctrl+G). REQ-P6-NAV-001.
            handlers['navigate.goto'] = () =>
                useUiStore.getState().setGoToDialogOpen(true);
            // Undo last commit… opens the guarded soft-reset confirmation. REQ-P6-UNDO-001.
            handlers['commands.undoLastCommit'] = () =>
                useUiStore.getState().setUndoDialogOpen(true);
            // Tools → Git command log opens the routed diagnostic log view. REQ-P6-CLOG-001.
            handlers['tools.commandLog'] = () =>
                useUiStore.getState().setActiveView('commandLog');
            // Patch interchange: export a range (seeded from the selection) / apply a patch.
            handlers['commands.exportPatch'] = () =>
                useUiStore.getState().setPatchExportDialog({
                    range: selectedOid
                        ? `${selectedOid}~1..${selectedOid}`
                        : '',
                });
            handlers['commands.applyPatch'] = () =>
                useUiStore.getState().setPatchApplyDialogOpen(true);
            // Repository → metadata-file editors open the editor on a specific file. REQ-P6-META-001.
            handlers['repository.editGitignore'] = () =>
                useUiStore.getState().setMetaFileDialog('gitignore');
            handlers['repository.editGitattributes'] = () =>
                useUiStore.getState().setMetaFileDialog('gitattributes');
            handlers['repository.editMailmap'] = () =>
                useUiStore.getState().setMetaFileDialog('mailmap');
            handlers['repository.editExclude'] = () =>
                useUiStore.getState().setMetaFileDialog('info-exclude');
            // Repository → Maintenance → Compress opens the gc dialog (REQ-P5-GC-001).
            handlers['repository.maintenance.compress'] = () =>
                useUiStore.getState().setGcDialogOpen(true);
            // Commands → Clean… opens the clean-working-directory dialog (REQ-P5-CL-001).
            handlers['commands.clean'] = () =>
                useUiStore.getState().setCleanDialogOpen(true);
            // Commands → Archive revision… opens the archive dialog, pre-seeding the selected
            // commit when there is one, else empty (the user types a ref). REQ-P5-AR-001.
            handlers['commands.archive'] = () =>
                useUiStore
                    .getState()
                    .setArchiveDialog({ treeish: selectedOid ?? '' });
            // Reflog viewer is a routed view (REQ-P5-RL-001); both entry points switch to it.
            handlers['commands.reflog'] = () =>
                useUiStore.getState().setActiveView('reflog');
            handlers['view.showReflog'] = () =>
                useUiStore.getState().setActiveView('reflog');
            // Bisect: open the start dialog, pre-seeding the selected commit as bad (BS-001).
            handlers['commands.bisect'] = () =>
                useUiStore
                    .getState()
                    .setBisectStartDialog({ bad: selectedOid ?? undefined });
            // Interactive rebase: open the editor with the base picker empty so the user
            // chooses an upstream/onto ref. The commit context menu seeds it instead (IR-001).
            handlers['commands.rebase'] = () =>
                useUiStore.getState().setRebaseDialog({ upstream: null });
            // Repository → Settings / Maintenance → Edit config open the same settings dialog
            // (git-config tab is the focus from the Repository menu). REQ-P5-CFG-001/002.
            handlers['repository.settings'] = openSettings;
            handlers['repository.maintenance.editConfig'] = openSettings;
            // Routed views reachable from the menu (P3): switch the main view; the panel mounts
            // on switch and owns its in-view actions.
            handlers['repository.worktrees'] = () =>
                useUiStore.getState().setActiveView('worktrees');
            handlers['commands.stashes'] = () =>
                useUiStore.getState().setActiveView('stash');
            // "Recover lost objects…" → the reflog view is the recovery surface (REQ-P5-RL-*).
            handlers['repository.maintenance.recover'] = () =>
                useUiStore.getState().setActiveView('reflog');
            // Quick search (Ctrl+F): show history, then open the find bar over the loaded log.
            handlers['navigate.quickSearch'] = () => {
                const s = useUiStore.getState();
                s.setActiveView('history');
                s.setFindOpen(true);
            };
            // Branch lifecycle (P3). "Create branch…" has a standalone dialog (lifted to the
            // store); the row-based delete/checkout/merge actions live in the Branches view, so
            // those entries route there.
            handlers['commands.createBranch'] = () => {
                const s = useUiStore.getState();
                s.setActiveView('branches');
                s.setBranchCreate({ startPoint: 'HEAD' });
            };
            handlers['commands.deleteBranch'] = () =>
                useUiStore.getState().setActiveView('branches');
            handlers['commands.checkoutBranch'] = () =>
                useUiStore.getState().setActiveView('branches');
            handlers['commands.checkoutRevision'] = () =>
                useUiStore.getState().setActiveView('branches');
            handlers['commands.merge'] = () =>
                useUiStore.getState().setActiveView('branches');
            // Remotes manager (P3): a dialog rendered by the Branches panel — show it, then open.
            handlers['repository.remotes'] = () => {
                const s = useUiStore.getState();
                s.setActiveView('branches');
                s.setRemotesDialogOpen(true);
            };
            // Tag lifecycle (P3). "Create tag…" has a standalone dialog; "Delete tag…" is
            // row-based, so it routes to the Tags view.
            handlers['commands.createTag'] = () => {
                const s = useUiStore.getState();
                s.setActiveView('tags');
                s.setTagCreateOpen(true);
            };
            handlers['commands.deleteTag'] = () =>
                useUiStore.getState().setActiveView('tags');
            // Streaming fetch/pull/push run through the always-mounted Toolbar, which consumes
            // this one-shot request (it owns the progress toast + non-ff retry dialog).
            handlers['commands.pull'] = () =>
                useUiStore.getState().setSyncRequest('pull');
            handlers['commands.push'] = () =>
                useUiStore.getState().setSyncRequest('push');
            // Submodules: Manage opens the routed panel; Update-all / Sync-all fire the bulk
            // ops (empty paths = all) with toast feedback (REQ-P5-SM-001..003).
            handlers['repository.submodulesManage'] = () =>
                useUiStore.getState().setActiveView('submodules');
            handlers['repository.submodulesUpdateAll'] = () =>
                void api
                    .submoduleUpdate(repoId, { init: true })
                    .then(() => {
                        void queryClient.invalidateQueries({
                            queryKey: [repoId, 'status'],
                        });
                        toast.success('All submodules updated');
                    })
                    .catch(e => toast.error(errorMessage(e)));
            handlers['repository.submodulesSyncAll'] = () =>
                void api
                    .submoduleSync(repoId, {})
                    .then(() => {
                        void queryClient.invalidateQueries({
                            queryKey: [repoId, 'status'],
                        });
                        void queryClient.invalidateQueries({
                            queryKey: [repoId, 'config'],
                        });
                        toast.success('All submodules synchronized');
                    })
                    .catch(e => toast.error(errorMessage(e)));
        }
        // Cherry-pick / revert act on the selected commit (REQ-UX-001); the dialog fetches
        // the commit's subject + parents (for the merge-commit mainline gate).
        if (repoId && selectedOid) {
            handlers['commands.cherryPick'] = () =>
                useUiStore.getState().setPickDialog({
                    kind: 'cherryPick',
                    commits: [{ oid: selectedOid, subject: '' }],
                });
            handlers['commands.revert'] = () =>
                useUiStore.getState().setPickDialog({
                    kind: 'revert',
                    commits: [{ oid: selectedOid, subject: '' }],
                });
        }
        // "Solve merge conflicts…" is reachable only while a conflict-capable op is in
        // progress — the Conflicts view exists only then (mirrors AppShell's tab gating).
        if (repoId && inProgress !== 'none') {
            handlers['commands.solveConflicts'] = () =>
                useUiStore.getState().setActiveView('solveConflicts');
        }
        // Notes: edit the selected commit's note (REQ-P6-NOTE-002).
        if (repoId && selectedOid) {
            handlers['commands.editNote'] = () =>
                useUiStore.getState().setNoteEditor({ oid: selectedOid });
        }
        // State-bound checkboxes: the date column's relative/absolute mode (P1-HIST-8) and
        // the "Show git notes" indicator toggle (REQ-P6-NOTE-003).
        const showNotes = useUiStore.getState().showNotes;
        const checkboxes: Record<string, boolean> = {
            'view.showRelativeDate': dateMode === 'relative',
            'view.showNotes': showNotes,
        };
        handlers['view.showRelativeDate'] = () =>
            useUiStore
                .getState()
                .setDateMode(dateMode === 'relative' ? 'absolute' : 'relative');
        handlers['view.showNotes'] = () =>
            useUiStore
                .getState()
                .setShowNotes(!useUiStore.getState().showNotes);

        const activeEngagement = workspaceQuery.data?.engagements.find(
            engagement => engagement.id === activeEngagementId,
        );
        const recentSource = activeEngagement
            ? activeEngagement.repositories
            : (recentQuery.data ?? []);
        const recent: DynamicItem[] = recentSource.map(r => ({
            id: r.repoId,
            label: r.name,
            onSelect: () => openRepo(r.repoId, activeEngagement?.slug),
        }));

        return {
            run: id => handlers[id]?.(),
            isEnabled: id => id in handlers,
            checkboxState: id => checkboxes[id],
            recent,
            favorites: [],
        };
    }, [
        navigate,
        openRepo,
        queryClient,
        repoId,
        selectedOid,
        dateMode,
        inProgress,
        recentQuery.data,
        workspaceQuery.data,
        activeEngagementId,
        api,
    ]);
}
