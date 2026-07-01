# Phase 6 — Completion, Safety Hardening & Repository Utilities

## Purpose

Phase 6 has two jobs.

1. **Close the gaps in already-shipped phases.** A handful of behaviors that P1
   and P2 make **mandatory** were left unbuilt or only partially wired during the
   P1–P5 build. This document **re-states** those behaviors as fresh, testable
   completion requirements so the implementer has an explicit, self-contained work
   item. It does **not** modify the P1/P2 documents; it references them by
   requirement id. Where a completion item is UI-only (its RPC method and engine
   support already exist), that is called out so no new contract surface is minted.

2. **Add the repository utilities deferred out of the MVP.** Everyday
   quality-of-life actions (undo the last commit, initialize a new repository, a
   transparent Git command log) and three self-contained utility features
   (repository metadata-file editors, Git notes, and patch interchange) that round
   cbranch out into a complete day-to-day client.

All features in this phase obey the locked architecture (identical to `09`):

- All operations run **on the remote host** against the real on-disk repository
  via the host `git` binary behind the single `GitEngine` interface; the
  browser/webview is a pure view issuing typed RPC calls and rendering results.
- Every **mutating** operation is **serialized per repository** behind the
  `Effect.Semaphore(1)` repository lock, and after any mutation cbranch ensures
  subsequent reads reflect on-disk state via the filesystem watcher → invalidation
  bus (`15-sync-protocol.md`).
- Large or binary payloads travel over the HTTP **side-channel** (`14 §3.7`), never
  base64 over RPC; path-bearing inputs are contained to the repository per the
  security rules in `12` (NF-SEC-5/6).

> **Scope note.** Phase 6 is independent and à-la-carte like Phase 5: each feature
> is separately shippable and separately gated. The "completion" requirements
> (§Completion & safety hardening) should land first, as they raise shipped
> phases to their stated contract — in particular one of them closes an active
> **SC-4 "Safe by default"** violation.

## User stories

- As a developer who just clicked the wrong button, I want any action that would
  destroy uncommitted work to stop and ask me first, naming exactly what will be
  lost — never silently.
- As a developer polishing a change, I want to stage or discard **individual
  lines** of a hunk, not just whole hunks, from the diff.
- As a developer, I want to reset my branch to a chosen commit (soft/mixed/hard)
  directly from the stage/commit surface, not only from the reflog.
- As a developer, I want to jump to a commit by typing its hash and have the
  history scroll to and select it, loading more history if needed.
- As a developer, I want to hide the columns I don't care about and have that
  choice stick between sessions.
- As a developer who committed too soon, I want a one-click "undo last commit"
  that moves my work back into staging with the message preserved.
- As a developer starting fresh, I want to create a new empty repository on the
  host and open it, without dropping to a terminal.
- As a cautious or curious user, I want to see the exact `git` commands cbranch
  ran, with timing and exit status, so nothing is a black box.
- As a developer, I want to edit `.gitignore`, `.gitattributes`, `.mailmap`, and
  the repo's `info/exclude` from inside cbranch.
- As a developer, I want to read, add, and remove **Git notes** on a commit and
  see which commits carry notes.
- As a developer collaborating by email or across a gap, I want to **export** a
  range of commits as `.patch` files and **apply** a patch someone sent me.

## Functional requirements

REQ identifiers are stable. Each requirement is testable and describes
**observable** behavior. Requirements that complete a P1/P2 obligation cite the
originating id.

### Completion & safety hardening

#### Destructive-change confirmation (completes REQ-P2-GUARD-001/002, REQ-P2-DISCARD-001/002, REQ-OV-009, SC-4)

- **REQ-P6-GUARD-001** Per-file **discard of tracked changes** and **delete of an
  untracked file** from the working-tree change list MUST require an explicit
  confirmation before executing, satisfying the pre-existing but unmet
  REQ-P2-GUARD-001 / REQ-P2-DISCARD-001/-002. The confirmation MUST name the exact
  path(s) and state that the change is permanent and irreversible.
- **REQ-P6-GUARD-002** The confirmation MUST NOT be dismissable by a stray keypress
  (the destructive action MUST NOT be the default-focused control), and the
  destructive operation MUST NOT run as an implicit side effect of any other action
  (REQ-P2-GUARD-002).
- **REQ-P6-GUARD-003** Bulk discard/delete over a multi-selection MUST use a single
  confirmation that states the count and enumerates (or scrollably lists) the
  affected paths; confirming MUST act on exactly that set.
- **REQ-P6-GUARD-004** This requirement adds **no new RPC surface**: the mutating
  methods `discard.files` (`DiscardFiles`) and `deleteUntracked` (`DeleteUntracked`)
  already exist. Phase 6 wires the existing `DestructiveConfirmDialog` in front of
  them in the status/change-list flow.

#### Reset to a commit from the stage/commit surface (completes REQ-P2-RESET-002/003/004, AC-6)

- **REQ-P6-RESET-001** The stage/commit surface MUST expose a **Reset to commit…**
  action that lets the user choose a target commit (the selected commit, or an
  entered ref/hash) and a mode: **soft**, **mixed**, or **hard**.
- **REQ-P6-RESET-002** A **hard** reset MUST be confirmation-gated with a message
  naming the working-tree data loss; **soft**/**mixed** resets MUST inform the user
  of their effect but MAY use a lighter confirmation, and MUST NOT be silently
  upgraded to hard (REQ-P2-GUARD-001 second clause; AC-6).
- **REQ-P6-RESET-003** This requirement adds **no new RPC surface**: it reuses the
  existing `reset.to` (`ResetTo`, payload `{ repoId, mode, target }`). Phase 6
  provides the reachable entry point and mode/confirmation UX outside the P5 reflog
  panel, which is the only current consumer.

#### Line-level staging (completes REQ-P2-HUNK-002/004/005, AC-4)

- **REQ-P6-LINE-001** In the working-tree diff, the user MUST be able to select
  **individual lines** — including a non-contiguous subset of a hunk's added/removed
  lines — and **stage**, **unstage**, or **discard** exactly that selection
  (REQ-P2-HUNK-002).
- **REQ-P6-LINE-002** Partial **staging** MUST place exactly the selected bytes in
  the index and leave the remainder in the working tree (REQ-P2-HUNK-004); partial
  **discard** MUST remove exactly the selected changes and, being destructive, MUST
  be behind the confirmation guard of REQ-P6-GUARD-001 (REQ-P2-HUNK-005).
- **REQ-P6-LINE-003** This requirement adds **no new RPC surface** and **no new
  engine work**: the methods `stage.hunks` / `unstage.hunks` / `discard.hunks`
  (`StageHunks`/`UnstageHunks`/`DiscardHunks`) already accept a `PatchSelection`
  whose `HunkSelection.selectedLines` carries the per-line indices (empty = whole
  hunk), and the core patch builder already splits patches by line. Phase 6 supplies
  the **line-selection UI** and populates `selectedLines` instead of sending `[]`.

#### Go-to-commit by hash (completes P1-HIST-7, REQ-GRAPH-025)

- **REQ-P6-NAV-001** cbranch MUST provide a **Go to commit…** action (command
  palette + `Ctrl+G`) that accepts a full or abbreviated commit hash (or a ref that
  resolves to a commit) and, on resolution, scrolls the history/graph to and selects
  that commit's row, **loading more history first** if the commit is not yet in the
  loaded window (P1-HIST-7 / REQ-GRAPH-025).
- **REQ-P6-NAV-002** An unresolvable or ambiguous input MUST surface a clear,
  non-destructive error and leave the current selection unchanged.
- **REQ-P6-NAV-003** This is a **client-only** capability over existing read methods
  (`log.stream` for incremental loading, `commit.detail` to validate a hash); it
  adds no RPC surface. The programmatic scroll-to-row is the graph capability
  required by REQ-GRAPH-025.

#### Column visibility, persisted (completes P1-UI-HIST-1)

- **REQ-P6-COL-001** The history grid's non-essential columns (at least: author
  name, author avatar, date, SHA) MUST be individually show/hide-able by the user;
  the graph cell and commit summary are always present (REQ-GRAPH-UI-001).
- **REQ-P6-COL-002** The chosen column visibility MUST **persist** across sessions,
  stored as an **app setting** (not in git config), consistent with P1-UI-HIST-1 and
  the app-settings separation of REQ-P5-CFG-005/006.
- **REQ-P6-COL-003** This reuses the existing app-settings store
  (`config.appGet`/`config.appSet`); it adds a new app-settings key, not a new git
  method.

### Undo last commit

- **REQ-P6-UNDO-001** cbranch MUST provide an **Undo last commit** action that moves
  `HEAD` back by one commit while **preserving that commit's changes in the index**
  (a soft reset to the first parent), so the user can re-commit after edits.
- **REQ-P6-UNDO-002** The undone commit's message MUST be **preserved** and offered
  as the prefilled message for the next commit.
- **REQ-P6-UNDO-003** Undo MUST be **blocked or clearly warned** when the last commit
  is a **merge commit**, when `HEAD` has **no parent** (root commit), or when a
  rebase/merge/cherry-pick is in progress; in these cases cbranch explains why and
  does not act.
- **REQ-P6-UNDO-004** If the last commit has already been **pushed** to its upstream,
  cbranch MUST warn that undoing it will diverge from the remote (mirroring the
  amend-of-pushed warning already surfaced at commit time) before proceeding.
- **REQ-P6-UNDO-005** Undo composes existing methods (`reset.to` with `soft` to
  `HEAD~1`, plus `commit.lastMessage`/`commit.detail` for the preserved message); it
  adds **no new RPC surface**.

### Create / initialize a repository

- **REQ-P6-INIT-001** cbranch MUST let the user **create a new repository** on the
  host by entering a destination path, then open it as the active repository. (Note:
  `git clone` remains out of scope — REQ-OV/`04`.)
- **REQ-P6-INIT-002** The user MUST be able to choose an **initial branch name**
  (default from `init.defaultBranch` when set, else git's default) and whether the
  repository is **bare**.
- **REQ-P6-INIT-003** If the destination path already contains a git repository,
  cbranch MUST NOT reinitialize destructively; it MUST detect the existing repo and
  offer to **open** it instead, with a clear message.
- **REQ-P6-INIT-004** If the destination path does not exist, cbranch MUST create it
  (a single leaf directory) or surface a clear error if the parent is missing or not
  writable; it MUST NOT create arbitrary deep paths silently.
- **REQ-P6-INIT-005** On success cbranch MUST add the new repository to the recent
  list and switch context to it, presenting the empty-repository state.

### Git command log

- **REQ-P6-CLOG-001** cbranch MUST record every host `git` invocation it makes and
  expose a **Git command log** view listing, newest-first, for each invocation: the
  **argument vector** (the exact `git` subcommand and flags, as an array — never a
  reconstructed shell string), the working directory (repository), start time,
  duration, and exit code / success.
- **REQ-P6-CLOG-002** The log MUST distinguish **succeeded** from **failed**
  invocations and, for failures, MUST include a **bounded** excerpt of stderr; it
  MUST NOT include full stdout/object bytes (the log is a diagnostic trail, not a
  data channel).
- **REQ-P6-CLOG-003** The log MUST NOT expose secrets: environment values are
  **not** recorded, and any credential-bearing argument tokens MUST be redacted. The
  non-interactive git environment (`GIT_TERMINAL_PROMPT=0`, `BatchMode`) is assumed,
  so no prompt content exists to log.
- **REQ-P6-CLOG-004** The log is a **bounded ring buffer** (a fixed recent-history
  size); older entries age out. It is diagnostic state, not persisted repository
  data, and is **not** written to git config or the repository.
- **REQ-P6-CLOG-005** The view MUST support filtering to the active repository and
  MUST update live as new commands run (via a streaming subscription or
  invalidation), so a user watching the log sees operations as they happen.

### Repository metadata-file editors

- **REQ-P6-META-001** cbranch MUST provide in-app editors for a **fixed, enumerated
  set** of repository metadata files: the repository-root **`.gitignore`**,
  repository-root **`.gitattributes`**, repository-root **`.mailmap`**, and the
  private **`.git/info/exclude`**. The set is closed; arbitrary working-tree paths
  are **not** editable through this feature.
- **REQ-P6-META-002** Opening an editor MUST read the file's current content if it
  exists, or present an empty editor if it does not (indicating the file will be
  created on save). `.git/info/exclude` is read/written inside the git directory, not
  the working tree.
- **REQ-P6-META-003** Saving MUST write the file's content atomically on the host and
  MUST invalidate the affected state (an ignore/attributes change alters
  status/diff/ignore evaluation; a `.mailmap` change alters displayed
  author/committer identities). Writing `.gitignore`/`.gitattributes`/`.mailmap` is a
  working-tree change that becomes a normal stageable modification.
- **REQ-P6-META-004** The read/write MUST be **path-contained**: the enumerated
  target is resolved relative to the repository root (or git dir for `info/exclude`)
  and MUST reject any resolution that escapes it (NF-SEC-5/6), so this feature can
  never be turned into an arbitrary-file read/write primitive.
- **REQ-P6-META-005** Editing is plain text (CodeMirror 6). Syntax-aware validation
  (e.g., testing a path against the ignore rules) is **optional**; when offered it
  uses `git check-ignore` and never mutates state.

### Git notes

- **REQ-P6-NOTE-001** cbranch MUST let the user **view** the note attached to a
  commit (from the default notes ref `refs/notes/commits`), showing its text in the
  commit detail surface.
- **REQ-P6-NOTE-002** cbranch MUST let the user **add or edit** a commit's note
  (message authored in the UI) and **remove** a commit's note, each behind the normal
  mutation lock; removing a note is a distinct, explicit action.
- **REQ-P6-NOTE-003** cbranch MUST indicate **which commits carry notes** so the user
  can discover them (a badge/indicator in the history grid and/or commit detail),
  gated by the existing **"Show git notes"** view toggle.
- **REQ-P6-NOTE-004** Editing notes rewrites the notes ref, not the commit; cbranch
  MUST make clear that a note does **not** change the commit's hash.
- **REQ-P6-NOTE-005** A non-default notes ref MAY be selectable, but v1 of this
  feature MUST at least support the default `commits` notes ref. Concurrent external
  changes to the notes ref MUST reconcile on the next read (notes live under
  `refs/notes/*`, which the watcher already covers).

### Patch interchange

- **REQ-P6-PATCH-001** cbranch MUST let the user **export** a commit range (or a
  single commit) as one or more `.patch` files via `format-patch`, delivered to the
  browser as a download; the user MUST be able to specify the range (e.g., a base
  ref, or "since this commit"), and cbranch MUST report what was produced.
- **REQ-P6-PATCH-002** cbranch MUST let the user **apply** a patch supplied as text
  (pasted, or the contents of a chosen host `.patch` file), with a selectable mode:
  apply to the **working tree**, apply to the **index** (cached), or apply as
  **commits** (`git am`, preserving authorship/message). A **3-way** fallback MUST be
  offerable when a straight apply fails.
- **REQ-P6-PATCH-003** Before applying, cbranch MUST offer a **dry-run check** that
  reports whether the patch applies cleanly, and MUST NOT partially apply on failure;
  a failed apply MUST leave the repository in its pre-apply state (or, for `git am`, in
  a well-defined in-progress state with clear continue/abort controls).
- **REQ-P6-PATCH-004** When applying as commits (`git am`) hits a conflict, cbranch
  MUST route the user to the existing conflict-resolution flow (Phase 4) and expose
  `am --continue` / `--skip` / `--abort`, consistent with the sequencer model.
- **REQ-P6-PATCH-005** cbranch MUST let the user **view** a patch (the selected
  `.patch` file or pasted text) rendered as a readable diff before applying, reusing
  the existing diff rendering.
- **REQ-P6-PATCH-006** Patch **text inputs** are bounded in size when sent inline over
  RPC; a patch exceeding the inline cap MUST use the HTTP side-channel upload rather
  than being rejected outright (see §RPC contract additions).

## RPC contract additions

> This section is the **contract delta** for Phase 6. It extends — and reconciles
> to — the authoritative `14-rpc-contract.md` without rewriting it. New methods
> follow the doc-14 house style: a PascalCase wire tag + a `<domain>.<verb>` doc
> label; a repo-scoped `payload` beginning with `repoId: RepoId`; payload/success
> modeled as named `Schema.Class`es in a new `schemas/phase6.ts`; `error: GitError`
> on every method; ✎ = mutating (takes the per-repo lock), ⇉ = streaming.

**Reused, no new surface** (called out so they are not duplicated): `reset.to`
(`ResetTo`), `discard.files` (`DiscardFiles`), `deleteUntracked` (`DeleteUntracked`),
`stage.hunks`/`unstage.hunks`/`discard.hunks` (`StageHunks`/`UnstageHunks`/
`DiscardHunks`, with `PatchSelection.selectedLines`), `config.appGet`/`config.appSet`,
`log.stream`, `commit.detail`, `commit.lastMessage`.

**New methods:**

| Method | Payload | Success | Notes |
|---|---|---|---|
| `repo.init` ✎ | `{ path, defaultBranch?, bare? }` | `RepoInitResult { repoId }` | `git init`; rejects an existing repo (offer open); no deep-path creation |
| `commandLog.list` | `{ repoId?, limit? }` | `CommandLogEntry[]` | newest-first ring-buffer read; argv, cwd, times, exit, bounded stderr on failure |
| `commandLog.subscribe` ⇉ | `{ repoId? }` | stream `CommandLogEntry` | live tail; top-level error `Never` per streaming rule |
| `metaFile.read` | `{ repoId, file }` | `MetaFileContent { file, exists, text }` | `file` ∈ `{ gitignore, gitattributes, mailmap, info-exclude }` (closed literal) |
| `metaFile.write` ✎ | `{ repoId, file, text }` | `void` | atomic write; path-contained; creates if absent |
| `notes.list` | `{ repoId, ref? }` | `NotedObject[] { oid }` | which commits carry a note (for indicators) |
| `notes.get` | `{ repoId, oid, ref? }` | `NoteContent { present, text }` | default ref `commits` |
| `notes.set` ✎ | `{ repoId, oid, text, ref? }` | `void` | `git notes add -f -F -` (add or edit) |
| `notes.remove` ✎ | `{ repoId, oid, ref? }` | `void` | `git notes remove` |
| `patch.formatPrepare` | `{ repoId, range, includeCover? }` | `PatchBundleDescriptor` | read-only; bytes over `GET /sidechannel/patch` |
| `patch.inspect` | `{ repoId, patch, mode }` | `PatchApplyReport { clean, files, conflicts? }` | dry-run: `git apply --check` / `am --3way` probe; no mutation |
| `patch.apply` ✎ | `{ repoId, patch, mode, threeWay? }` | `PatchApplyResult { applied, inProgress?, message }` | `mode ∈ { working, index, am }`; conflicts route to Phase 4 |

**Side-channel routes** (mirroring `archive`/`blob` containment, NF-SEC-5/6):

- **Outbound:** `GET /sidechannel/patch` streams the `format-patch` bundle described
  by `PatchBundleDescriptor`; the tree-ish/range is re-validated before `200` and the
  route inherits the global Origin/Host guard.
- **Inbound (new capability):** a bounded **`POST /sidechannel/patch-upload`** route
  accepts a large `.patch` payload that exceeds the inline RPC cap, returning an
  upload token the `patch.apply`/`patch.inspect` payload may reference in place of
  inline `patch` text. Small patches travel inline over RPC and need no upload.

**GitError codes.** New failure modes reconcile to the single canonical `GitError`
union by **adding literals to the one closed `GitErrorCode` array** (`14 §4`) — never
by introducing a second error class. Candidate additions (reconcile against the
existing 23 before adding; reuse an existing code where one already fits): a target
that already contains a repository for `repo.init`; a patch that does not apply for
`patch.apply`/`patch.inspect`. Notes-absent is an ordinary present/absent result
(`NoteContent.present = false`), not an error. Metadata-file I/O failures reuse the
existing filesystem/exec error code.

## Git operations

The exact host `git` subcommands cbranch runs (always non-interactive; any operation
git would route through an editor is redirected to a cbranch-supplied scripted editor
via environment variables, per `09`):

### Completion items (reuse existing engine paths)

- **Discard / delete:** `git restore -- <path>` (or `git checkout -- <path>`) for
  tracked discard; remove the untracked file on the host for delete — the existing
  `discard.files` / `deleteUntracked` engine methods; Phase 6 only gates them in the
  UI.
- **Reset to commit:** `git reset --soft|--mixed|--hard <target>` — existing
  `reset.to`.
- **Line staging:** `git apply --recount [--cached] [--reverse]` fed a patch the core
  builder synthesizes from the `selectedLines` selection — existing hunk methods.
- **Go-to-commit / columns:** no git operation (client read/scroll; app-setting
  persistence).

### Undo last commit

- **Undo:** `git reset --soft HEAD~1` (guarded per REQ-P6-UNDO-003 for merge/root/
  in-progress). The prior message is read via `git log -1 --format=%B HEAD` (i.e.
  `commit.lastMessage`) **before** the reset and offered as the next commit message.
- **Pushed detection:** compare `HEAD` against the upstream tip (existing ahead/behind
  machinery) to raise the divergence warning.

### Create / initialize a repository

- **Init:** `git init [--bare] [--initial-branch=<name>] -- <path>`. Pre-check the
  destination with a repository probe (`git rev-parse --git-dir` in the path) to detect
  an existing repository and offer **open** instead of reinitializing.

### Git command log

- No dedicated git subcommand: the log is produced by the engine's own invocation
  wrapper recording each `child_process` spawn's argv/cwd/timing/exit. The engine
  already runs every git call through one arg-array runner; Phase 6 taps it to append
  a redacted record to the ring buffer and emit it on the `commandLog.subscribe`
  stream.

### Repository metadata-file editors

- No git subcommand for read/write (host filesystem read/write of the contained,
  enumerated file). Optional ignore validation: `git check-ignore -v -- <path>`
  (read-only).

### Git notes

- **List noted objects:** `git notes [--ref <ref>] list` (object ↔ note mapping).
- **Read:** `git notes [--ref <ref>] show <oid>` (absent note → non-zero → reported as
  `present: false`, not an error).
- **Add/edit:** `git notes [--ref <ref>] add -f -F - <oid>` with the note text on
  stdin (no terminal editor).
- **Remove:** `git notes [--ref <ref>] remove <oid>`.

### Patch interchange

- **Export:** `git format-patch <range> -o <hostTmpDir>` (single commit via
  `-1 <oid>`; "since here" via `<base>..HEAD`), streamed to the browser over
  `GET /sidechannel/patch`; cbranch reports the file set.
- **Check (dry-run):** `git apply --check --recount` (working/index modes) or
  `git apply --check --3way` for the 3-way probe; for `am`, a format/validity probe.
- **Apply — working tree:** `git apply --recount [--3way] <patch>`.
- **Apply — index:** `git apply --cached --recount [--3way] <patch>`.
- **Apply — as commits:** `git am [--3way] <patch>`; conflicts expose
  `git am --continue|--skip|--abort` through the existing sequencer/conflict flow.

## UI/UX requirements

Expressed via shadcn/ui (`base-lyra` on Base UI); visual styling is out of scope,
component choice and behavior are not.

- **Entry points:** New actions appear in the cmdk command palette ("Go to commit",
  "Reset to commit", "Undo last commit", "New repository", "Git command log",
  "Edit .gitignore/.gitattributes/.mailmap/exclude", "Notes: edit", "Export
  patch…", "Apply patch…") and in the relevant contextual menus (commit context menu
  for reset/notes/export; status area for discard/reset; Tools menu for the command
  log; Repository menu for the metadata editors and init).
- **Destructive confirmation:** discard, untracked-file delete, hard reset, and
  partial-discard use a shadcn `AlertDialog` that names the exact paths/effect and the
  irreversibility, with the destructive action visually distinct and **not** the
  default focus (satisfies UX-P2-006). Soft/mixed reset and undo-last-commit use a
  lighter confirmation describing their effect.
- **Line selection:** the working-tree diff MUST allow selecting individual lines
  (click/shift-click/drag across added/removed lines) and present "Stage lines" /
  "Unstage lines" / "Discard lines" actions operating on the current selection; the
  selection maps to `HunkSelection.selectedLines`.
- **Go to commit:** a small input (dialog or palette field) bound to `Ctrl+G`;
  on resolve, the history virtualizer loads until the row is available and scrolls it
  into view, selected; on failure an inline error.
- **Column visibility:** a header context menu (or a View sub-surface) with a toggle
  per optional column; the graph cell and summary are non-toggleable; the choice
  persists via app settings.
- **Undo last commit:** a Commands entry that, on confirm, performs the soft reset and
  opens the commit surface with the preserved message prefilled.
- **New repository:** a `Dialog` collecting destination path, optional initial branch,
  and a bare `Checkbox`; on success it switches to the new repo's empty state.
- **Git command log:** a Tools panel/`Sheet` with a virtualized, newest-first list;
  each row shows the argv (monospace), repo, duration, and a success/failure badge;
  failed rows expand to the bounded stderr excerpt. A repo filter and live-tail toggle
  are present.
- **Metadata editors:** a `Dialog`/`Sheet` with a CodeMirror 6 text editor per file,
  a Save action, and a dirty indicator; `.git/info/exclude` is clearly labeled as
  private (not committed).
- **Notes:** the commit detail surface shows the note (if any) with Edit/Remove
  actions; the editor is a CodeMirror 6 message field; the history grid shows a note
  indicator when "Show git notes" is enabled.
- **Patch interchange:** an Export `Dialog` (range picker + result toast with the
  produced files) and an Apply `Dialog` (paste area or host-file picker, a mode
  `RadioGroup` — working / index / commits — a 3-way `Checkbox`, a "Check" action
  showing the dry-run result, and an "Apply" button); a patch preview renders the
  diff before applying. `am` conflicts hand off to the existing conflict banner/flow.
- **Concurrency feedback:** while a mutating Phase 6 operation holds the repository
  lock, conflicting actions are disabled with a tooltip explaining the repository is
  busy.

## Acceptance criteria

- Triggering discard, untracked-delete, or a partial discard without confirming
  leaves the working tree unchanged; confirming performs exactly the stated effect
  and the destructive control is never the default focus.
- Selecting a non-contiguous set of lines and choosing "Stage lines" stages exactly
  those lines; re-opening the diff shows precisely the remainder unstaged (AC-4).
- "Reset to commit" with soft/mixed/hard moves HEAD/index/working-tree as specified;
  hard requires an explicit data-loss confirmation and soft/mixed do not (AC-6).
- "Go to commit" with a hash beyond the loaded window loads more history and then
  scrolls to and selects the target; an unresolvable hash shows an error and changes
  nothing (REQ-GRAPH-025 / P1-HIST-7).
- Toggling a column hides/shows it and the choice survives a full reload; the graph
  and summary remain present.
- "Undo last commit" on a normal commit moves HEAD back one, leaves the changes
  staged, and prefills the prior message; on a merge commit or root commit it is
  blocked with an explanation; a pushed last commit warns about divergence first.
- Creating a new repository at a fresh path initializes it, switches to it, and shows
  the empty state; pointing at an existing repository offers to open it instead of
  reinitializing.
- The Git command log shows each git invocation newest-first with argv, repo,
  duration, and exit status; a failed command shows a bounded stderr excerpt; no
  environment values or secret tokens appear; the log tails live as commands run.
- Editing `.gitignore`/`.gitattributes`/`.mailmap`/`info-exclude` reads current
  content (or empty), and Save writes it on the host and refreshes the affected
  status/diff/identity views; a path that escapes the repository is rejected.
- A commit's note can be viewed, added/edited, and removed; the commit hash is
  unchanged by note edits; commits carrying notes are indicated when the toggle is on.
- Exporting a range yields downloadable `.patch` file(s) for exactly that range;
  applying a patch in each mode reports a clean apply or, on failure, applies nothing
  (working/index) or enters a well-defined `am` in-progress state with continue/skip/
  abort; the dry-run check predicts the outcome; a patch preview renders before apply.

## Edge cases & error handling

- **Discard/delete of an externally-vanished path:** if the file changed or
  disappeared between listing and confirm, cbranch re-reads status and surfaces the
  reconciled state rather than acting on stale data.
- **Line selection spanning both add and delete lines:** the resulting patch stages
  exactly the selected added lines and selected removed lines; unselected deletes
  become context and unselected adds are dropped (the existing builder semantics).
- **Reset target invalid/ambiguous:** surfaced as a clear error; no mode is applied.
- **Go-to-commit for a hash not reachable in the current view filters** (e.g., hidden
  by a branch filter): cbranch either loads it or explains it is filtered out, rather
  than scrolling to nothing.
- **Undo last commit when HEAD is a merge:** blocked with an explanation (undo would be
  ambiguous about which parent); root commit (no parent) blocked; rebase/merge/
  cherry-pick in progress blocked until resolved.
- **Init on a path inside an existing repository/worktree:** detected and offered as
  "open the containing repository" rather than nesting a new one; init on a
  non-writable parent errors clearly.
- **Command log and secrets:** a git invocation that carries a token in an argument
  (rare, since remote auth is out-of-band) has that token redacted; environment is
  never logged; the buffer is bounded so a long session cannot grow memory unbounded.
- **Metadata write race:** if the file changed on disk since it was read, cbranch
  writes the user's content (last-write-wins for a single-user tool) but MUST refresh
  and show the new on-disk content afterward; `info/exclude` writes never touch the
  working tree.
- **Note edit on a commit that was rewritten** (e.g., by a concurrent rebase): the
  note ref may point at an object no longer on a branch; cbranch surfaces git's error
  and refreshes rather than fabricating success.
- **format-patch of an empty/invalid range:** reports nothing to export and produces
  no download.
- **Patch that does not apply:** the dry-run check reports it; a forced apply attempt
  applies nothing (working/index) or leaves `am` in a clean in-progress state with the
  conflict routed to the Phase 4 flow; a malformed patch is rejected with git's error.
- **Oversized inline patch:** a patch exceeding the inline RPC cap is routed through
  the `patch-upload` side-channel route rather than being rejected.
- **Concurrent mutation attempt:** any Phase 6 mutation attempted while another
  mutating operation holds the repository lock is rejected/queued with a clear busy
  indication; cached state is invalidated after each host-git mutation completes.

## Out of scope

- `git clone` and any remote-cloning/forking flow (unchanged from v1 scope;
  repositories are opened or `init`-ed by host path only).
- Arbitrary working-tree file browsing/editing: the metadata-file editors operate on a
  **closed, enumerated** set only and are not a general file manager.
- Non-default notes workflows beyond viewing/add/edit/remove on a selectable notes ref
  (e.g., notes merge strategies, rewriting notes across history) — deferred.
- Patch workflows beyond `format-patch` export and `apply`/`am` import (e.g.,
  interdiff, patch series management/threading, `send-email`) — deferred.
- Persisting the Git command log to disk, exporting it, or turning it into a
  replayable audit store — it is an in-memory diagnostic tail only.
- Any change to the completed P0–P5 specifications; Phase 6 references them and adds
  new requirements, but does not edit them.
