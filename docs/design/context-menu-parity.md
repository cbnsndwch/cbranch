# Commit and branch context-menu parity

Status: implemented inventory and capability decision for issue #5 (2026-08-29).

The commit row's hover overflow and right-click menu render one resolved action
model (`resolveCommitActions`). Branch rows likewise share
`resolveBranchActions`. A command is executable only when its handler and target
preconditions are present. An unavailable command remains visible, disabled, and
shows its reason directly in the menu row.

## Delivered actions

| Inventory area | Behavior | Existing authority reused |
| --- | --- | --- |
| Copy | Pointing refs, full hash, full commit message, author, and date | `commit.detail` for the full message; browser clipboard with failure toast; P1-DET-1 |
| Branch/ref | Merge, interactive rebase on the target, reset current branch, create branch/tag at target, delete only tags pointing at the target, detached checkout, revert, cherry-pick, archive | Existing merge RPC and branch/rebase/reset/tag/sequencer/archive dialogs; P3 UI-002, P4 REQ-UX-001, P5 IR-001/AR-001, P6 RESET-001 |
| Utilities | Bisect from target, rebase commits since target, export target patch | Existing P5/P6 dialogs |
| Compare | Select ephemeral per-repository-view BASE, compare target to BASE, compare target with HEAD in the built-in diff | Existing `commit.diff` tree-to-tree contract; BASE and active comparison are Zustand view state |
| Navigate | HEAD, go-to dialog, loaded child, first/last parent, quick search and loaded-match stepping | Existing go-to paging and find state; P6 NAV-001 and P7 NAV-002/003/004 |
| View | All/current/pattern branch scopes, notes, relative date, and persisted optional columns | Existing filters, notes/date state, and app-settings column mutation |
| Branch row | Switch, create from, merge, detached checkout, upstream, push/pull, rename, local/remote deletion, plus tip reset/rebase/tag/pick/revert/archive | The same callbacks/dialogs as the pre-existing overflow menu; one resolver supplies both surfaces |

Detached checkout retains a warning confirmation. Branch deletion and dirty-tree
discard retain their existing confirmations. All branch mutations are disabled
together while a branch/sync mutation is in flight; disabled rows state why.
Right-click selects a commit row before target actions resolve.

## Intentionally unavailable capabilities

These entries remain in the inventory with a visible explanation. They are not
decorative claims of support.

- Reset another branch needs a guarded branch-reset host contract.
- Non-interactive/advanced rebase variants and edit/reword of an arbitrary commit
  need a guarded rewrite-range workflow. Fixup/squash metadata is not accepted by
  the current commit composer. Amend remains HEAD-only.
- External difftools require an authenticated, reachable desktop companion and a
  supported launcher contract. The built-in diff is the universal path.
- Compare-to-branch needs a ref picker; compare-to-working-directory needs a
  commit-to-worktree diff contract; compare-selected needs history multi-selection.
- Artificial rows, selection back/forward history, and superproject/build-status
  labels do not exist in the current client/wire model.
- Reflog references and stash entries cannot yet be injected into the revision
  graph; their dedicated routed views remain available. The branches panel also
  lacks a programmatic ref-selection target, so "Select in branches panel" is
  visible but disabled rather than merely opening the panel without selecting.
- Common-ancestor navigation specifically awaits the read-only
  `commit.mergeBase` RPC specified by P7 NAV-005.
- Ref-chip visibility, reachability emphasis, commit-body-in-grid, arbitrary log
  sorting, and whole-view default persistence need their planned view-state/data
  work. Topological order and author-date rows remain the current fixed behavior.

This decision preserves the companion security boundary in
`11-conflict-merge-kdiff3.md`: a browser never launches a local GUI executable.
