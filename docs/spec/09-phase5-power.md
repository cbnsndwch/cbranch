# Phase 5 — Power Features

## Purpose

Phase 5 delivers the advanced, à-la-carte capabilities that turn cbranch from a
day-to-day staging/commit/sync tool into a complete repository-management
surface. Each feature in this phase is independently shippable and independently
gated: a user can adopt interactive rebase without touching bisect, or use the
config editor without ever opening submodules.

All features in this phase obey the locked architecture:

- All operations run **on the remote host** against the real on-disk repository.
- The browser/webview is a pure view; it issues typed RPC calls and renders
  results.
- Every **mutating** operation in this phase is **serialized per repository**
  behind the repository lock, and after any mutation cbranch ensures subsequent
  reads reflect on-disk state (the filesystem watcher emits the affected domains
  on the invalidation bus — see `15-sync-protocol.md`).
- All Git operations — interactive rebase, reflog manipulation, bisect, archive,
  clean, gc, and submodule operations, as well as read-only inspection (listing
  reflog entries, reading submodule status, reading config) — are executed via the
  host `git` binary behind the single `GitEngine` interface, and MUST reflect
  on-disk truth at the moment of the call.

## User stories

- As a developer cleaning up a feature branch before opening a PR, I want to
  reorder, squash, reword, and drop commits through a visual todo list and have
  cbranch run the rebase for me, so I never hand-edit a rebase todo file in a
  terminal.
- As a developer who just lost a branch after a bad reset, I want to browse the
  reflog and recover the exact prior commit by creating a branch or resetting to
  it.
- As a developer hunting a regression, I want to drive `git bisect` from the UI,
  marking commits good/bad/skip, and see a persistent banner showing how many
  steps remain.
- As a developer preparing a release artifact, I want to export a tree or a
  specific ref as a `.zip` or `.tar` archive.
- As a developer with a messy working tree, I want a safe preview of exactly
  which untracked files and directories would be removed before I delete them.
- As a maintainer of a repository that has grown slow, I want to run repository
  maintenance (`gc`) from the UI and see when it finished.
- As a developer working in a superproject, I want to see submodule status,
  initialize/update them, sync their URLs, and add or remove submodules.
- As any user, I want to view and edit Git configuration across scopes (system /
  global / local), set my identity, choose diff/merge tools and a credential
  helper, and configure cbranch's own theme and keybindings.

## Functional requirements

REQ identifiers are stable. Each requirement is testable and describes
**observable** behavior.

### Interactive rebase

- **REQ-P5-IR-001** cbranch MUST let the user start an interactive rebase by
  selecting a base: a commit, a ref, or an upstream/“onto” target. The user
  initiates from a commit's context menu (“Rebase commits since here
  interactively…”) or from a branch/ref picker.
- **REQ-P5-IR-002** Before execution, cbranch MUST present an editable **todo
  list** of the commits in the rebase range, ordered oldest-first (the order in
  which they will be replayed), each row showing the short hash, summary line,
  and author.
- **REQ-P5-IR-003** Each todo row MUST support assigning exactly one action from
  the set: `pick`, `reword`, `edit`, `squash`, `fixup`, `drop`. The default
  action for every row is `pick`.
- **REQ-P5-IR-004** The user MUST be able to **reorder** rows (drag or
  move-up/move-down), and the final replay order MUST match the displayed order.
- **REQ-P5-IR-005** cbranch MUST validate the todo list before execution and
  block invalid plans with a clear message. At minimum: the **first** row MUST
  NOT be `squash` or `fixup` (there is no preceding commit to combine into);
  `squash`/`fixup` rows MUST have at least one preceding non-`drop` row in the
  final order.
- **REQ-P5-IR-006** When a `reword` is present, cbranch MUST collect the new
  commit message **in the UI** (a message editor dialog) before or during the
  rebase, so the rebase never blocks on an interactive terminal editor.
- **REQ-P5-IR-007** When a `squash` is present, cbranch MUST collect the combined
  commit message in the UI; the proposed default message MUST be the
  concatenation of the involved commits' messages, editable by the user.
- **REQ-P5-IR-008** cbranch MUST execute the rebase **non-interactively** by
  supplying its own scripted sequence editor and message editor to the host
  `git` process (see Git operations), so no terminal interaction is required.
- **REQ-P5-IR-009** During an `edit` stop, or any stop caused by a conflict,
  cbranch MUST surface an **in-progress rebase state** including: the current
  step number and total steps, the commit currently being applied, and whether
  the stop is due to a conflict, an `edit` action, or a `reword`/`squash` message
  request.
- **REQ-P5-IR-010** While a rebase is in progress, cbranch MUST offer
  **Continue**, **Skip**, and **Abort** actions. Continue resumes after the user
  has resolved conflicts and/or staged changes; Skip drops the current patch;
  Abort returns the repository to its pre-rebase state.
- **REQ-P5-IR-011** cbranch MUST detect an in-progress rebase that already exists
  when a repository is opened (e.g., one started outside cbranch) and present the
  same in-progress controls and state, without requiring cbranch to have started
  it.
- **REQ-P5-IR-012** On successful completion, cbranch MUST refresh the revision
  graph, the current branch tip, and any affected refs, and invalidate cached
  repository state.
- **REQ-P5-IR-013** cbranch MUST NOT auto-resolve conflicts. When a conflict
  stops the rebase, cbranch hands the user to the existing conflict-resolution
  flow (Phase 4) and only allows Continue once the index is consistent.

### Reflog viewer

- **REQ-P5-RL-001** cbranch MUST provide a reflog viewer listing entries for a
  selected ref (default `HEAD`), newest-first, each entry showing: the reflog
  selector (e.g., `HEAD@{3}`), the target commit short hash, the action label
  (e.g., `commit`, `reset`, `rebase`, `checkout`, `merge`), and the entry's
  message.
- **REQ-P5-RL-002** The viewer MUST allow selecting which ref's reflog to display
  (`HEAD` or any local branch that has a reflog).
- **REQ-P5-RL-003** From any reflog entry, the user MUST be able to **create a new
  branch** pointing at that entry's commit (prompting for a branch name).
- **REQ-P5-RL-004** From any reflog entry, the user MUST be able to **reset** the
  current branch to that entry's commit, choosing reset mode `--soft`,
  `--mixed`, or `--hard`; a `--hard` reset MUST require an explicit confirmation
  that names the consequence (working-tree changes will be discarded).
- **REQ-P5-RL-005** Selecting a reflog entry MUST be able to navigate the user to
  that commit in the revision graph / commit detail view (read-only inspection)
  without performing any mutation.
- **REQ-P5-RL-006** The reflog viewer is read-only except for the explicit
  branch-from-entry and reset-to-entry actions in REQ-P5-RL-003/004.

### Bisect

- **REQ-P5-BS-001** cbranch MUST let the user **start** a bisect session,
  optionally seeding a known-bad and a known-good commit at start time.
- **REQ-P5-BS-002** During an active bisect, cbranch MUST display a persistent
  **in-progress banner** indicating bisect is active, the commit currently
  checked out for testing, and (when available) the estimated number of
  remaining steps and revisions left to test, as reported by git.
- **REQ-P5-BS-003** cbranch MUST provide actions to mark the current revision
  **good**, **bad**, or **skip**, and after each mark MUST update the banner and
  navigate the view to the next revision git checks out.
- **REQ-P5-BS-004** When bisect identifies the first bad commit, cbranch MUST
  prominently display that commit (hash, summary, author, date) and offer to view
  it in the commit detail view.
- **REQ-P5-BS-005** cbranch MUST provide a **Reset** action that ends the bisect
  session and returns `HEAD` to its original branch/commit.
- **REQ-P5-BS-006** cbranch MUST detect a pre-existing in-progress bisect when a
  repository is opened and present the banner and controls accordingly.
- **REQ-P5-BS-007** While a bisect is active, cbranch MUST clearly indicate that
  the repository is in a detached-HEAD testing state and that branch-mutating
  operations may be unavailable or unsafe until bisect is reset.

### Archive export

- **REQ-P5-AR-001** cbranch MUST let the user export an archive of any commit,
  tag, or branch tip (a tree-ish), producing a downloadable file.
- **REQ-P5-AR-002** Supported formats MUST include at least `zip` and `tar`
  (and MAY include compressed tar variants the host git supports).
- **REQ-P5-AR-003** The user MUST be able to specify an optional path **prefix**
  to prepend inside the archive and an optional **subdirectory** of the tree-ish
  to export instead of the whole tree.
- **REQ-P5-AR-004** The archive MUST be produced on the host and delivered to the
  browser as a download; cbranch MUST NOT require the file to be written to a
  user-chosen host path (a server-side temp/stream is sufficient), but MAY offer
  saving to a host path when running in a host-trusted context.
- **REQ-P5-AR-005** The export action MUST report success with the resulting file
  name/size, or a clear error if the tree-ish is invalid.

### Clean working directory

- **REQ-P5-CL-001** cbranch MUST provide a **dry-run preview** that lists exactly
  which untracked files (and, when directory-clean is enabled, which untracked
  directories) would be removed, **before** any deletion.
- **REQ-P5-CL-002** The user MUST explicitly choose scope options before the
  destructive run: include untracked **directories**; include **ignored** files;
  and the dry-run preview MUST reflect the currently selected options.
- **REQ-P5-CL-003** The destructive clean MUST require an explicit confirmation
  that restates how many entries will be permanently deleted, and MUST only act
  on the entries shown in the most recent preview for the same options.
- **REQ-P5-CL-004** cbranch MUST NOT remove tracked files or staged changes via
  clean; clean operates only on untracked (and optionally ignored) content, per
  git's behavior.
- **REQ-P5-CL-005** After a destructive clean, cbranch MUST refresh the working
  tree status and report the number of entries removed.

### Repository maintenance (gc)

- **REQ-P5-GC-001** cbranch MUST provide a **Run maintenance (gc)** action that
  invokes housekeeping on the repository.
- **REQ-P5-GC-002** The user MUST be able to choose an **aggressive** option and
  a **prune** behavior where supported (e.g., prune-now vs. default expiry).
- **REQ-P5-GC-003** Because maintenance can be long-running, cbranch MUST show a
  busy/progress indication, keep the repository lock for the duration, and
  display completion (success or failure with the error output).
- **REQ-P5-GC-004** After completion, cbranch MUST invalidate cached repository
  state (pack layout and object reachability may have changed).

### Submodules

- **REQ-P5-SM-001** cbranch MUST list submodules with, for each: submodule path,
  the recorded (gitlink) commit, the currently checked-out commit, and a status
  indicator distinguishing: not initialized, up to date, modified/out of sync,
  and conflicted.
- **REQ-P5-SM-002** cbranch MUST provide an **Update** action per submodule and a
  bulk **Update all**, with options to initialize uninitialized submodules and to
  update **recursively** into nested submodules.
- **REQ-P5-SM-003** cbranch MUST provide a **Sync** action (per submodule and
  all) that re-applies the superproject's configured submodule URLs to the
  submodules' remotes.
- **REQ-P5-SM-004** cbranch MUST provide an **Add submodule** action collecting a
  repository URL and a destination path, optionally a branch.
- **REQ-P5-SM-005** cbranch MUST provide a **Remove submodule** action that
  deinitializes the submodule and removes it from tracking, with an explicit
  confirmation describing what will be removed.
- **REQ-P5-SM-006** A submodule whose recorded commit differs from its checked-out
  commit MUST be visibly flagged, and the user MUST be able to open that
  submodule's detail to see the differing commits.

### Settings & Git config editor

- **REQ-P5-CFG-001** cbranch MUST provide a config viewer that lists effective
  configuration keys with each key's **value** and its **origin scope/file**
  (system / global / local), so the user can see which scope a setting comes
  from.
- **REQ-P5-CFG-002** The user MUST be able to **edit** a config value and choose
  the scope to write to (global or local; system writes MAY be disallowed or
  require elevation and MUST be clearly indicated when unavailable).
- **REQ-P5-CFG-003** cbranch MUST provide guided editors for common settings:
  **user identity** (`user.name`, `user.email`), **default editor**
  (`core.editor`), **credential helper** (`credential.helper`), and **diff/merge
  tool** selection (`diff.tool`, `merge.tool` and the corresponding tool command
  configuration).
- **REQ-P5-CFG-004** cbranch MUST allow **adding** a new key/value and **deleting**
  (unsetting) a key at a chosen scope.
- **REQ-P5-CFG-005** cbranch MUST clearly separate **Git config** (written to git
  config files) from **app settings** (cbranch's own preferences), and never
  silently write app preferences into the user's git config.
- **REQ-P5-CFG-006** App settings MUST include at least: **theme** (light / dark /
  system) and **keybindings** (viewable and remappable for the documented set of
  cbranch actions), persisted per cbranch installation/profile (not in git
  config).
- **REQ-P5-CFG-007** Keybinding edits MUST detect and warn on conflicts (the same
  chord bound to two actions) and allow resetting to defaults.
- **REQ-P5-CFG-008** Editing identity, editor, credential helper, or tools MUST
  take effect for subsequent operations without requiring a repository re-open
  (cached config state refreshed after a config write).

## Git operations

The following lists the exact host `git` subcommands and flags cbranch runs and
what output it parses. cbranch always runs git in a mode that avoids interactive
prompts (e.g., setting a non-interactive environment); any operation that git
would normally route through an editor is redirected to a cbranch-supplied
scripted editor via environment variables.

### Interactive rebase

- **Start (non-interactive):** run `git rebase -i <base>` (optionally
  `git rebase -i --onto <newbase> <upstream>`) with the environment variable
  `GIT_SEQUENCE_EDITOR` set to a cbranch-provided command that writes the
  user-authored todo list (the ordered `pick`/`reword`/`edit`/`squash`/`fixup`
  and omission of `drop` lines) to the file git passes it, then exits. This makes
  the rebase fully scripted — no human edits the todo file.
- **Message capture:** set `GIT_EDITOR` (and/or `core.editor` for the invocation)
  to a cbranch-provided command so that `reword`/`squash` message prompts are
  satisfied with the message the user authored in the UI, rather than opening a
  terminal editor. Alternatively, capture the message at an `edit`/stop point and
  apply it via `git commit --amend -F <file>` / `git commit -F <file>`.
- **State inspection:** read the in-progress rebase metadata from the repository's
  rebase state (the rebase-merge/rebase-apply state directory under the git dir),
  parsing the current step number, total step count, the “onto” target, and the
  current commit. cbranch parses these as the source of truth for step X of Y and
  the current commit.
- **Continue / Skip / Abort:** `git rebase --continue`, `git rebase --skip`,
  `git rebase --abort`. Continue is offered only when the index has no unresolved
  conflicts.
- **Status corroboration:** `git status --porcelain=v2 --branch` (and/or
  `git status`) to confirm conflict presence and the rebase-in-progress flag.

### Reflog

- **List:** `git reflog show <ref>` for a parseable list; cbranch parses the
  selector (`<ref>@{n}`), the target commit, the action token, and the message.
  (Equivalently `git log -g --format=…` MAY be used to obtain stable,
  machine-parseable fields.)
- **Branch from entry:** `git branch <newname> <ref>@{n}` (or the entry's resolved
  commit hash).
- **Reset to entry:** `git reset --soft|--mixed|--hard <ref>@{n>` (or the resolved
  commit). `--hard` is gated behind explicit confirmation.

### Bisect

- **Start:** `git bisect start [<bad> [<good>...]]`.
- **Mark:** `git bisect bad`, `git bisect good`, `git bisect skip`. cbranch parses
  bisect's output for the next checked-out revision and the “first bad commit”
  determination, and reads remaining-steps/revisions-left from git's reported
  output.
- **Reset:** `git bisect reset` to end the session and restore the original HEAD.
- **State inspection:** detect an in-progress bisect from the repository's bisect
  state (presence of bisect state in the git dir) to render the banner on repo
  open.

### Archive

- **Export:** `git archive --format=<zip|tar|tar.gz> [--prefix=<prefix>/]
  <tree-ish> [<path>...]`. Output is streamed to a file; cbranch reports the file
  name and byte size. An invalid tree-ish produces a non-zero exit and a parsed
  error message.

### Clean

- **Dry run / preview:** `git clean -nd` (add `-x` to include ignored files when
  that option is selected); cbranch parses the “Would remove …” lines into the
  preview list. Directory inclusion uses `-d`.
- **Destructive:** `git clean -fd` (with `-x` when ignored-files was selected),
  acting on the previewed set; cbranch parses the “Removing …” lines and counts
  them.

### gc

- **Run:** `git gc` with optional `--aggressive` and `--prune=now` (or default
  expiry) per the user's selection. cbranch captures stdout/stderr for completion
  reporting.

### Submodules

- **Status:** `git submodule status [--recursive]`; cbranch parses the leading
  status prefix per line (` `=in sync, `-`=not initialized, `+`=checked-out commit
  differs from recorded, `U`=merge conflicts), the recorded commit, the path, and
  the described ref.
- **Update:** `git submodule update [--init] [--recursive] [-- <path>]`.
- **Sync:** `git submodule sync [--recursive] [-- <path>]`.
- **Add:** `git submodule add [-b <branch>] <url> <path>`.
- **Remove:** `git submodule deinit -f -- <path>`, then `git rm -f -- <path>`
  (and clean up the submodule's stored git dir), executed as one guarded
  operation behind confirmation.

### Config

- **List with origin:** `git config --list --show-origin` (optionally
  `--show-scope`) to display each key, value, and originating file/scope. cbranch
  parses origin tokens into system/global/local buckets.
- **Read a key:** `git config [--system|--global|--local] --get <key>`.
- **Write a key:** `git config [--global|--local] <key> <value>`.
- **Unset a key:** `git config [--global|--local] --unset <key>`.
- Identity/editor/credential/tool settings are written through the same
  `git config` write path with the appropriate keys (e.g., `user.name`,
  `user.email`, `core.editor`, `credential.helper`, `diff.tool`, `merge.tool`,
  and the relevant `difftool.<tool>.cmd` / `mergetool.<tool>.cmd`).

## UI/UX requirements

Expressed via shadcn/ui (`base-lyra` on Base UI) components and documented
interaction patterns. Visual styling is out of scope; component choice and
behavior are not.

- **Entry points:** Power features are reachable from the cmdk command palette
  (e.g., “Interactive rebase”, “Reflog”, “Bisect: start”, “Export archive”,
  “Clean working directory”, “Run maintenance”, “Submodules”, “Settings”) and
  from contextual menus (commit context menu for rebase/archive; status area for
  clean; superproject view for submodules).
- **Interactive rebase editor:** a `Dialog` (or full-height `Sheet`) containing a
  virtualized list (`@tanstack/react-virtual`) of todo rows. Each row exposes an
  action `Select`/`DropdownMenu` for the six actions, a drag handle for reorder,
  and move-up/move-down buttons as a keyboard-accessible alternative. `reword`
  and `squash` rows open a message editor (CodeMirror 6) inline or in a nested
  dialog. A validation `Alert` blocks execution while the plan is invalid. A
  primary “Start rebase” button is disabled until valid.
- **In-progress rebase / bisect / merge state:** a persistent banner region
  (using `Alert` / a sticky bar) shows the active operation, step X of Y (rebase)
  or revisions-left (bisect), and the Continue/Skip/Abort (rebase) or
  good/bad/skip/reset (bisect) actions as `Button`s. Destructive resets and abort
  use `AlertDialog` confirmations.
- **Reflog viewer:** a `Table`/virtualized list with a ref `Select` at the top;
  each row has a context `DropdownMenu` offering “Create branch here…”, “Reset to
  here…” (with a submenu or radio group for soft/mixed/hard), and “View commit”.
  Hard reset opens an `AlertDialog`.
- **Archive export:** a `Dialog` with the tree-ish (prefilled when launched from a
  commit), a format `Select` (zip/tar/…), optional prefix `Input`, optional
  subpath `Input`, and an “Export” button that triggers a browser download and a
  result `Toast`.
- **Clean:** a `Dialog` showing option `Checkbox`es (include directories; include
  ignored), a “Preview” action that fills a scrollable list of would-remove
  entries, and a destructive “Remove N entries” `Button` gated by an
  `AlertDialog`. The destructive button is disabled until a preview matching the
  current options exists.
- **gc:** a `Dialog` with an “aggressive” `Checkbox` and prune `Select`, a
  progress/busy state while running, and a completion `Toast` (or inline result).
- **Submodules:** a `Table` of submodules with status badges, per-row
  `DropdownMenu` (Update / Sync / Remove / Open) and toolbar buttons (Update all,
  Sync all, Add submodule…). Add and Remove use `Dialog`/`AlertDialog`.
- **Settings:** a settings surface with `Tabs` separating **Git config** and
  **App settings**. Git config tab includes guided sub-sections (Identity,
  Editor, Credentials, Diff/Merge tools) plus an advanced key/value `Table` with
  scope `Select` per entry and add/unset actions. App settings tab includes a
  theme `RadioGroup` (light/dark/system) and a keybindings editor (`Table` of
  action → chord with capture inputs, conflict `Alert`, and “Reset to defaults”).
- **Concurrency feedback:** while a mutating power operation holds the repository
  lock, conflicting actions are disabled with a tooltip explaining the repository
  is busy.

## Acceptance criteria

- Starting an interactive rebase from a chosen base shows a todo list of exactly
  the commits in the range, oldest-first, all defaulting to `pick`.
- Assigning `reword`/`squash` collects a message in the UI; the executed rebase
  applies that message and never blocks on a terminal editor.
- Reordering rows changes the replay order; `squash`/`fixup` in the first
  position is rejected before execution with a clear message.
- A conflict during rebase surfaces step X of Y and the conflicting commit;
  Continue is disabled until conflicts are resolved; Abort restores the
  pre-rebase tip.
- Opening a repository that already has an in-progress rebase or bisect shows the
  correct banner and controls without cbranch having initiated it.
- The reflog viewer lists entries newest-first with selector, target, action, and
  message; creating a branch from an entry produces a branch at the entry's
  commit; hard reset requires explicit confirmation and moves the branch tip.
- Bisect start/good/bad/skip advances to the next revision and updates the
  revisions-left banner; concluding identifies and displays the first bad commit;
  reset restores the original HEAD.
- Archive export of a chosen tree-ish yields a downloadable zip or tar with the
  requested prefix/subpath; an invalid tree-ish yields a clear error and no file.
- Clean preview lists the exact entries that the destructive run subsequently
  removes for the same options; tracked files are never affected.
- gc runs to completion with progress feedback and reports success or the error
  output; cached repository state is invalidated afterward.
- Submodule list shows correct per-entry status; Update/Sync/Add/Remove perform
  the corresponding git operations and refresh the list.
- The config viewer shows each key's value and origin scope; editing writes to
  the chosen scope and the new value is reflected on next read; identity/tool
  changes take effect without re-opening the repository.
- App theme and keybinding changes persist across sessions and are stored
  separately from git config.

## Edge cases & error handling

- **Rebase with no commits in range:** if the selected base equals the current
  tip (empty range), cbranch reports nothing to do and does not start a rebase.
- **Rebase onto a base that is not an ancestor / diverged history:** cbranch
  presents the `--onto` form when appropriate and surfaces git's error verbatim
  if the range is invalid.
- **Dirty working tree at rebase start:** if git refuses due to uncommitted
  changes, cbranch surfaces the message and offers to stash (deferring to the
  stash flow) or cancel; it does not silently stash.
- **`edit` stop:** cbranch must make clear the rebase is paused at an `edit`
  step (not a conflict) and that Continue will resume; it must allow the user to
  amend/add commits before continuing.
- **Abort while conflicted:** Abort must restore the original branch state even
  when the index has conflicts.
- **Reflog entry that has been pruned/expired** between listing and action:
  cbranch surfaces git's “unknown revision” error and refreshes the list.
- **Reset that would lose work (`--hard`)** is always confirmation-gated and the
  confirmation states the consequence; a `--mixed`/`--soft` reset is not
  silently upgraded to hard.
- **Bisect on a range with skips that cannot isolate a single commit:** cbranch
  surfaces git's report that multiple candidate commits remain (or that the bad
  commit could be among skipped revisions) rather than fabricating a single
  answer.
- **Bisect branch-mutating guard:** while bisecting (detached HEAD), branch
  switch/create/delete actions are blocked or warn that bisect must be reset
  first.
- **Archive of an invalid/ambiguous tree-ish** yields a clear error and produces
  no partial download; large archives stream without buffering the whole file in
  memory where feasible.
- **Clean options mismatch:** if the user changes options after previewing,
  cbranch invalidates the stale preview and requires a fresh preview before the
  destructive run.
- **Clean with nothing to remove:** the destructive button stays disabled and the
  preview states there is nothing to clean.
- **gc on a repository in a mid-operation state** (rebase/merge/bisect in
  progress) is discouraged; cbranch warns and may block until the operation is
  resolved.
- **Submodule not initialized:** Update offers `--init`; Sync/Open on an
  uninitialized submodule are disabled or prompt to initialize first.
- **Submodule with local modifications or detached commit:** flagged distinctly;
  Update that would discard local submodule changes requires confirmation.
- **Submodule remove with uncommitted superproject changes:** cbranch surfaces
  git's refusal and does not force unless the user confirms.
- **System-scope config write unavailable** (insufficient permissions): the
  scope option is disabled with an explanation; cbranch never silently writes to
  a different scope than requested.
- **Invalid config value** (e.g., malformed email or a tool command that does not
  resolve): cbranch surfaces git's error and does not report success.
- **Keybinding conflict:** assigning a chord already bound warns and requires the
  user to resolve before saving.
- **Concurrent mutation attempt:** any power operation attempted while another
  mutating operation holds the repository lock is rejected/queued with a clear
  busy indication; cbranch invalidates cached repository state after each host-git
  mutation completes.
- **Operation interrupted / process killed mid-run:** on the next status read,
  cbranch reflects the repository's actual on-disk in-progress state and presents
  the corresponding recovery controls (continue/abort/reset).

## Out of scope

- Editing rebase todo files by hand in a terminal; cbranch always scripts the
  sequence editor.
- Automatic conflict resolution during rebase, cherry-pick, or merge (conflicts
  are always resolved through the Phase 4 flow).
- Rewriting already-pushed history protections beyond surfacing git's own
  warnings (force-push policy lives with the sync feature, not here).
- Submodule features beyond status/update/sync/add/remove (e.g., bulk URL
  rewriting workflows, foreach scripting) — deferred.
- Background/scheduled maintenance and automatic gc policies — only an on-demand
  gc is in scope for this phase.
- Cross-repository or multi-repo operations; cbranch operates on one repository
  at a time.
- Editing the system-wide git installation or OS credential stores beyond writing
  the documented config keys.
