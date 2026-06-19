# Phase 3 — Branches, Sync, Worktrees, Stash, Tags

## Purpose

Phase 3 turns cbranch from a commit-capable client (Phases 1–2) into a tool for
managing the *topology* of a repository and synchronizing it with remotes. It
adds the operations a developer performs many times a day: creating and
switching branches, keeping branches in sync with their upstreams, merging
non-conflicting work, managing remotes, juggling worktrees, parking work in
stashes, and tagging releases.

All Git operations run by invoking the host `git` binary; network synchronization
(fetch, pull, push, and remote ref deletion) uses the host's existing SSH
configuration, so that the user's real credentials, SSH keys, and
`credential.helper` settings are honored without cbranch ever handling secrets.
There is a single host-git backend behind the `GitEngine` interface; hot reads are
kept fast by a per-repo `git cat-file --batch` process pool and `--no-optional-locks`
on reads. Every mutating operation is serialized per repository under the
repository lock, and after any mutation cbranch ensures subsequent reads reflect
on-disk state (the filesystem watcher emits the affected domains on the
invalidation bus — see `15-sync-protocol.md`).

This document specifies the *observable behavior* and the exact `git`
subcommands cbranch runs. It does not prescribe internal algorithms; where an
outcome can be reached multiple ways, only the required outcome is stated.

## User stories

- As a developer, I want to see all my local and remote-tracking branches with
  their upstream and ahead/behind counts so I know what needs syncing.
- As a developer, I want to create a branch from any commit/branch/tag and
  optionally switch to it immediately.
- As a developer, I want to switch branches even when I have uncommitted
  changes, and be offered a safe choice (stash, carry, or discard) instead of a
  cryptic failure.
- As a developer, I want to rename and delete branches, including the remote
  branch, with a clear warning when a local branch is not fully merged.
- As a developer, I want to fetch, pull, and push using my host's SSH
  credentials, and when a push is rejected as non-fast-forward I want to be
  offered a pull instead of being stuck.
- As a developer, I want to add, edit, and remove remotes.
- As a developer, I want to create and switch between worktrees so I can work on
  multiple branches at once, and have cbranch re-point its active repository
  context at the chosen worktree.
- As a developer, I want to stash work (including untracked or staged-only
  changes), inspect stashes, and apply/pop/drop them.
- As a developer, I want to create lightweight, annotated, or signed tags,
  delete them locally and remotely, and push them.

## Functional requirements

Requirements use stable identifiers. Each is independently testable by observing
cbranch output or repository state.

### Branch listing

- **REQ-P3-BR-001** cbranch MUST list all local branches, each with: branch
  name, the short and full hash of its tip commit, the tip commit subject, and a
  flag indicating whether it is the currently checked-out branch (for the active
  worktree).
- **REQ-P3-BR-002** cbranch MUST list all remote-tracking branches grouped by
  remote name (e.g. `origin/…`), each with tip hash and subject.
- **REQ-P3-BR-003** For every local branch that has a configured upstream,
  cbranch MUST display the upstream ref name and the integer **ahead** and
  **behind** counts relative to that upstream (commits the local branch has that
  the upstream lacks, and vice versa).
- **REQ-P3-BR-004** For a local branch with no configured upstream, cbranch MUST
  indicate "no upstream" rather than showing zero/zero ahead-behind.
- **REQ-P3-BR-005** cbranch MUST identify and visually distinguish the symbolic
  `HEAD` state, including a detached-HEAD state, reporting the current commit
  hash when detached.
- **REQ-P3-BR-006** The branch list MUST refresh after any operation that can
  change refs (create, delete, rename, checkout, merge, fetch, pull, push) and
  MAY be refreshed on demand.

### Branch creation

- **REQ-P3-BR-010** cbranch MUST create a branch with a user-supplied name from
  a user-chosen start point: the current `HEAD`, another local branch, a
  remote-tracking branch, a tag, or an arbitrary commit hash. Default start
  point is the current `HEAD`.
- **REQ-P3-BR-011** When creating a branch, the user MUST be able to choose
  whether to also switch to it immediately.
- **REQ-P3-BR-012** When the start point is a remote-tracking branch, cbranch
  MUST offer to set that remote-tracking branch as the new branch's upstream
  (default: enabled).
- **REQ-P3-BR-013** cbranch MUST reject a branch name that Git considers invalid
  or that already exists, surfacing the reason, and MUST NOT partially create a
  branch.

### Switch / checkout

- **REQ-P3-BR-020** cbranch MUST switch the active worktree's `HEAD` to a chosen
  local branch.
- **REQ-P3-BR-021** cbranch MUST support checking out a remote-tracking branch
  by creating a local branch with the same short name tracking it (when no such
  local branch exists).
- **REQ-P3-BR-022** cbranch MUST support checking out an arbitrary commit or tag
  into a detached `HEAD`, after warning the user that the resulting state is
  detached.
- **REQ-P3-BR-023** When the working tree has uncommitted changes that would be
  overwritten by the switch, cbranch MUST detect this *before* failing
  destructively and present the user a choice of: (a) **stash** the changes,
  switch, and optionally re-apply afterward; (b) attempt to **carry** the
  changes across (only when Git can merge them cleanly into the target); or (c)
  **discard** the changes (force checkout). The user MUST explicitly confirm
  option (c).
- **REQ-P3-BR-024** If a carry attempt (option b) would itself conflict, cbranch
  MUST abort the switch leaving the working tree unchanged and report that the
  switch could not be carried, re-offering stash/discard.

### Rename

- **REQ-P3-BR-030** cbranch MUST rename a local branch to a new valid name,
  preserving its upstream configuration and reflog.
- **REQ-P3-BR-031** Renaming the currently checked-out branch MUST succeed and
  leave that branch checked out under the new name.

### Delete

- **REQ-P3-BR-040** cbranch MUST delete a local branch. If the branch is not
  fully merged into its upstream or into `HEAD`, cbranch MUST warn that commits
  may be lost and require explicit confirmation to force-delete.
- **REQ-P3-BR-041** cbranch MUST refuse to delete the branch currently checked
  out in the active worktree, and MUST refuse to delete a branch that is checked
  out in another worktree, reporting which worktree holds it.
- **REQ-P3-BR-042** cbranch MUST support deleting a branch on a remote (a remote
  ref). This is a network operation (see Sync) and MUST be confirmed separately
  from local deletion. Deleting a local branch MUST NOT implicitly delete its
  remote counterpart, and vice versa; the user chooses local, remote, or both.

### Set upstream

- **REQ-P3-BR-050** cbranch MUST set or change the upstream (tracking) ref of a
  local branch to any remote-tracking branch.
- **REQ-P3-BR-051** cbranch MUST support clearing (unsetting) a branch's
  upstream.

### Merge (simple, non-conflicting)

- **REQ-P3-MG-001** cbranch MUST merge a chosen branch/ref into the current
  branch and MUST let the user choose the strategy mode: **fast-forward when
  possible** (default), **no fast-forward** (always create a merge commit), or
  **squash** (stage the combined result without committing).
- **REQ-P3-MG-002** A fast-forward merge MUST move the current branch pointer
  without creating a merge commit and report the new tip.
- **REQ-P3-MG-003** A `--no-ff` merge MUST create a merge commit; cbranch MUST
  let the user edit the merge commit message before it is created.
- **REQ-P3-MG-004** A `--squash` merge MUST leave the combined changes staged in
  the index with no commit created, and cbranch MUST then surface the staged
  result in the commit flow (Phase 2).
- **REQ-P3-MG-005** When a merge produces conflicts, or requires a non-trivial
  multi-base/recursive resolution, cbranch MUST route the operation to the host
  `git` binary and hand the resulting conflicted state to the conflict
  resolution flow (Phase 4). cbranch MUST NOT silently auto-resolve conflicts.
- **REQ-P3-MG-006** If a `--ff-only`-style expectation cannot be met (the merge
  is not a fast-forward) and the user chose fast-forward-only, cbranch MUST
  report that a merge commit would be required and offer to re-run as `--no-ff`.
- **REQ-P3-MG-007** cbranch MUST be able to abort an in-progress merge,
  restoring the pre-merge state.

### Fetch

- **REQ-P3-SY-001** cbranch MUST fetch from a chosen remote, or from **all**
  remotes, using the host `git` binary.
- **REQ-P3-SY-002** cbranch MUST offer fetch options: **prune** deleted
  remote-tracking refs, **fetch tags**, and **fetch all remotes**.
- **REQ-P3-SY-003** After a fetch, cbranch MUST update displayed ahead/behind
  counts for affected branches.

### Pull

- **REQ-P3-SY-010** cbranch MUST pull the current branch from its upstream using
  the host `git` binary, with a user-selectable integration mode:
  **fast-forward only**, **rebase**, or **merge (no rebase)**.
- **REQ-P3-SY-011** cbranch MUST support an **autostash** option for pull so
  that a dirty working tree is stashed before and re-applied after the pull.
- **REQ-P3-SY-012** When a `--ff-only` pull cannot fast-forward, cbranch MUST
  report the divergence and offer to retry as rebase or merge.
- **REQ-P3-SY-013** When a pull (merge or rebase mode) produces conflicts,
  cbranch MUST route to the conflict flow (Phase 4) and leave the operation in
  its in-progress state for resolution or abort.

### Push

- **REQ-P3-SY-020** cbranch MUST push the current branch to a chosen remote
  using the host `git` binary.
- **REQ-P3-SY-021** When the branch has no upstream, cbranch MUST offer to
  **set upstream** as part of the push (default: enabled), choosing the remote
  and the remote branch name.
- **REQ-P3-SY-022** cbranch MUST offer a **force-with-lease** push option,
  clearly labeled as overwriting remote history only if the remote ref still
  matches what cbranch last observed. A plain unconditional force push, if
  offered at all, MUST be a separate, more strongly worded confirmation.
- **REQ-P3-SY-023** cbranch MUST offer to **push tags** (all tags, or a selected
  tag).
- **REQ-P3-SY-024** cbranch MUST support **deleting a remote branch ref** via
  push, with confirmation.
- **REQ-P3-SY-025** When a push is rejected because it is **non-fast-forward**,
  cbranch MUST detect the rejection, report it plainly, and offer to **pull**
  (rebase or merge) and retry, rather than leaving the user with a raw error.
- **REQ-P3-SY-026** cbranch MUST surface the pushed result: which refs were
  updated and their new remote tip hashes.

### Remotes CRUD

- **REQ-P3-RM-001** cbranch MUST list configured remotes with their fetch and
  push URLs.
- **REQ-P3-RM-002** cbranch MUST add a remote given a name and URL.
- **REQ-P3-RM-003** cbranch MUST change a remote's URL (fetch and/or push URL).
- **REQ-P3-RM-004** cbranch MUST rename a remote.
- **REQ-P3-RM-005** cbranch MUST remove a remote, warning that its
  remote-tracking branches and any branch upstreams pointing at it will be
  affected.

### Worktrees

- **REQ-P3-WT-001** cbranch MUST list all worktrees of the repository, each
  with: absolute path, the checked-out branch or detached commit, and flags for
  the **main** worktree, **bare**, **locked**, and **prunable** states.
- **REQ-P3-WT-002** cbranch MUST add a worktree at a user-chosen path, checking
  out an existing branch or creating a new branch in the new worktree.
- **REQ-P3-WT-003** cbranch MUST refuse to add a worktree for a branch already
  checked out in another worktree (unless the user explicitly requests the
  forced behavior Git allows), reporting the conflict.
- **REQ-P3-WT-004** cbranch MUST remove a worktree, warning and requiring
  confirmation if it contains uncommitted or untracked changes.
- **REQ-P3-WT-005** cbranch MUST prune stale worktree administrative entries
  whose working directories no longer exist.
- **REQ-P3-WT-006** cbranch MUST let the user **switch the active repository
  context** to any listed worktree. After switching, all repository views
  (branches, status, log) reflect that worktree's `HEAD` and working tree. The
  underlying repository lock is shared across worktrees of the same repository.

### Stash

- **REQ-P3-ST-001** cbranch MUST create a stash from the current working tree,
  with options: a custom **message** (`-m`), **include untracked** (`-u`),
  **keep index / keep staged** (`-k`), and **staged only** (`--staged`).
- **REQ-P3-ST-002** cbranch MUST list all stash entries with their index
  (`stash@{N}`), the branch they were created on, and their message/subject.
- **REQ-P3-ST-003** cbranch MUST show the diff/contents of a selected stash
  entry.
- **REQ-P3-ST-004** cbranch MUST **apply** a stash (keep it in the list) and
  **pop** a stash (apply then drop on success).
- **REQ-P3-ST-005** When apply/pop produces conflicts, cbranch MUST route to the
  conflict flow; for **pop**, the stash entry MUST be retained (not dropped)
  when application does not complete cleanly.
- **REQ-P3-ST-006** cbranch MUST **drop** a single stash entry (with
  confirmation) and **clear** all stash entries (with strong confirmation, since
  this is unrecoverable through normal means).

### Tags

- **REQ-P3-TG-001** cbranch MUST list all tags, distinguishing **lightweight**
  from **annotated** tags, and for annotated/signed tags show the tagger and
  message.
- **REQ-P3-TG-002** cbranch MUST create a **lightweight** tag at a chosen commit
  (default `HEAD`).
- **REQ-P3-TG-003** cbranch MUST create an **annotated** tag (`-a`) with a
  required message (`-m`).
- **REQ-P3-TG-004** cbranch MUST create a **signed** tag (`-s`) with a message,
  delegating signing to the host `git`/GPG configuration; if signing fails,
  cbranch MUST report the failure and MUST NOT create an unsigned tag silently.
- **REQ-P3-TG-005** cbranch MUST delete a tag locally (`-d`).
- **REQ-P3-TG-006** cbranch MUST delete a tag on a remote (push delete), with
  confirmation, independently of local deletion.
- **REQ-P3-TG-007** cbranch MUST push a single tag or all tags to a chosen
  remote.
- **REQ-P3-TG-008** cbranch MUST reject creating a tag whose name already exists
  unless the user explicitly requests replacement, and MUST report the conflict.

### Cross-cutting

- **REQ-P3-XC-001** Every mutating operation in this phase MUST acquire the
  per-repository lock; concurrent mutation requests MUST be serialized, and a
  request that cannot obtain the lock promptly MUST report that another
  operation is in progress rather than running in parallel.
- **REQ-P3-XC-002** After any host-`git` mutation, cbranch MUST ensure subsequent
  reads reflect the new on-disk state: the host filesystem watcher emits the
  affected domains on the invalidation bus (see `15-sync-protocol.md`) and any
  per-repo read cache (e.g. the `git cat-file --batch` pool) is refreshed.
- **REQ-P3-XC-003** All network operations (fetch/pull/push/remote-delete) MUST
  run via the host `git` binary and inherit the host environment so SSH agents
  and credential helpers function; cbranch MUST NOT prompt for or store
  passwords itself.
- **REQ-P3-XC-004** Long-running network operations MUST stream progress to the
  UI and MUST be cancelable; cancellation MUST terminate the host process and
  report the partial/aborted outcome.

## Git operations

The following lists the exact subcommands cbranch runs and what it parses. All
operations run on the single host-`git` backend behind the `GitEngine` interface;
the commands below define the authoritative behavior. Object reads are served via
the per-repo `git cat-file --batch` pool and reads pass `--no-optional-locks`.

### Listing

- Branch + tracking enumeration via porcelain ref output, e.g.
  `git for-each-ref --format=<machine-readable fields> refs/heads refs/remotes`
  parsing per-ref: full and short ref name, object name (tip hash), tip subject,
  upstream ref, and upstream ahead/behind track counts.
- Ahead/behind for an arbitrary pair MAY also be computed via
  `git rev-list --left-right --count <branch>...<upstream>` parsing the two
  integers (left = ahead, right = behind, per chosen ordering).
- Current branch / detached state via `git symbolic-ref --quiet --short HEAD`
  (empty/error => detached) and `git rev-parse HEAD` for the commit hash.

### Branch lifecycle

- Create (no switch): `git branch <name> <start-point>`.
- Create + switch: `git switch -c <name> <start-point>` (or
  `git switch --track -c <name> <remote>/<branch>` to set upstream).
- Switch existing: `git switch <branch>`; remote-tracking checkout:
  `git switch --track <remote>/<branch>` or `git switch <branch>` when a unique
  remote match exists.
- Detached checkout: `git switch --detach <commit-or-tag>`.
- Carry across switch: plain `git switch <branch>` (Git merges local changes
  when possible); force/discard: `git switch --force <branch>` (or
  `git checkout --force`). cbranch parses non-zero exit + "would be
  overwritten" / "Your local changes" messages to drive REQ-P3-BR-023.
- Rename: `git branch -m <old> <new>` (or `-m <new>` for the current branch).
- Delete local: `git branch -d <name>`; force: `git branch -D <name>` (used only
  after explicit confirmation; the safe `-d` failure with "not fully merged"
  drives the warning in REQ-P3-BR-040).
- Set upstream: `git branch --set-upstream-to=<remote>/<branch> <local>`; unset:
  `git branch --unset-upstream <local>`.

### Merge

- `git merge <ref>` (fast-forward when possible),
  `git merge --no-ff <ref>`, `git merge --squash <ref>`,
  `git merge --ff-only <ref>`. cbranch parses: "Fast-forward", "Already
  up to date", merge-commit creation, and conflict markers / non-zero exit with
  `CONFLICT` lines (=> conflict flow). Abort: `git merge --abort`.

### Sync (always host `git`)

- Fetch: `git fetch <remote>` with optional `--prune`, `--tags`, and
  `git fetch --all [--prune] [--tags]`. Progress is read from stderr.
- Pull: `git pull --ff-only`, `git pull --rebase`, or `git pull --no-rebase`,
  each optionally `--autostash`. Conflict / non-fast-forward outcomes are parsed
  from exit code and message text.
- Push: `git push <remote> <branch>`,
  `git push --set-upstream <remote> <branch>`,
  `git push --force-with-lease <remote> <branch>`,
  `git push --tags <remote>`, `git push <remote> tag <name>`,
  delete remote branch `git push <remote> --delete <branch>` (or
  `:<branch>` refspec), delete remote tag `git push <remote> --delete tag
  <name>`. cbranch parses the per-ref status lines and detects the
  `! [rejected] ... (non-fast-forward)` / `(fetch first)` condition to drive
  REQ-P3-SY-025.

### Remotes

- List: `git remote -v` (and/or `git remote get-url <name>`).
- Add: `git remote add <name> <url>`.
- Set URL: `git remote set-url <name> <url>` (and `--push` variant).
- Rename: `git remote rename <old> <new>`.
- Remove: `git remote remove <name>`.

### Worktrees

- List: `git worktree list --porcelain` parsing `worktree`, `HEAD`, `branch`,
  `bare`, `detached`, `locked`, `prunable` records.
- Add: `git worktree add <path> <branch>` or `git worktree add -b <new-branch>
  <path> <start-point>`.
- Remove: `git worktree remove <path>` (with `--force` only after confirmation
  for dirty worktrees).
- Prune: `git worktree prune`.

### Stash

- Create: `git stash push` with optional `-m <msg>`, `-u`, `-k`, `--staged`.
- List: `git stash list --format=<machine-readable>` parsing index, branch, and
  subject.
- Show: `git stash show -p <stash@{N}>`.
- Apply / pop / drop / clear: `git stash apply <ref>`, `git stash pop <ref>`,
  `git stash drop <ref>`, `git stash clear`. Conflict detection from exit code +
  `CONFLICT` lines.

### Tags

- List: `git for-each-ref refs/tags --format=<fields incl. object type, tagger,
  subject>` to distinguish lightweight vs annotated.
- Create: `git tag <name> [<commit>]` (lightweight); `git tag -a <name> -m <msg>
  [<commit>]` (annotated); `git tag -s <name> -m <msg> [<commit>]` (signed);
  replacement requires `-f`.
- Delete local: `git tag -d <name>`.
- Push: `git push <remote> <tag>` / `git push --tags <remote>`; delete remote:
  `git push <remote> --delete <tag>`.

## UI/UX requirements

Components are expressed in terms of the locked UI stack (shadcn/ui `base-lyra`
on Base UI, Tailwind v4, React 19, Lucide icons, cmdk palette, TanStack
Virtual/Query, Zustand, plus the WebSocket invalidation bus for live data — see
`15-sync-protocol.md`). No specific visual styling is mandated beyond functional
behavior.

- **REQ-P3-UI-001** A **Branches panel** lists local and remote-tracking
  branches in collapsible groups (local, then one group per remote). Rows are
  virtualized via TanStack Virtual to remain responsive with thousands of
  branches. Each local row shows name, ahead/behind as two small counters with
  directional icons, an upstream label, and a current-branch indicator.
- **REQ-P3-UI-002** Each branch row exposes a context menu (shadcn dropdown)
  with: Switch, Create branch from here, Rename, Set/Change upstream, Delete
  (local), Delete (remote), Merge into current, Push, Pull. Destructive items
  are visually marked and routed through a confirmation **AlertDialog**.
- **REQ-P3-UI-003** Branch create/rename use a **Dialog** with an input,
  inline validation of the name (disabling the confirm button on invalid/taken
  names), a start-point combobox (cmdk-style) for create, and a "switch after
  create" checkbox.
- **REQ-P3-UI-004** Switching with a dirty working tree opens a **Dialog**
  offering Stash / Carry / Discard, with Discard requiring an explicit second
  confirmation. The stash option includes a "re-apply after switch" toggle.
- **REQ-P3-UI-005** A **Sync toolbar** provides Fetch, Pull, and Push split
  buttons. Each split button's dropdown exposes its options: Fetch (remote
  selector, prune, tags, all); Pull (ff-only / rebase / merge, autostash); Push
  (set-upstream, force-with-lease, push tags). The toolbar shows the current
  branch's ahead/behind so the user knows when push/pull is meaningful.
- **REQ-P3-UI-006** Network operations show progress (Sonner toast or inline
  progress with a Cancel action) sourced from the streamed host-`git` output,
  and a final success/failure result; cancellation is always available.
- **REQ-P3-UI-007** A non-fast-forward push rejection surfaces an **AlertDialog**
  offering "Pull (rebase) and retry", "Pull (merge) and retry", or "Cancel".
- **REQ-P3-UI-008** A **Remotes manager** (Dialog or settings pane) lists
  remotes in a table with add / edit-URL / rename / remove actions, each with
  appropriate confirmation.
- **REQ-P3-UI-009** A **Worktrees panel** lists worktrees with path, branch, and
  status badges; provides Add, Remove, Prune; and a "Switch to this worktree"
  action that re-points the active repository context (the repo switcher reflects
  the active worktree).
- **REQ-P3-UI-010** A **Stash panel** lists entries with message and origin
  branch, supports preview (react-diff-view) on selection, and exposes
  Apply / Pop / Drop / Clear plus a "New stash" Dialog with the message/`-u`/
  `-k`/`--staged` options.
- **REQ-P3-UI-011** A **Tags panel/list** distinguishes lightweight vs annotated
  tags, supports a "New tag" Dialog (name, target, type lightweight/annotated/
  signed, message), and Delete (local) / Delete (remote) / Push actions.
- **REQ-P3-UI-012** All of the above actions are also reachable from the cmdk
  **command palette** (e.g. "Create branch", "Push", "Fetch all", "New tag").
- **REQ-P3-UI-013** Server state (branch list, stash list, tags, worktrees,
  ahead/behind) is managed via TanStack Query and invalidated after the relevant
  mutation; transient UI selections live in Zustand.

## Acceptance criteria

- Creating a branch from a chosen start point and toggling "switch after create"
  results in the branch existing and (if toggled) `HEAD` pointing to it; the
  branch list reflects this without a manual refresh.
- For a branch with a configured upstream that is 2 ahead and 3 behind, the UI
  shows ahead=2, behind=3; after a successful fast-forward pull the counts
  update to reflect the new relationship.
- Switching branches with a dirty working tree never silently discards changes:
  the user is always offered Stash/Carry/Discard, and choosing Discard requires a
  second confirmation.
- A `--no-ff` merge of a non-conflicting branch produces a merge commit whose
  message the user edited; a fast-forward merge produces no merge commit.
- A merge or pull that conflicts leaves the repository in a resolvable
  in-progress state and opens the conflict flow; the user can abort and return to
  the prior state.
- `Fetch all` updates every remote's tracking refs and, with prune enabled,
  removes tracking refs for branches deleted upstream.
- Pushing a branch with no upstream and "set upstream" enabled creates the remote
  branch and configures tracking; subsequent ahead/behind reflects it.
- A push rejected as non-fast-forward presents the pull-and-retry choice, and
  choosing "Pull (rebase) and retry" results in a successful push (absent
  conflicts).
- Adding a worktree for branch X, then switching the active context to it, makes
  all views show X's working tree; the original worktree is unaffected.
- Stash push with `-u` includes untracked files; the listed entry can be shown,
  applied, popped, and dropped; clearing removes all entries after strong
  confirmation.
- Creating an annotated tag with a message produces a tag carrying that message
  and tagger; deleting it locally and remotely removes both refs; pushing tags
  publishes them.

## Edge cases & error handling

- **Authentication over SSH** is delegated entirely to the host: cbranch relies
  on the host `ssh-agent`, SSH config, and `credential.helper`. If a fetch/pull/
  push fails due to authentication or host-key verification, cbranch surfaces the
  host `git`/SSH error text verbatim and does not attempt to collect credentials
  itself. Operations that would block on an interactive prompt MUST fail fast
  (the host process is invoked in a non-interactive manner) rather than hang.
- **Detached HEAD in a worktree**: switching/checkout into detached state is
  allowed but clearly labeled; committing on a detached HEAD is permitted but the
  UI warns that commits are not on any branch and offers to create a branch.
- **Branch checked out elsewhere**: deleting or force-switching a branch that is
  checked out in another worktree is refused with a message naming that worktree.
- **Stash apply/pop conflicts**: routed to the conflict flow; for pop, the stash
  is preserved if application does not complete cleanly so no work is lost.
- **Checkout would overwrite changes**: detected and converted into the
  Stash/Carry/Discard choice; cbranch never proceeds with a destructive force
  checkout without explicit confirmation.
- **Force-with-lease stale ref**: if the remote ref no longer matches the last
  observed value, the lease push is rejected; cbranch reports that the remote
  moved and suggests fetching first, and does NOT silently escalate to an
  unconditional force.
- **Non-fast-forward push**: always converted into a pull-and-retry offer
  (REQ-P3-SY-025) rather than a raw error.
- **Deleting an unmerged local branch**: the safe delete fails with "not fully
  merged"; cbranch surfaces this and only force-deletes after explicit
  confirmation.
- **Removing a remote with dependent upstreams**: cbranch warns that branch
  upstreams and tracking refs for that remote will be lost.
- **Tag name already exists**: creation is refused unless replacement is
  explicitly chosen.
- **Prunable / missing worktree directories**: surfaced as prunable; prune
  cleans only administrative entries whose directories are gone.
- **Operation already in progress**: a second mutating request reports that the
  repository is locked by another operation rather than corrupting state.
- **Network operation cancellation**: terminates the host process and reports the
  aborted state; the cache is invalidated so any partial ref updates are
  reflected.
- **Large lists**: thousands of branches/tags remain responsive via
  virtualization; ahead/behind computation for many branches is batched and MUST
  not block the UI.

## Out of scope

- Conflict resolution UI, the three-pane merge editor, and hunk-level conflict
  staging (Phase 4).
- Interactive rebase, reflog browsing, bisect, archive, clean, gc/maintenance,
  and submodules (Phase 5); only the non-interactive `--rebase` *mode* of pull is
  in scope here, and any conflicts it raises are handed to Phase 4.
- Cherry-pick, revert, blame, and file history (Phase 4).
- Staging/committing mechanics themselves (Phase 2); Phase 3 only routes squash-
  merge and post-stash results into that existing flow.
- Credential entry, SSH key management, and host-key administration (delegated to
  the host environment).
- The VSCode webview extension packaging (parallel track); requirements here are
  transport-agnostic and apply equally once that track consumes the same core.
