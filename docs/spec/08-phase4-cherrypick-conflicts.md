# Phase 4 — Cherry-pick, Conflicts, Blame & File History

## Purpose

Phase 4 adds the operations that let a developer move individual commits between
lines of history, undo committed changes, and understand the provenance of code,
while providing a complete in-app workflow for resolving the conflicts these
operations (and the Phase 3 merge/rebase operations) can produce.

Concretely, this phase delivers four capability groups:

1. **Cherry-pick** — apply the changes introduced by one or more existing commits
   onto the current branch (single commit, contiguous range, with optional
   provenance annotation, mainline selection for merge commits, and a
   stage-without-committing mode).
2. **Revert** — create a new commit (or staged change) that undoes the changes of
   one or more existing commits.
3. **Conflict resolution** — detect conflicted paths after any merge, rebase,
   cherry-pick, or revert; resolve each path by taking one side, taking the base,
   or editing the merged result; mark paths resolved; and abort or continue the
   in-progress operation.
4. **Blame & file history** — per-line authorship for a single file with
   rename/move following and the ability to walk back to the previous revision of
   a line; and the commit history of a single path with rename following, where
   each listed revision can be diffed, viewed, or blamed.

All operations run on the remote host against the real on-disk repository. The
browser/webview is a pure view that issues typed RPC calls and renders the
results.

## User stories

- As a developer, I select a commit on another branch and apply it to my current
  branch in one action, optionally recording where it came from.
- As a developer, I select a contiguous span of commits and apply all of them in
  order, stopping if a conflict occurs so I can resolve it.
- As a developer, I cherry-pick a merge commit and choose which parent defines the
  "mainline" so the diff is taken relative to the side I want.
- As a developer, I cherry-pick a commit without committing so I can combine it
  with other staged changes before committing once.
- As a developer, I revert a commit that introduced a regression and get a new
  commit that undoes it, with an editable message.
- As a developer, when an operation stops with conflicts, I see exactly which
  files conflict and resolve each one — by taking my version, taking the incoming
  version, taking the common ancestor, or editing a merged result — then continue
  the operation.
- As a developer, if resolution becomes too messy, I abort and the repository
  returns to the state before the operation started.
- As a developer, I open blame on a file and see, per line, the commit, author,
  and date that last changed it, following the line through file renames, and I
  can jump to the state of that line one revision earlier.
- As a developer, I open the history of a single file, see every revision that
  touched it (across renames), and for any revision view its diff, its file
  content, or its blame.

## Functional requirements

Requirement identifiers are stable. "The engine" denotes the remote-host Git
orchestration layer; "the operation" denotes whichever of merge/rebase/
cherry-pick/revert is currently in progress.

### Cherry-pick

- **REQ-CP-001** — cbranch SHALL allow cherry-picking a single selected commit
  onto the current `HEAD`. On success a new commit is created on the current
  branch whose tree reflects the applied changes.
- **REQ-CP-002** — cbranch SHALL allow cherry-picking a contiguous range of
  commits selected in oldest-to-newest application order. Commits are applied in
  ancestry order (oldest first). On conflict, application stops at the offending
  commit and the conflict workflow (REQ-CN-\*) is entered.
- **REQ-CP-003** — cbranch SHALL offer an option to append a provenance line of
  the form `(cherry picked from commit <full-sha>)` to each resulting commit
  message (the `-x` behavior).
- **REQ-CP-004** — When the selected commit is a merge commit, cbranch SHALL
  require the user to choose a mainline parent number N (1-based, in parent order)
  before proceeding, and apply the change relative to that parent (the `-m N`
  behavior). For non-merge commits the mainline control is not shown.
- **REQ-CP-005** — cbranch SHALL offer a "stage without committing" option that
  applies the change(s) to the index and working tree but creates no commit (the
  `--no-commit` behavior), leaving the result staged for the user to commit
  later. For a range with this option, all commits are applied into the index in
  order without intermediate commits.
- **REQ-CP-006** — When a cherry-pick produces no changes (the change is already
  present, i.e. an empty result), cbranch SHALL surface this as a distinct,
  non-error outcome and offer to (a) skip the commit, or (b) record an empty
  commit, presenting these as explicit choices rather than silently picking one.
- **REQ-CP-007** — cbranch SHALL refuse to start a cherry-pick when the working
  tree or index has uncommitted changes that would be overwritten, reporting the
  conflicting paths, and SHALL NOT partially apply.
- **REQ-CP-008** — While a cherry-pick (or any operation) is in progress, cbranch
  SHALL serialize further mutating operations on the same repository behind the
  per-repository lock and clearly indicate that an operation is in progress.

### Revert

- **REQ-RV-001** — cbranch SHALL allow reverting a single selected commit,
  creating a new commit that undoes that commit's changes, with a default,
  user-editable message referencing the reverted commit's subject and SHA.
- **REQ-RV-002** — When reverting a merge commit, cbranch SHALL require the user
  to choose a mainline parent number N (the `-m N` behavior) before proceeding.
- **REQ-RV-003** — cbranch SHALL offer a "stage without committing" option for
  revert (`--no-commit`) that applies the inverse change to the index/working
  tree without creating a commit.
- **REQ-RV-004** — cbranch SHALL allow reverting multiple selected commits in one
  action; they are applied in the order presented, stopping on conflict.
- **REQ-RV-005** — When a revert conflicts, cbranch SHALL enter the conflict
  workflow (REQ-CN-\*); the in-progress operation is reported as a revert.

### Conflict detection & resolution

- **REQ-CN-001** — cbranch SHALL detect that an operation has stopped with
  conflicts and SHALL identify the in-progress operation type (merge, rebase,
  cherry-pick, or revert) so the correct continue/abort verbs are shown.
- **REQ-CN-002** — cbranch SHALL enumerate every conflicted path with its conflict
  classification, distinguishing at minimum: both-modified (content), added-by-us
  / added-by-them, deleted-by-us / deleted-by-them (delete/modify), and
  both-added.
- **REQ-CN-003** — For each conflicted path that has the relevant stages, cbranch
  SHALL make available the three index stages: base (stage 1, common ancestor),
  ours (stage 2, current side), and theirs (stage 3, incoming side). When a stage
  is absent (e.g. a file added on only one side has no stage 1), cbranch SHALL
  indicate the stage is not present rather than showing empty content as if it
  were a version.
- **REQ-CN-004** — cbranch SHALL let the user resolve a conflicted path by one of:
  (a) take ours, (b) take theirs, (c) take base, (d) for delete/modify, choose
  "keep the file" (the modified content) or "delete the file", or (e) open the
  3-way merge editor and produce an edited merged result. The chosen resolution
  becomes the working-tree content for that path.
- **REQ-CN-005** — cbranch SHALL let the user mark a resolved path as resolved,
  which stages it (adds the resolved content to the index, or stages the deletion
  for a delete resolution), removing it from the conflicted set.
- **REQ-CN-006** — cbranch SHALL track and display resolution progress as the count
  and list of paths still conflicted versus resolved, and SHALL only enable
  "continue" when zero paths remain conflicted (no unmerged index entries).
- **REQ-CN-007** — cbranch SHALL provide "continue the operation", which resumes
  the in-progress merge/rebase/cherry-pick/revert. For operations that create
  commits, the user MAY edit the resulting commit message before continuing.
- **REQ-CN-008** — cbranch SHALL provide "abort the operation", which returns the
  repository (HEAD, index, and tracked working-tree files) to the state before the
  operation began. Aborting SHALL be confirmed before execution.
- **REQ-CN-009** — For rebase only, cbranch SHALL additionally offer "skip the
  current commit" (skip), which drops the conflicting commit and proceeds.
- **REQ-CN-010** — cbranch SHALL parse standard conflict markers
  (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) when displaying or editing a
  conflicted text file, mapping the ours/base/theirs regions to the merge editor
  panes. The base region (`|||||||` … `=======`) is present only in diff3-style
  output and SHALL be treated as optional.
- **REQ-CN-011** — cbranch SHALL classify a conflicted path as binary when the
  content is not valid text (e.g. contains NUL bytes); for binary conflicts the
  merge editor is disabled and only take-ours / take-theirs (and take-base when
  present) resolutions are offered (see REQ-EDGE-001).
- **REQ-CN-012** — After any host-git mutation performed during the conflict
  workflow (taking a side, marking resolved, continue, abort, skip), cbranch SHALL
  invalidate cached repository state and re-derive status before updating the
  view, so displayed state always reflects on-disk reality.
- **REQ-CN-013** — The in-app 3-way merge editor used to satisfy REQ-CN-004(e) is
  specified in the conflict/merge editor section of this spec; this section
  requires only that selecting "edit" opens it pre-loaded with base/ours/theirs
  for the path and that saving its output sets the path's working-tree content.

### Blame

- **REQ-BL-001** — cbranch SHALL display, for a selected file at a selected
  revision (defaulting to the working-tree/`HEAD` version), one entry per source
  line giving at least: the commit SHA (abbreviated, with full SHA available),
  the author name, the author date, and the line's content.
- **REQ-BL-002** — Blame SHALL follow lines across file renames and movement of
  content within and between files so that authorship is attributed to the commit
  that actually introduced the line, not the rename commit (rename/move
  following).
- **REQ-BL-003** — cbranch SHALL group consecutive lines attributed to the same
  commit so each contiguous block is visually associated with one commit, while
  preserving per-line granularity for selection and navigation.
- **REQ-BL-004** — From any blamed line, cbranch SHALL allow navigating to "blame
  the previous revision of this line", re-running blame on the parent of the
  commit that currently owns the line, at that line's path and position in that
  revision. This SHALL be repeatable to walk backward through history.
- **REQ-BL-005** — Selecting a blame entry's commit SHALL allow opening that
  commit (its full message and diff) in the existing commit view.
- **REQ-BL-006** — cbranch SHALL handle large files by virtualizing the blame list
  and SHALL not block the UI while blame is computed; a pending/loading state is
  shown until results arrive.

### File history

- **REQ-FH-001** — cbranch SHALL display the commit history of a single selected
  path: the ordered list of revisions that changed that path, each showing at
  least SHA (abbreviated), author, date, and subject.
- **REQ-FH-002** — File history SHALL follow renames so revisions that touched the
  file under a former name are included; where the path changed, cbranch SHALL
  indicate the prior path for affected revisions.
- **REQ-FH-003** — For any revision in file history, cbranch SHALL offer: view the
  diff of that path introduced by that revision; view the full file content at
  that revision; and open blame for that path at that revision (linking to
  REQ-BL-001).
- **REQ-FH-004** — File history SHALL load incrementally / be paginated for files
  with long histories and SHALL not require loading the full repository history up
  front.
- **REQ-FH-005** — File history and blame SHALL be reachable from the file's
  context in the repository browser and from the diff view of a file.

## Git operations

This subsection lists the exact subcommands and flags cbranch runs on the host
`git` binary (the single backend behind the `GitEngine` interface; object reads go
through the per-repo `git cat-file --batch` pool and reads pass
`--no-optional-locks`). Output is parsed as noted. All invocations use
machine-readable flags and stable output formats.

### Cherry-pick / revert

- Single: `git cherry-pick <sha>`
- Range (oldest..newest applied in order): `git cherry-pick <a> <b> <c> …` (explicit
  list in ancestry order) or `git cherry-pick <oldest>^..<newest>`.
- Provenance: add `-x`.
- Merge mainline: add `-m <N>` (N is 1-based parent index).
- Stage only: add `--no-commit`.
- Empty result handling: detected from non-zero exit plus status; resume with
  `git cherry-pick --skip` (skip) or commit the empty change explicitly.
- Revert: `git revert <sha> [-m <N>] [--no-commit]`; multiple: list shas.
- Continue / abort / skip apply to the in-progress operation:
  - `git cherry-pick --continue` | `--abort` | `--skip`
  - `git revert --continue` | `--abort`
  - `git merge --continue` | `--abort`
  - `git rebase --continue` | `--abort` | `--skip`

cbranch determines which `--continue/--abort` family to call from the detected
in-progress operation type (REQ-CN-001).

### Status & conflict enumeration

- Primary status: `git status --porcelain=v2 --branch -z`. Unmerged entries
  (records beginning with `u`) give the conflict's stage modes and the path;
  cbranch derives the conflict classification (both-modified, added-by-us/them,
  deleted-by-us/them, both-added) from the recorded stage presence (the
  `<sub>`/XY field). NUL separation (`-z`) is used so paths with spaces or
  unusual characters parse unambiguously.
- Detailed unmerged stages when needed: `git ls-files -u -z` lists, per path, the
  present stages (1=base, 2=ours, 3=theirs) with their blob OIDs and modes;
  cbranch uses presence/absence of stages to drive REQ-CN-003 and the
  delete/modify cases.
- The presence of an in-progress operation and its type are derived from
  repository state markers (e.g. an active sequencer/rebase/merge state) reported
  by the engine; the continue/abort verb set follows from it.

### Reading the three sides

- Base: `git show :1:<path>`
- Ours: `git show :2:<path>`
- Theirs: `git show :3:<path>`

A non-zero exit / missing-stage error for any of these means that stage is not
present for the path (REQ-CN-003); cbranch treats that as "side absent", not as
empty content.

### Taking a side / marking resolved

- Take ours: `git checkout --ours -- <path>` then stage with `git add -- <path>`.
- Take theirs: `git checkout --theirs -- <path>` then `git add -- <path>`.
- Take base: write the stage-1 blob content (`git show :1:<path>`) to the working
  tree path, then `git add -- <path>`.
- Edited merged result: write the merge-editor output to the working-tree path,
  then `git add -- <path>`.
- Delete resolution (delete/modify): `git rm -- <path>` (stages the deletion).
- Mark resolved generally means the resolved content/deletion is staged so the
  path has no remaining unmerged index entry.

### Blame

- `git blame --porcelain -M -C -L <start>,<end> <rev> -- <path>` (omit `-L` for the
  whole file; `<rev>` defaults to the working-tree/HEAD view). The `--porcelain`
  output is parsed for per-line commit OID, original/final line numbers, and the
  per-commit header fields (`author`, `author-time`, `author-tz`, `summary`,
  `filename`, `previous`). `-M` follows moved lines within a file; `-C` follows
  lines copied/moved across files; rename following uses the `filename`/`previous`
  headers.
- "Blame previous revision of this line": re-run blame at the parent revision of
  the line's owning commit using the `previous <sha> <path>` header (which gives
  the prior commit and prior path) and the mapped line position.

### File history

- `git log --follow -p -z -- <path>` for history-with-diff of a single path
  following renames; or `git log --follow --format=<machine-format> -z -- <path>`
  for the revision list and `git show <rev> -- <path>` on demand for a single
  revision's diff. Rename indications come from `--follow` plus rename status in
  the diff (`R<score>` with old/new paths).
- File content at a revision: `git show <rev>:<path>`.
- Blame at a revision: the blame invocation above with the chosen `<rev>`.

All of the above — status parsing, file content, log/graph reads, the conflict
mutations, cherry-pick, revert, rebase, and blame with rename/copy following — are
performed via the host `git` binary behind the single `GitEngine` interface.

## UI/UX requirements

Components are from the project's shadcn/ui (`base-lyra` on Base UI) set with Lucide icons.

- **REQ-UX-001 (Pick/Revert launch)** — From a commit's context menu or detail
  view, "Cherry-pick…" and "Revert…" open a dialog (Dialog) summarizing the
  target commit(s). For a multi-commit selection the dialog lists them in
  application order.
- **REQ-UX-002 (Options)** — The cherry-pick dialog exposes: a Checkbox for
  "Record source (-x)", a Checkbox for "Don't commit (stage only)", and — only
  when a merge commit is selected — a Select (or numeric input) for "Mainline
  parent" populated with the commit's parents (1-based). The revert dialog exposes
  the mainline Select for merge commits and the "Don't commit" Checkbox. A primary
  Button executes; a secondary Button cancels.
- **REQ-UX-003 (In-progress banner)** — While an operation is in progress, a
  persistent banner/Alert shows the operation type (cherry-pick / revert / merge /
  rebase), progress where applicable (e.g. commit X of Y for a range/rebase), and
  the action Buttons appropriate to the operation: Continue (primary), Abort
  (destructive), and Skip (only for rebase). Continue is disabled while any path
  remains conflicted.
- **REQ-UX-004 (Conflict list)** — Conflicted paths are presented as a list
  (virtualized via the project's virtualization library for large sets), each row
  showing the path, a Badge for its conflict classification, and a status
  indicator (conflicted vs. resolved). Per-row quick actions (Buttons or a
  DropdownMenu): Take ours, Take theirs, Take base (disabled when stage 1 absent),
  and Edit (opens the 3-way merge editor); for delete/modify rows the actions are
  "Keep file" and "Delete file".
- **REQ-UX-005 (Resolution affordances)** — A row that has been resolved shows a
  resolved state and a "Mark unresolved" affordance to revert the choice before
  continuing. A summary shows "N conflicted, M resolved".
- **REQ-UX-006 (3-way editor entry)** — "Edit" opens the 3-way merge editor
  (specified elsewhere) for that path, pre-loaded with base/ours/theirs; on save,
  the row becomes resolvable/marked resolved.
- **REQ-UX-007 (Abort confirmation)** — Abort triggers an AlertDialog confirming
  that resolution progress will be discarded and the repository returns to its
  pre-operation state.
- **REQ-UX-008 (Empty cherry-pick prompt)** — When a cherry-pick yields no
  changes, a Dialog presents "Skip this commit" and "Commit anyway (empty
  commit)" as explicit choices.
- **REQ-UX-009 (Blame view)** — Blame opens a virtualized, line-aligned view: a
  gutter column showing the owning commit (abbreviated SHA + author + relative
  date) grouped by contiguous block, beside the line content. Hovering/selecting a
  block reveals a Popover/Tooltip with full SHA, full author, full date, and
  commit subject. A per-line/per-block action opens "Blame previous revision" and
  "Open commit".
- **REQ-UX-010 (File history view)** — File history opens a list of revisions
  (Table or list) with SHA, author, date, subject, and a rename indicator when the
  path changed at that revision. Selecting a revision reveals actions: View diff,
  View file at revision, and Blame at revision. The diff renders in the existing
  diff viewer; file-at-revision renders read-only in the editor component.
- **REQ-UX-011 (Loading & errors)** — Long-running reads (blame, file history)
  show a non-blocking loading state (Skeleton/spinner). Git command failures
  surface as a Toast/Alert with the captured stderr summary and do not leave the
  UI in a stale state (see REQ-CN-012).
- **REQ-UX-012 (Entry points)** — Blame and File history are reachable from a
  file's context menu in the repository browser and from the file diff view
  toolbar.

## Acceptance criteria

- **AC-1** — Cherry-picking a single non-merge commit onto a clean working tree
  creates exactly one new commit on the current branch whose changes equal the
  source commit's diff; with "-x", the message ends with the
  `(cherry picked from commit <full-sha>)` line.
- **AC-2** — Cherry-picking a range applies commits oldest-first; if commit K
  conflicts, commits before K are committed, K is left in conflict, and the
  in-progress banner shows the cherry-pick with K as the current commit.
- **AC-3** — Cherry-picking a merge commit without choosing a mainline is not
  allowed; once a mainline N is chosen, the applied diff is relative to parent N.
- **AC-4** — Cherry-pick with "stage only" produces no commit; the changes appear
  staged in the status view.
- **AC-5** — Reverting a commit creates a new commit whose application of the diff
  cancels the original; reverting a merge requires and honors the mainline choice.
- **AC-6** — After a conflicting operation, every conflicted path appears in the
  conflict list with a correct classification derived from
  `status --porcelain=v2` / `ls-files -u`.
- **AC-7** — Take ours / take theirs / take base each set the path's working-tree
  content to the corresponding side and, after "mark resolved", remove the path
  from the unmerged set (no stage entries remain).
- **AC-8** — "Continue" is disabled until zero paths remain conflicted; invoking
  it resumes and completes the operation, optionally with an edited commit
  message.
- **AC-9** — "Abort" returns HEAD, index, and tracked files to the pre-operation
  state, confirmed via an AlertDialog first.
- **AC-10** — For rebase conflicts, a "Skip" action is offered and drops the
  current commit; for non-rebase operations no Skip action is shown.
- **AC-11** — Blame on a file shows one commit attribution per line, groups
  contiguous same-commit lines, and attributes lines moved via a rename to the
  introducing commit (verified by a file that was renamed in history).
- **AC-12** — "Blame previous revision" on a selected line re-blames the parent of
  the owning commit at the correct prior path and position and is repeatable.
- **AC-13** — File history of a renamed file includes revisions under its former
  name and indicates the prior path; each revision offers diff, file-at-revision,
  and blame-at-revision.
- **AC-14** — After any conflict-workflow mutation, the displayed status matches a
  freshly computed `git status` (cache invalidated).

## Edge cases & error handling

- **REQ-EDGE-001 (Binary conflicts)** — When a conflicted blob is binary
  (NUL-containing or otherwise non-text), the merge editor is disabled; only take-
  ours / take-theirs (and take-base if stage 1 exists) are offered, with a clear
  note that the file is binary and cannot be merged line-by-line.
- **REQ-EDGE-002 (Delete/modify)** — For deleted-by-us / deleted-by-them, cbranch
  presents "Keep the modified file" vs. "Delete the file" rather than ours/theirs
  content panes, since one side has no content. Choosing keep stages the content;
  choosing delete runs `git rm`.
- **REQ-EDGE-003 (Both-added / no base)** — When stage 1 (base) is absent (e.g.
  both-added), the take-base action is disabled and the merge editor opens with an
  empty/absent base pane; ours and theirs are still selectable.
- **REQ-EDGE-004 (Conflict-marker parsing)** — cbranch SHALL robustly parse files
  whose markers are diff3-style (with `|||||||` base section) and plain 2-way (no
  base section), and SHALL not misparse legitimate file content that resembles a
  marker only when it is not at the start of a line / not a full marker run; if
  marker structure is ambiguous or unbalanced, cbranch SHALL fall back to treating
  the file as plain text for manual editing and warn the user.
- **REQ-EDGE-005 (Empty / already-applied)** — A cherry-pick or revert that
  results in no change is reported as the empty outcome (REQ-CP-006 / REQ-UX-008),
  never as a silent success or a hard error.
- **REQ-EDGE-006 (Dirty working tree)** — Starting cherry-pick/revert with
  overwrite-conflicting local changes is refused up front with the offending paths
  listed; the user is advised to stash or commit first (stash being a Phase 3
  capability).
- **REQ-EDGE-007 (Operation already in progress)** — If an operation is already in
  progress, starting another is blocked by the per-repository lock; the UI directs
  the user to the in-progress banner to continue or abort first.
- **REQ-EDGE-008 (Concurrent external mutation)** — If the on-disk state changed
  outside cbranch (detected on cache invalidation/refresh), cbranch SHALL re-derive
  status and reconcile the conflict view rather than acting on stale data; if a
  staged action targets a path no longer in the expected state, the action fails
  safely with an explanatory message.
- **REQ-EDGE-009 (Paths with unusual characters)** — All path handling uses
  NUL-delimited (`-z`) output and explicit `--` path separators so spaces,
  newlines, and non-ASCII bytes in paths are handled without misparsing.
- **REQ-EDGE-010 (Large files)** — Blame and file content for very large files are
  virtualized and may be size-capped with a clear "file too large to blame in app"
  message and an option to proceed without syntax highlighting.
- **REQ-EDGE-011 (Command failures)** — Any host-git non-zero exit during the
  workflow surfaces the captured stderr, leaves the repository in its actual
  current state (re-read), and never reports success on failure.

## Out of scope

- **Submodule conflicts** are deferred: cbranch detects and lists a conflicted
  submodule (gitlink) path and labels it as a submodule conflict, but in-app
  resolution of submodule conflicts (choosing/committing a submodule commit) is
  out of scope for Phase 4. The user is directed to resolve it via the host
  toolchain.
- The detailed UX and internals of the 3-way merge editor (pane layout, hunk
  navigation, conflict markers within the editor) are specified in the dedicated
  conflict/merge editor section, not here.
- Interactive rebase authoring (reordering/squashing as an editing workflow),
  reflog, bisect, archive, clean, gc, and settings are Phase 5.
- Stash creation/management is a Phase 3 capability and is only referenced here as
  remediation guidance.
- Launching external (host) merge tools is available via Phase 3/5 host-git
  integration and is not the primary resolution path specified in this section.
