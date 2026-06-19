# Phase 1 — Read-only Repository Browser

## Purpose

Phase 1 delivers the foundational read-only experience of cbranch: the ability to open a Git repository on the remote host, switch quickly between recently opened repositories, observe the current working-tree status at a glance, and explore the full commit history with rich filtering, search, commit details, and a fully featured read-only diff viewer.

This phase performs **no mutating Git operations**. Every requirement here is observation-only: nothing in Phase 1 changes the index, the working tree, refs, or any remote. All interaction with the on-disk repository happens on the remote host through the `GitEngine` interface; the browser/webview is a pure view that issues typed RPC calls and renders the results.

Phase 1 is independently shippable: a user can point cbranch at a repository and use it as a fast history/diff explorer even before staging, committing, or sync features exist.

## User stories

- As a developer connected to a remote host over SSH, I want to open a Git repository by typing or pasting its path, so I can start browsing immediately.
- As a developer who works across several projects, I want a switcher with my recently opened repositories, so I can jump between them without retyping paths.
- As a developer, I want to see the current branch, how far ahead/behind its upstream it is, and how many files are changed, so I understand the repository state at a glance.
- As a developer reviewing work, I want a virtualized, streaming commit history with a graph, message, author, date, and short hash, so I can scroll through very large histories without lag.
- As a developer hunting for a specific change, I want to filter and search history by branch, path, author, message, and date range, and quickly find-as-I-type, so I can locate commits fast.
- As a developer inspecting a commit, I want a details panel showing author, committer, dates, full message, parents, and the refs/tags that point at it, so I have full provenance.
- As a developer reviewing a commit, I want a changed-file list and a diff viewer with inline and side-by-side modes, syntax highlighting, whitespace and context controls, and change-to-change navigation, so I can read changes efficiently.
- As a developer, I want to view the full content of any file at a specific revision, so I can read code in context rather than only as a patch.

## Functional requirements

Requirements use stable identifiers of the form `P1-<area>-<n>`. Each is testable and describes observable behavior.

### Opening a repository

- **P1-OPEN-1**: cbranch MUST accept an absolute filesystem path (on the remote host) identifying a repository and attempt to open it. Paths MAY point at the working-tree root, a subdirectory within the working tree, or a bare repository directory.
- **P1-OPEN-2**: On an open request, cbranch MUST resolve the repository's top-level working-tree directory and the location of the Git directory, and MUST report whether the repository is bare, a worktree, or a normal working tree. If the path is not inside any Git repository, cbranch MUST return a typed "not a repository" error and MUST NOT add the path to the recent list.
- **P1-OPEN-3**: cbranch MUST detect and report the following repository conditions at open time, each as an observable flag/value: empty repository (a valid repository with no commits), detached HEAD, repository currently mid-operation (e.g., an in-progress merge, rebase, cherry-pick, bisect, or revert — reported as a state label only; resolving them is out of Phase 1 scope).
- **P1-OPEN-4**: cbranch MUST operate on exactly one repository at a time. Opening a new repository MUST replace the active repository in the view and MUST cancel or supersede any in-flight history/diff requests for the previously active repository.
- **P1-OPEN-5**: Opening MUST be resilient to repositories that are large or slow to enumerate: the open operation MUST return as soon as identity (root, git dir, HEAD, bare/empty/detached state) is known, without waiting for full history to load.

### Recent-repository switcher

- **P1-RECENT-1**: cbranch MUST maintain a persistent ordered list of recently opened repositories (most-recent first), keyed by resolved top-level path. The list MUST de-duplicate by resolved path.
- **P1-RECENT-2**: Each recent entry MUST store at least: the resolved repository path, a display name (default: the final path segment), and the timestamp it was last opened.
- **P1-RECENT-3**: Successfully opening a repository (P1-OPEN-2 succeeds) MUST move it to the top of the recent list and update its last-opened timestamp. A failed open MUST NOT modify the list.
- **P1-RECENT-4**: The switcher MUST support incremental fuzzy matching over recent entries by display name and path, and MUST allow opening an arbitrary new path not yet in the list.
- **P1-RECENT-5**: The user MUST be able to remove an entry from the recent list and to set a custom display name for an entry; these changes MUST persist across sessions.
- **P1-RECENT-6**: Recent-list persistence MUST be scoped to the service/host session store (server-side), so it is available regardless of which browser the user connects from over the tunnel.

### Working-tree status summary

- **P1-STAT-1**: For a non-bare repository, cbranch MUST display a status summary containing: current branch name (or a detached-HEAD indicator with the short commit hash when HEAD is detached), the upstream tracking ref name if configured, ahead/behind counts relative to that upstream, and aggregate change counts.
- **P1-STAT-2**: Aggregate change counts MUST distinguish at least: staged changes, unstaged changes, untracked files, and unmerged/conflicted paths. Counts MUST be derived from porcelain status output (see Git operations) and MUST be read-only — Phase 1 never modifies these.
- **P1-STAT-3**: When the repository is empty (no commits), the status summary MUST indicate the unborn branch (the name HEAD points to that has no commit yet) and MUST show ahead/behind as not-applicable.
- **P1-STAT-4**: When HEAD is detached, ahead/behind MUST be reported as not-applicable (no upstream), and the summary MUST clearly mark the detached state.
- **P1-STAT-5**: The status summary MUST be refreshable on demand by the user. Phase 1 MAY refresh on window/tab focus but MUST NOT auto-mutate anything; automatic filesystem watching is out of scope for Phase 1.
- **P1-STAT-6**: If the upstream ref is configured but unreachable locally (e.g., the remote-tracking ref does not exist yet), ahead/behind MUST be reported as unknown rather than zero.

### Commit history view

- **P1-HIST-1**: cbranch MUST present commit history as a vertically virtualized list capable of smoothly handling repositories with 100,000+ commits, rendering only the rows in/near the viewport.
- **P1-HIST-2**: Each history row MUST present these columns: (a) the commit graph cell (lane/edge rendering per the dedicated graph section), (b) the commit summary (first line of the message), (c) author name, (d) commit date shown as a relative time with the absolute timestamp available (e.g., on hover/tooltip and switchable), and (e) the abbreviated commit hash. Ref/branch/tag labels MUST be shown attached to the relevant commit rows.
- **P1-HIST-3**: History MUST load incrementally/streamed: cbranch MUST render an initial page quickly and continue to append commits as the user scrolls (or as a background stream fills the list), without blocking the UI on full traversal. The graph topology MUST remain correct as additional commits stream in.
- **P1-HIST-4**: The history view MUST expose the total/known commit count when available and MUST indicate when more commits are still loading versus when the end of history has been reached.
- **P1-HIST-5**: Selecting a commit row MUST populate the commit details panel (P1-DET-*) and the diff viewer (P1-DIFF-*) for that commit against its first parent by default.
- **P1-HIST-6**: The history view MUST support keyboard navigation (move selection up/down, page up/down, jump to top/bottom) and MUST keep the selected row visible.
- **P1-HIST-7**: cbranch MUST allow jumping to a specific commit by full or abbreviated hash; if the hash resolves, the list MUST scroll to and select that commit (loading more history if needed to reveal it).
- **P1-HIST-8**: The relative/absolute date display MUST be a user-selectable preference that applies consistently across the history list and details panel.

### History filtering and search

- **P1-FILT-1**: cbranch MUST allow scoping history by ref selection: all refs, the current branch (HEAD) only, or a user-specified set/pattern of refs (branches and/or tags). The default scope MUST be the current branch.
- **P1-FILT-2**: cbranch MUST allow filtering history by one or more paths (files or directories); only commits that touched the given path(s) are shown.
- **P1-FILT-3**: cbranch MUST allow filtering by author (matching author name and/or email, case-insensitive substring or pattern).
- **P1-FILT-4**: cbranch MUST allow filtering by commit-message text (substring or pattern, case-insensitive by default).
- **P1-FILT-5**: cbranch MUST allow filtering by date range (since/until), inclusive, using either author or commit date (the choice MUST be explicit and consistent with the displayed date).
- **P1-FILT-6**: Multiple active filters MUST combine with logical AND (e.g., author + path + date range narrows the result). The active filter set MUST be visible and individually clearable.
- **P1-FILT-7**: cbranch MUST provide a quick incremental "find" within the currently loaded/visible history that highlights and steps through matches (next/previous) by message or hash, distinct from the server-side filters in P1-FILT-1..5. The find MUST be responsive as the user types.
- **P1-FILT-8**: Changing any filter MUST re-issue history loading from the start of the new result set, cancel the superseded request, and reset virtualization/scroll to the top of the new results.
- **P1-FILT-9**: A filter that yields zero commits MUST show an explicit empty-result state (not an error and not a spinner).

### Commit details panel

- **P1-DET-1**: For the selected commit, the details panel MUST show: full commit hash (with abbreviated form) and a copy action; author name, author email, and author date; committer name, committer email, and committer date; the full multi-line commit message (subject + body, preserving line breaks); and the list of parent commit hashes (each navigable to select that parent).
- **P1-DET-2**: The panel MUST list all refs that point at the commit (local branches, remote-tracking branches, tags), distinguishing their kinds. Annotated-tag entries MAY additionally surface the tag's own message/tagger when available.
- **P1-DET-3**: For a merge commit (2+ parents), the panel MUST indicate the merge and allow the user to choose which parent the diff is computed against (default: first parent), and to view the combined diff if requested.
- **P1-DET-4**: All hashes, parent links, and ref labels in the panel MUST be selectable/navigable to move the history selection accordingly.
- **P1-DET-5**: GPG/signature presence MAY be surfaced as a read-only indicator if available, but full signature verification is out of Phase 1 scope.

### Diff viewer

- **P1-DIFF-1**: When a commit (or a parent comparison) is selected, cbranch MUST show the list of changed files between the two tree states, with per-file status (added, modified, deleted, renamed, copied, type-changed) shown via status icons, and rename/copy entries showing both old and new paths plus a similarity indicator when available.
- **P1-DIFF-2**: The changed-file list MUST be switchable between a flat list and a directory tree view, both virtualized for large change sets. Selecting a file MUST show that file's diff.
- **P1-DIFF-3**: The diff viewer MUST support both inline (unified) and side-by-side (split) presentations, switchable by the user, with the choice persisted as a preference.
- **P1-DIFF-4**: The diff viewer MUST apply syntax highlighting appropriate to the file type, layered on top of add/remove/context line styling.
- **P1-DIFF-5**: The viewer MUST provide a whitespace toggle that, when enabled, ignores whitespace-only changes when computing/displaying the diff, and a control to set the number of context lines shown around changes.
- **P1-DIFF-6**: The viewer MUST provide next-change / previous-change navigation that moves between hunks within the current file and MUST allow moving to the next/previous changed file in the list. Keyboard shortcuts MUST be available for these.
- **P1-DIFF-7**: The viewer MUST allow viewing the full content of a file at a chosen revision (the "view file at revision" mode), with syntax highlighting and line numbers, independent of the diff hunks.
- **P1-DIFF-8**: Binary files MUST be detected and shown as a binary-change placeholder (e.g., "binary file changed", with old/new size where available) rather than attempting to render textual hunks. Images MAY optionally be previewed, but this is not required in Phase 1.
- **P1-DIFF-9**: Very large files/diffs MUST be deferred: cbranch MUST NOT eagerly render a diff above a configurable size threshold; instead it MUST show a placeholder with the file's size and an explicit "load anyway" action. The threshold MUST be configurable.
- **P1-DIFF-10**: Submodule entries (gitlink changes) MUST be presented as such — showing the submodule path and the old/new commit hashes it points to — and MUST NOT be rendered as text diffs.
- **P1-DIFF-11**: The diff for the working tree is NOT part of Phase 1; Phase 1 diffs are between committed tree states (commit vs parent, or a file at a revision). (Working-tree/index diffs arrive in Phase 2.)
- **P1-DIFF-12**: All diff operations are read-only; the viewer MUST NOT present staging, discarding, or editing affordances in Phase 1.

### Cross-cutting

- **P1-X-1**: All operations in Phase 1 are read-only with respect to the repository; none MUST acquire the per-repository mutating lock, and concurrent read operations MUST be permitted.
- **P1-X-2**: Every RPC call MUST be cancelable; superseded requests (e.g., due to a new selection or filter) MUST be canceled so their results do not overwrite newer state.
- **P1-X-3**: Errors from underlying Git operations MUST be surfaced as typed, human-readable errors in context (e.g., on the affected panel) and MUST NOT crash the view or the service.
- **P1-X-4**: Results that are stable for a given commit (commit metadata, a commit's diff, file-at-revision content) MAY be cached keyed by the relevant object hashes; the cache MUST be invalidated when the active repository changes.

## Git operations

This section lists the exact Git subcommands and flags cbranch runs (through the single host-`git` backend behind the `GitEngine` interface) and what cbranch parses from each. All are read-only. Object reads are served by a per-repo long-lived `git cat-file --batch`/`--batch-check` process pool to avoid per-call process spawn, and read commands pass `--no-optional-locks`.

> Note: the host `git` binary is invoked with `-c core.quotePath=false` so non-ASCII paths are emitted literally, and history/listing commands that accept it use `-z` (NUL field/record separators) to make parsing unambiguous.

### Repository identity and state (open)

- `git rev-parse --show-toplevel` — resolve the working-tree root. (Used for P1-OPEN-2, recent-list keying.)
- `git rev-parse --git-dir` (and `--absolute-git-dir`) — locate the Git directory; combined with `--is-bare-repository` and `--is-inside-work-tree` to classify the repository (P1-OPEN-2).
- `git rev-parse --quiet --verify HEAD` — determine whether any commit exists (empty/unborn detection, P1-OPEN-3, P1-STAT-3); non-zero/empty result ⇒ empty repository.
- `git symbolic-ref --quiet --short HEAD` — current branch name; failure indicates detached HEAD (P1-STAT-1, P1-OPEN-3).
- Presence of operation-state markers in the Git directory (e.g., an in-progress merge/rebase/cherry-pick/revert/bisect) is read to produce the "mid-operation" state label (P1-OPEN-3). Only the existence/label is read; nothing is acted upon.

### Working-tree status summary

- `git status --porcelain=v2 -z --branch [--untracked-files=all]` — the authoritative source for the status summary (P1-STAT-1..4). cbranch parses:
  - The `# branch.head` line for the current branch (or `(detached)`),
  - `# branch.upstream` for the configured upstream ref,
  - `# branch.ab +A -B` for ahead (`A`) and behind (`B`) counts,
  - The `1`/`2` (ordinary/renamed) entries' two-character XY staged/unstaged status fields to tally staged vs unstaged changes,
  - `u` entries for unmerged/conflicted paths,
  - `?` entries for untracked files.
  - Absence of `# branch.ab` (no upstream, or unborn) ⇒ ahead/behind not-applicable/unknown (P1-STAT-3, P1-STAT-4, P1-STAT-6).

### Ref enumeration

- `git for-each-ref --format='%(objectname) %(refname) %(refname:short) %(objecttype) %(*objectname) %(upstream:short) %(upstream:track)'` — enumerate branches, remote-tracking branches, and tags to attach labels to history rows (P1-HIST-2) and to populate the details panel's pointing-refs list (P1-DET-2). For annotated tags, `%(*objectname)` gives the peeled commit; tag message/tagger MAY be read via `git cat-file -p <tag-object>` when surfaced (P1-DET-2).

### Commit history (list + graph topology)

- `git rev-list --parents <ref-scope> [--all] [--first-parent?] [filters...]` is the spine of history loading. Because the graph and metadata are both needed, cbranch uses a single streamable formatted traversal:
  - `git log -z --parents --topo-order --date-order --format=<format> <ref-scope> [filters...]`, reading the stream incrementally (P1-HIST-1, P1-HIST-3). Ordering is fixed at `--topo-order --date-order` so every parent sorts below its child, which the commit-graph layout (`10-commit-graph.md`) and the streaming model (`14-rpc-contract.md` §6) both depend on. The `<format>` uses a fixed token list emitting at least: full hash `%H`, parent hashes `%P`, author name `%an`, author email `%ae`, author date (ISO strict) `%aI`, committer date `%cI`, and the subject `%s` (full body retrieved on demand for the details panel via per-commit lookup). Parent hashes from `%P` drive the graph topology (P1-HIST-3), with layout delegated to the dedicated graph section.
  - Ref scope (P1-FILT-1) maps to: current branch ⇒ `HEAD`; all ⇒ `--all`; pattern/set ⇒ the explicit ref names or `--branches=<pat>` / `--tags=<pat>` / `--glob=<pat>` as appropriate.
  - Path filter (P1-FILT-2) ⇒ appended as `-- <pathspec>...`.
  - Author filter (P1-FILT-3) ⇒ `--author=<pattern>` with `--regexp-ignore-case` (or `-i`); `--perl-regexp` MAY be used for richer patterns.
  - Message filter (P1-FILT-4) ⇒ `--grep=<pattern>` with `-i`.
  - Date range (P1-FILT-5) ⇒ `--since=<date>` / `--until=<date>` (author-date) or `--since-as-filter`; when filtering by commit date, the equivalent committer-date constraint is applied consistently with the displayed date.
  - Counting/known-total (P1-HIST-4) ⇒ `git rev-list --count <scope> [filters...]` run alongside, when an exact count is requested.
  - Resolving a hash to scroll-to (P1-HIST-7) ⇒ `git rev-parse --verify <input>^{commit}`.

### Commit details

- `git cat-file -p <hash>` (or a one-shot `git show -s --format=<full-format>`) — full commit object: tree, parents, author/committer lines with names/emails/dates, and the complete message body (P1-DET-1, P1-DET-3). Parent count distinguishes merges (P1-DET-3).
- Pointing refs for the details panel come from the `for-each-ref` enumeration above (P1-DET-2).

### Diffs and changed-file lists

- `git diff-tree -r -z --no-commit-id --name-status --find-renames --find-copies <parent> <commit>` (or `<commit>` alone with `--root` for the first commit) — the changed-file list with rename/copy detection and status letters (A/M/D/R/C/T) and similarity scores (P1-DIFF-1). The `-z` output is parsed for old/new paths on renames/copies.
- `git diff-tree -r --numstat -z <parent> <commit>` — per-file added/removed line counts and binary detection (binary files report `-` for both counts) feeding binary handling (P1-DIFF-8) and the large-diff deferral heuristic (P1-DIFF-9).
- `git diff-tree -p <parent> <commit> -- <path>` (equivalently `git diff <parent> <commit> -- <path>`) — the textual patch for a single file, fetched lazily per selected file. Flags applied per the viewer controls:
  - Whitespace toggle (P1-DIFF-5) ⇒ `-w` / `--ignore-all-space` (or `--ignore-space-change`),
  - Context lines (P1-DIFF-5) ⇒ `-U<n>`,
  - Combined merge diff (P1-DIFF-3) ⇒ `--cc` / `-c` against a merge commit when the user requests it.
  - Submodule (gitlink) changes (P1-DIFF-10) ⇒ recognized from the `160000` mode / `Subproject commit <old>..<new>` patch shape and rendered specially rather than as text.
- `git cat-file -p <hash>:<path>` (blob at a revision) — full file content for "view file at revision" (P1-DIFF-7); `git cat-file -s <blob>` gives size for the large-file deferral decision.

### General

- `git --version` — capability/version gate at service startup.
- All listing/diff commands that emit paths use `-z` and `-c core.quotePath=false` for unambiguous, lossless path parsing.

## UI/UX requirements

Expressed in terms of the locked UI stack (React 19, shadcn/ui `base-lyra` on Base UI, Tailwind v4, Lucide icons, cmdk, @tanstack/react-virtual, @tanstack/react-query, Zustand, react-diff-view, CodeMirror 6 + @codemirror/merge, Shiki). Synced repository data is owned solely by @tanstack/react-query (keyed `[repoId, domain, …]`); ephemeral UI state is held in Zustand; live updates use the WebSocket invalidation bus (`15-sync-protocol.md`) once the host watcher is enabled (Phase 1 itself refreshes on demand/focus per P1-STAT-5). These describe interaction and structure, not visual styling.

### Repository open & switcher

- **P1-UI-OPEN-1**: A command-palette-style switcher (cmdk) MUST be reachable via a global keyboard shortcut and a visible trigger. It lists recent repositories (P1-RECENT-*) with display name and path, supports fuzzy filtering as the user types, and offers an "Open path…" action that accepts an arbitrary absolute path.
- **P1-UI-OPEN-2**: The active repository's display name and short path MUST be shown persistently (e.g., in the top app bar) and clicking it MUST open the switcher.
- **P1-UI-OPEN-3**: Each recent entry MUST expose context actions (shadcn dropdown/context menu) for "Rename", "Remove from list", and "Copy path".
- **P1-UI-OPEN-4**: Open failures MUST surface via an inline error (shadcn alert/toast) with the offending path and the typed reason; the switcher stays open so the user can correct the path.

### Status summary

- **P1-UI-STAT-1**: The status summary MUST render in the app header/sidebar as compact badges (shadcn Badge): current branch (with a branch icon, or a distinct "detached" badge showing the short hash), upstream + ahead/behind (with up/down arrow counts), and change counts grouped as staged / unstaged / untracked / conflicts. Each badge MUST have an accessible tooltip with the full text.
- **P1-UI-STAT-2**: A manual refresh control MUST be present; while refreshing, the summary MUST show a non-blocking loading indicator and retain the previous values until new ones arrive.
- **P1-UI-STAT-3**: Not-applicable/unknown ahead/behind states MUST render distinctly from a literal zero (e.g., a dash or "—" with tooltip), per P1-STAT-3/4/6.

### History list

- **P1-UI-HIST-1**: The history list MUST be a virtualized list (@tanstack/react-virtual) with fixed-height rows and the columns defined in P1-HIST-2; the graph cell is rendered by the graph component. Column visibility (e.g., author, date format) MUST be user-adjustable and persisted.
- **P1-UI-HIST-2**: Streaming/incremental loading MUST be visible: a subtle progress indicator while loading, an end-of-history marker when traversal completes, and an explicit empty state (P1-FILT-9) when filters match nothing.
- **P1-UI-HIST-3**: Selecting a row updates the details panel and diff viewer (server cache via @tanstack/react-query keyed by commit hash; transient UI selection state in Zustand). Keyboard navigation per P1-HIST-6 MUST be wired with visible focus and selection states.
- **P1-UI-HIST-4**: Ref/branch/tag labels MUST render as small chips on the relevant rows, color/iconed by kind (local branch, remote branch, tag, HEAD), with overflow handled gracefully (e.g., a "+N" affordance revealing the rest).
- **P1-UI-HIST-5**: Dates MUST honor the relative/absolute preference (P1-HIST-8), with the alternate form available on hover.

### Filtering & search

- **P1-UI-FILT-1**: A filter bar MUST expose controls for: ref scope (segmented control / select: All, Current, Custom…), path filter (path input with autocomplete/picker), author, message text, and date range (date range picker). Active filters MUST appear as removable chips summarizing the current query (P1-FILT-6).
- **P1-UI-FILT-2**: The quick incremental find (P1-FILT-7) MUST be a focused input (opened via shortcut, e.g., the conventional find shortcut) with next/previous controls and a match counter, operating over loaded rows and highlighting matches.
- **P1-UI-FILT-3**: Applying or clearing filters MUST reset the list to the top of the new result set and cancel superseded loads (P1-FILT-8), without full-page reloads.

### Commit details panel

- **P1-UI-DET-1**: The details panel MUST present commit identity (full + short hash with a copy-to-clipboard button), author/committer blocks with names, emails, and dates (respecting the date preference), the full message rendered with preserved line breaks, a parents list with each parent navigable, and a pointing-refs list (P1-DET-2). Long messages MUST scroll within the panel.
- **P1-UI-DET-2**: For merges, a parent selector (e.g., a small segmented control or dropdown) MUST let the user pick the diff base or request the combined diff (P1-DET-3).

### Diff viewer

- **P1-UI-DIFF-1**: The changed-file list MUST support tree/flat toggle (P1-DIFF-2), each entry showing a Lucide status icon and (for renames/copies) old→new paths and similarity. The list MUST be virtualized for large change sets and MUST show total files changed plus aggregate added/removed counts.
- **P1-UI-DIFF-2**: The diff surface MUST offer inline vs side-by-side toggle (react-diff-view), a whitespace toggle, a context-lines stepper, and previous/next change navigation buttons with keyboard shortcuts (P1-DIFF-3/5/6). Syntax highlighting MUST be applied via Shiki (P1-DIFF-4).
- **P1-UI-DIFF-3**: "View file at revision" (P1-DIFF-7) MUST open the file's full content in a read-only CodeMirror 6 view with line numbers and Shiki/CodeMirror syntax highlighting; switching back to the diff MUST preserve scroll position context where feasible.
- **P1-UI-DIFF-4**: Binary changes (P1-DIFF-8), submodule/gitlink changes (P1-DIFF-10), and deferred large diffs (P1-DIFF-9) MUST each render a distinct, clearly labeled placeholder card; the large-diff card MUST include a "Load anyway" button.
- **P1-UI-DIFF-5**: The viewer MUST present no staging/editing/discard controls in Phase 1 (P1-DIFF-12).

### General UI

- **P1-UI-GEN-1**: Loading states MUST be non-blocking (skeletons/spinners scoped to the affected panel); a slow history load MUST never freeze selection, details, or the switcher.
- **P1-UI-GEN-2**: Errors MUST be shown in-context (panel-level alert) with a retry affordance where retrying is safe (all Phase 1 ops are read-only, so retry is always safe).
- **P1-UI-GEN-3**: All primary actions (open switcher, find, toggle diff layout, next/prev change, navigate selection) MUST have keyboard shortcuts surfaced in a discoverable shortcuts list.

## Acceptance criteria

- **AC-1 (Open)**: Given a valid absolute path inside a repository, when the user opens it, then within a short time the app shows the resolved repo name/path, the correct bare/empty/detached/mid-operation state, and the status summary, without waiting for full history.
- **AC-2 (Invalid open)**: Given a path that is not in any repository, when the user attempts to open it, then a typed "not a repository" error is shown, the active repository is unchanged, and the recent list is not modified.
- **AC-3 (Recent list)**: Given the user opens repos A then B then A, the recent list shows A, B in that order with A at top; removing B and renaming A persists across a service restart.
- **AC-4 (Status)**: Given a branch with an upstream that is 2 ahead and 3 behind with 1 staged, 2 unstaged, and 4 untracked files, the summary shows branch name, +2/-3 ahead/behind, and counts 1/2/4 and 0 conflicts, all derived from `--porcelain=v2 --branch`.
- **AC-5 (Detached/empty)**: Given a detached HEAD, the summary shows a detached badge with short hash and ahead/behind as "—". Given an empty repo, the summary shows the unborn branch name and no ahead/behind, and history shows an empty state.
- **AC-6 (History scale)**: Given a repository with 100k+ commits, the history list renders the first page within an interactive timeframe, scrolls smoothly via virtualization, and continues appending commits while remaining responsive; the graph stays topologically correct as rows stream in.
- **AC-7 (Columns)**: Each history row shows graph cell, subject, author, a date in the chosen relative/absolute form, and the short hash; ref labels appear on the correct commits.
- **AC-8 (Filters)**: Applying author + path + date-range + message filters together returns only commits matching all constraints; clearing a chip widens results; a no-match filter shows the empty state, not an error or infinite spinner. Each filter maps to the documented `git log` flags.
- **AC-9 (Find)**: Typing in quick-find highlights matching loaded rows and next/prev steps through them with a live match count.
- **AC-10 (Details)**: Selecting a commit shows full + short hash, author and committer (name, email, date), full multi-line message, parent hashes (navigable), and all refs/tags pointing at it. Selecting a parent hash moves the selection to that parent.
- **AC-11 (Merge diff)**: Selecting a merge commit defaults the diff to first-parent; choosing another parent or the combined diff updates the changed-file list and patches accordingly.
- **AC-12 (Diff modes)**: The user can switch inline/side-by-side, toggle whitespace, change context lines, and navigate next/prev change; syntax highlighting is present; preferences persist.
- **AC-13 (File at revision)**: The user can open any changed file's full content at the commit's revision in a read-only viewer with line numbers and highlighting.
- **AC-14 (Binary/submodule/large)**: A binary file shows a binary placeholder (no text hunks); a submodule change shows old→new commit hashes; a file above the size threshold shows a deferred placeholder with a working "Load anyway".
- **AC-15 (Read-only)**: No Phase 1 action mutates the repository; no mutating lock is taken; concurrent reads succeed; superseded requests are canceled and never overwrite newer results.

## Edge cases & error handling

- **Empty repository (unborn HEAD)**: History is empty (empty state, not an error); status shows the unborn branch; no diffs/details available; opening still succeeds. Backed by `git rev-parse --quiet --verify HEAD` returning empty.
- **Detached HEAD**: Status marks detached with the short hash; ahead/behind "—"; current-branch history scope uses `HEAD`. No mutation offered.
- **Mid-operation repository** (merge/rebase/cherry-pick/revert/bisect in progress): Surface a read-only state label only; Phase 1 does not offer to continue/abort (deferred to later phases).
- **Very large history (100k+ commits)**: Must stay responsive via virtualization + streaming; counts/totals computed lazily; jumping to a hash loads enough history to reveal it without loading everything.
- **Binary files**: Detected via numstat `-`/`-`; rendered as a binary placeholder with sizes; never rendered as text hunks.
- **Submodule (gitlink) entries**: Rendered as submodule path with old/new pointed-to commit hashes; not text-diffed; listed with a distinct status icon.
- **Large individual files/diffs**: Deferred above a configurable threshold with an explicit "Load anyway"; size obtained via `git cat-file -s` / numstat to decide.
- **Renames and copies**: Detected with `--find-renames`/`--find-copies`; both paths and similarity shown; correctly parsed from `-z` output.
- **Non-ASCII / unusual paths**: Handled losslessly via `-c core.quotePath=false` and `-z`-separated parsing.
- **Commit with no changes vs parent / root commit**: Root commit diffs against the empty tree (`--root`); an empty changed-file list shows an explicit "no changes" state.
- **Missing/unreachable upstream**: Ahead/behind reported as unknown (not zero) when `# branch.ab` is absent or the tracking ref is missing.
- **Concurrent repository switch**: Switching away cancels in-flight history/diff/detail requests for the old repo; late responses are discarded and never applied to the new repo's view.
- **Underlying git/object errors** (corrupt object, permission denied, missing blob): Surface a typed, panel-scoped error with retry; the view and service remain stable; other panels keep working.
- **git binary unavailable or too old**: Detected at startup via `git --version`; the user is shown a clear capability error rather than partial/silent failures.
- **Symlinks / unusual file modes**: Mode/type changes (`T` status) are shown distinctly; the diff reflects the type change rather than crashing.

## Out of scope

- Any mutation of the index, working tree, refs, stash, or remotes (staging, committing, checkout, branch/tag creation, fetch/pull/push) — these belong to Phase 2 and later. (`git clone` is out of scope entirely — cbranch opens existing on-disk repositories.)
- Working-tree and index diffs (uncommitted changes) in the diff viewer — Phase 2.
- Conflict resolution, merge/rebase continuation, and the 3-pane merge editor — Phase 4/5.
- Blame and line-level file history — Phase 4.
- Interactive rebase, reflog, bisect, archive, clean, gc/maintenance, submodule operations — Phase 5.
- Automatic filesystem watching / live status auto-refresh (Phase 1 refreshes on demand and optionally on focus only).
- Full GPG signature verification (presence indicator only, if shown at all).
- Image/rich binary previews beyond a basic binary placeholder (optional, not required).
- Multi-repository simultaneous views (cbranch operates on one repository at a time).
- The VSCode webview extension surface (parallel track after the core stabilizes).
