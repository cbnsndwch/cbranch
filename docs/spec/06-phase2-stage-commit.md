# Phase 2 — Stage & Commit

## Purpose

Phase 2 makes cbranch a tool a developer can use to **record work**, not just read it. It adds the full local commit loop on top of the Phase 1 read-only browser: inspect the working tree, choose exactly what to record (whole files, hunks, or individual lines), discard or reset changes when needed, and author a commit with the metadata Git supports (subject/body, amend, sign-off, GPG signature, author override).

All operations in this phase are **local** to the on-disk repository on the host. No network sync (fetch/pull/push) is in scope here. Per the locked architecture, every Git operation runs through the single host-`git` backend behind the `GitEngine` interface; mutating operations are serialized per repository behind a lock (an `Effect.Semaphore(1)` keyed by `repoId`), while reads (status, diffs, object reads via the `git cat-file --batch` pool) do not take the lock.

This phase is independently shippable: when complete, a developer can take a dirty working tree and produce a clean, well-formed commit entirely from the browser.

## User stories

- As a developer, I want to see every changed, untracked, and staged path with its status so I know what a commit would capture.
- As a developer, I want to stage or unstage one or several files in a single action so I can assemble a commit quickly.
- As a developer, I want to stage only some hunks or lines of a file so a single commit stays focused.
- As a developer, I want to discard working-tree changes to a file or hunk when an edit was a mistake, with a clear warning that the change is unrecoverable.
- As a developer, I want to unstage everything (reset index) or move HEAD (soft/mixed/hard) when I need to restructure what I have, with strong guards before anything destructive.
- As a developer, I want to write a commit message with a subject and body, optionally amend the previous commit, add a `Signed-off-by` trailer, GPG-sign it, or override the author.
- As a developer, I want to reuse the previous commit message or get light conventional-commit assistance so I don't retype boilerplate.
- As a developer, I want to be stopped (not silently allowed) from committing when nothing is staged.

## Functional requirements

Requirement IDs are stable. Each is testable and describes observable behavior.

### Status & the change list

- **REQ-P2-STATUS-001** — cbranch MUST present the current working-tree state as a list of entries, each carrying: path; whether it is staged, unstaged, or both; and a change kind (added, modified, deleted, renamed, copied, type-changed, untracked, ignored-but-shown-on-request, or conflicted/unmerged).
- **REQ-P2-STATUS-002** — A single path that has **both** staged and unstaged changes MUST be representable as such (e.g., a staged modification plus a later unstaged edit to the same file). The UI MUST be able to show the staged portion and the unstaged portion of that path independently.
- **REQ-P2-STATUS-003** — Renames and copies MUST display both the original and new path and the similarity score reported by Git.
- **REQ-P2-STATUS-004** — Untracked files MUST be listed and stageable. Ignored files MUST NOT be listed by default but MAY be shown via an explicit toggle.
- **REQ-P2-STATUS-005** — Unmerged/conflicted paths MUST be surfaced as a distinct state. Full conflict **resolution** UI is Phase 4; in Phase 2 these paths MUST be shown and MUST NOT be silently committed (see REQ-P2-COMMIT-GUARD).
- **REQ-P2-STATUS-006** — The change list MUST refresh after every mutating action performed through cbranch, and MUST be refreshable on demand. Paths MUST be parsed/transported in a way that is safe for filenames containing spaces, quotes, or non-ASCII bytes (see Git operations: NUL-delimited porcelain).

### Whole-file staging (batch)

- **REQ-P2-STAGE-001** — The user MUST be able to stage one selected file.
- **REQ-P2-STAGE-002** — The user MUST be able to stage **multiple** selected files in one action (batch). Staging "all" MUST be available as a single action.
- **REQ-P2-STAGE-003** — The user MUST be able to unstage one or multiple selected files in one action, and "unstage all" MUST be available.
- **REQ-P2-STAGE-004** — Staging a deletion (a tracked file removed from the working tree) MUST record the deletion in the index. Unstaging it MUST move it back to an unstaged deletion (it MUST NOT restore file contents).
- **REQ-P2-STAGE-005** — Staging an untracked file MUST add it to the index as a new file.
- **REQ-P2-STAGE-006** — Each stage/unstage action MUST report success or a precise error, and MUST leave the index in a consistent state (no partial batch with an unreported failure).

### Discard & reset

- **REQ-P2-DISCARD-001** — The user MUST be able to discard **unstaged** working-tree changes for a selected file, restoring it to its staged/HEAD content. This is destructive (working-tree data is lost) and MUST be behind a confirmation guard (REQ-P2-GUARD-001).
- **REQ-P2-DISCARD-002** — The user MUST be able to delete an **untracked** file from the working tree (a separate, clearly labeled action distinct from "discard tracked changes"), behind the same confirmation guard.
- **REQ-P2-RESET-001** — The user MUST be able to reset the index to HEAD (unstage everything) without touching the working tree.
- **REQ-P2-RESET-002** — The user MUST be able to perform a **soft** reset to a chosen commit (move HEAD, keep index and working tree).
- **REQ-P2-RESET-003** — The user MUST be able to perform a **mixed** reset to a chosen commit (move HEAD, reset index, keep working tree).
- **REQ-P2-RESET-004** — The user MUST be able to perform a **hard** reset to a chosen commit (move HEAD, reset index and working tree — destructive).
- **REQ-P2-GUARD-001** — Every destructive action (discard tracked changes, delete untracked file, hard reset) MUST require an explicit confirmation that states what will be permanently lost and is **not** auto-dismissable by a stray keypress. Soft and mixed resets, which do not destroy working-tree edits, MUST inform the user of their effect but MAY use a lighter confirmation.
- **REQ-P2-GUARD-002** — A hard reset and a discard MUST never run as an implicit side effect of another action; they MUST be a distinct, intentional user choice.

### Hunk- and line-level staging

- **REQ-P2-HUNK-001** — In the diff view of a file, the user MUST be able to select an individual **hunk** and stage it, unstage it (when viewing the staged side), or discard it (unstaged side only), independently of the rest of the file.
- **REQ-P2-HUNK-002** — The user MUST be able to select **individual lines** (a subset of a hunk, including non-contiguous added/removed lines) and stage, unstage, or discard exactly that selection.
- **REQ-P2-HUNK-003** — After a partial stage, the change list MUST reflect the file as having both staged and unstaged portions (REQ-P2-STATUS-002), and re-opening the diff MUST show the remaining unstaged changes correctly.
- **REQ-P2-HUNK-004** — Partial staging MUST be a precise outcome: the bytes the user selected (and only those) end up in the index; the rest remain in the working tree. The implementer MAY achieve this by constructing a patch and applying it to the index (e.g., `git apply --cached --recount`) or by rewriting the index directly — the **outcome** is normative, the method is not.
- **REQ-P2-HUNK-005** — Partial **discard** of unstaged lines/hunks MUST remove exactly the selected changes from the working tree and is destructive — it MUST be behind the confirmation guard (REQ-P2-GUARD-001).
- **REQ-P2-HUNK-006** — When a selected line/hunk cannot be applied cleanly (e.g., the working tree changed underneath, context no longer matches), cbranch MUST fail the operation atomically (no partial application), refresh status, and report a clear, actionable error. It MUST NOT leave a half-applied patch.

### Commit

- **REQ-P2-COMMIT-001** — The user MUST be able to author a commit with a **subject** line and an optional multi-line **body**, and create the commit from the currently staged content.
- **REQ-P2-COMMIT-GUARD** — cbranch MUST refuse to create a commit when nothing is staged, and MUST explain why, unless the user explicitly chooses **amend** (which can proceed with an empty staged set to edit message/metadata) or explicitly opts into an allowed-empty commit. Committing with unresolved conflict markers / unmerged paths MUST be blocked with a clear message.
- **REQ-P2-COMMIT-AMEND** — The user MUST be able to **amend** the last commit: the editor MUST pre-fill with the previous commit's message, and the resulting commit MUST replace `HEAD` (combining any staged changes with the previous commit's tree). The UI MUST warn that amending rewrites the last commit and SHOULD warn if `HEAD` was already pushed (best-effort, based on tracking info available locally).
- **REQ-P2-COMMIT-SIGNOFF** — The user MUST be able to toggle adding a `Signed-off-by: Name <email>` trailer derived from the committer identity.
- **REQ-P2-COMMIT-GPG** — The user MUST be able to toggle **GPG signing** of the commit. If signing fails (e.g., no key, passphrase prompt required, agent unavailable), the commit MUST NOT be silently created unsigned; the failure MUST be reported with the underlying message.
- **REQ-P2-COMMIT-AUTHOR** — The user MUST be able to override the **author** (name and email) for the commit independently of the committer identity.
- **REQ-P2-COMMIT-002** — On success, cbranch MUST show the new commit's short hash and subject, clear the message editor (unless amending kept context), and refresh the status and history views.
- **REQ-P2-COMMIT-003** — Commit identity, the working subject/body draft, and toggle states (sign-off, GPG, amend, author override) MUST be retained while the user is composing; a draft message SHOULD survive view navigation within the same repository session so work is not lost.

### Message helpers

- **REQ-P2-MSG-001** — The user MUST be able to **reuse the previous commit message** (load `HEAD`'s message into the editor) with one action.
- **REQ-P2-MSG-002** — cbranch SHOULD offer optional **conventional-commit assistance**: a way to pick a type (feat, fix, docs, refactor, etc.), an optional scope, and a `!`/`BREAKING CHANGE` indicator, composing the subject prefix `type(scope): `. This MUST be optional and easily bypassed; it MUST NOT block free-form subjects.
- **REQ-P2-MSG-003** — The editor SHOULD surface a soft guide for subject length (commonly ~50 chars) and a blank line between subject and body, without hard-blocking the user.

## Git operations

This lists the exact subcommands cbranch invokes through the single host-`git` backend behind the `GitEngine` interface, and what output is parsed. Object reads use the per-repo `git cat-file --batch`/`--batch-check` process pool; read commands pass `--no-optional-locks`. Every mutating call holds the per-repo lock (`Effect.Semaphore(1)` keyed by `repoId`) for its duration.

### Reading status and diffs

- **Status:** `git status --porcelain=v2 -z [--untracked-files=all] [--branch]`
  - Parsed: per-path two-character XY staged/unstaged codes, change kinds, rename/copy similarity scores and the original→new paths, submodule state field, and unmerged states. NUL (`-z`) delimiting MUST be used so arbitrary filenames are handled without quoting ambiguity. Optional `--branch` header gives current branch and ahead/behind for the amend-already-pushed hint.
- **Unstaged diff (working tree vs index):** `git diff -z [-- <path>]`
- **Staged diff (index vs HEAD):** `git diff --cached -z [-- <path>]`
  - Parsed: unified diff hunks (`@@ -a,b +c,d @@`), per-line origin (` `/`+`/`-`), file mode changes, binary-file markers, and rename headers. These hunks back the hunk/line selection UI.

### Staging / unstaging (whole file)

- **Stage tracked modifications/deletions and untracked files:** `git add -- <paths…>` (and `git add -A` for "stage all", scoped appropriately). Staging a deletion is naturally handled by `git add -- <deleted-path>` or `git rm --cached`/`git rm` as appropriate to the intended outcome.
- **Unstage (restore index entry to HEAD):** `git restore --staged -- <paths…>`. ("Unstage all" applies this across the staged set, or resets the index — see reset.)
- **Remove a tracked file (stage a deletion explicitly):** `git rm -- <paths…>` (working-tree + index) or `git rm --cached -- <paths…>` (index only).

### Discard / reset

- **Discard unstaged tracked changes:** `git restore --worktree -- <paths…>` (destructive — guarded).
- **Delete an untracked file:** removal of the untracked path from the working tree (e.g., `git clean -f -- <path>` scoped to the explicit path, or an equivalent fs delete) — destructive, guarded, and clearly distinguished from discarding tracked edits.
- **Unstage everything:** `git reset` (mixed reset to HEAD, working tree untouched).
- **Soft / mixed / hard reset to a commit:** `git reset --soft <commit>` / `git reset --mixed <commit>` / `git reset --hard <commit>`. `--hard` is destructive and guarded (REQ-P2-GUARD-001/002).

### Partial (hunk/line) staging — outcome-defined

cbranch constructs a minimal unified diff representing exactly the user's line/hunk selection and applies it to the index, then refreshes status. The authoritative patch-construction rule (including synthesizing patch headers for **new files** (`/dev/null` + new mode) and **deletions**, and byte-faithful reconstruction under `autocrlf`/`.gitattributes` so EOLs are not corrupted) is defined in `14-rpc-contract.md` §7. A reference approach is:

- **Stage a selection:** `git apply --cached --recount -` with the constructed patch on stdin.
- **Unstage a selection:** apply the reverse of the selection with `git apply --cached --reverse --recount -` (or an equivalent index rewrite).
- **Discard a selection (unstaged):** `git apply --recount [--reverse] -` against the working tree (destructive — guarded).

`--recount` is used so the patch need not carry exact line counts. Application MUST be atomic; on any reject the whole operation fails and status is re-read. The implementer MAY instead rewrite the index tree directly to achieve the identical outcome; the patch-apply route is illustrative, not mandated.

### Commit

- **Base:** `git commit` driven by message and flags. Multi-line messages are passed safely (e.g., `-F -` reading the message from stdin, or repeated `-m` for subject/body) to avoid shell-quoting issues with arbitrary message content.
- **Amend:** `git commit --amend -F -` (message pre-filled from `git log -1 --format=%B`).
- **Sign-off:** add `--signoff`.
- **GPG sign:** add `-S` (or `-S<keyid>` when a key is specified). A signing failure MUST surface as an error, not a silent unsigned commit.
- **Author override:** add `--author="Name <email>"`.
- **Allowed-empty (explicit only):** `--allow-empty` when the user has deliberately chosen it.
- **Reuse previous message:** read via `git log -1 --format=%B` (or equivalent) to populate the editor.

cbranch parses the success output for the new commit's short hash and subject to satisfy REQ-P2-COMMIT-002, and refreshes status/history.

## UI/UX requirements

Expressed functionally in terms of the locked stack (React 19 + shadcn/ui `base-lyra` on Base UI + Tailwind v4; Lucide icons; @tanstack/react-virtual; @tanstack/react-query + Zustand; react-diff-view; CodeMirror 6 + @codemirror/merge; cmdk). The commit-message composer is plain text (a minimal CodeMirror 6 instance or textarea), not a rich-text editor.

- **UX-P2-001 — Change list:** A virtualized list (`@tanstack/react-virtual`) splits into **Staged** and **Unstaged/Untracked** groups (or shows a per-row staged/unstaged indicator), each row using a shadcn list item with a Lucide status glyph, the path (renames shown as `old → new`), and a similarity badge where relevant. The list MUST stay responsive with thousands of entries.
- **UX-P2-002 — Selection & batch:** Rows support multi-select (checkbox / shift-click). A toolbar exposes **Stage selected**, **Unstage selected**, **Stage all**, **Unstage all**. Row-level quick actions (stage/unstage/discard) appear on hover/focus and are keyboard reachable.
- **UX-P2-003 — Diff & partial staging:** Selecting a file opens its diff via `react-diff-view`. Each hunk has **Stage hunk / Unstage hunk / Discard hunk** controls. Line selection (click-drag or shift-select across gutter) enables **Stage lines / Unstage lines / Discard lines**. The staged side and unstaged side of a file with mixed state are switchable (tabs or a segmented control), satisfying REQ-P2-STATUS-002.
- **UX-P2-004 — Commit panel:** A commit composer with a subject input and a multi-line body editor (CodeMirror 6, soft subject-length guide per REQ-P2-MSG-003). Toggles (shadcn `Switch`/`Checkbox`) for **Amend**, **Sign-off**, **GPG sign**; an expandable **Author override** with name/email fields. A primary **Commit** button is disabled (with an explanatory tooltip) when the commit guard (REQ-P2-COMMIT-GUARD) is unsatisfied.
- **UX-P2-005 — Message helpers:** A **Reuse last message** action and an optional **Conventional commit** assist (type Select, scope input, breaking-change toggle) that composes the subject prefix; both are dismissable and never block free-form input.
- **UX-P2-006 — Destructive confirmations:** Discard, untracked-file delete, and hard reset use a shadcn `AlertDialog` that names the exact paths/effect and the irreversibility, with the destructive action visually distinct and not the default focus. Soft/mixed resets use a lighter confirmation describing their effect.
- **UX-P2-007 — Command palette:** cmdk exposes the major actions (Stage all, Unstage all, Commit, Amend, Reuse last message, Reset…) for keyboard-first use.
- **UX-P2-008 — Feedback:** Every mutating action shows a transient success/error notification; errors include the underlying Git message. While an action is in flight, affected controls reflect a busy state (the per-repo lock serializes mutations).
- **UX-P2-009 — Draft persistence:** The in-progress message and toggle states persist in UI state (Zustand) across view navigation within the repo session (REQ-P2-COMMIT-003).

## Acceptance criteria

- **AC-1** — With a mix of staged, unstaged, untracked, deleted, and renamed paths, the change list shows each with the correct state and kind; renames show `old → new` and a similarity score. Verified against `git status --porcelain=v2 -z`.
- **AC-2** — Selecting three files and clicking **Stage selected** stages exactly those three and nothing else; **Unstage all** then empties the staged set. Verified via `git diff --cached --name-status`.
- **AC-3** — Staging a single hunk of a multi-hunk file results in that hunk's lines being in the index and the remaining hunks staying unstaged; the file appears in both staged and unstaged groups. Verified via `git diff` / `git diff --cached`.
- **AC-4** — Staging a hand-picked set of individual lines (including non-contiguous) stages exactly those lines; re-opening the diff shows precisely the remainder unstaged.
- **AC-5** — Discarding an unstaged change requires confirmation and, on confirm, restores the file to its staged/HEAD content; the action is absent silently nowhere.
- **AC-6** — A hard reset requires explicit confirmation naming data loss; soft and mixed resets move HEAD/index as specified without destroying working-tree edits.
- **AC-7** — Committing with nothing staged is blocked with an explanation; with content staged, a commit with subject+body is created, and its short hash and subject are displayed; status and history refresh.
- **AC-8** — Amend pre-fills the previous message, warns about rewriting HEAD, and produces a commit replacing the prior HEAD; sign-off adds a correct `Signed-off-by` trailer; author override is reflected in `git log` author fields; GPG sign produces a signature (verifiable via `git log --show-signature`) or reports a clear failure without creating an unsigned commit.
- **AC-9** — All file/path operations work for filenames with spaces, quotes, and non-ASCII characters (NUL-delimited parsing).
- **AC-10** — A failed partial-stage (non-applying patch) leaves the index and working tree unchanged and reports an actionable error.

## Edge cases & error handling

- **CRLF / autocrlf:** When `core.autocrlf`/`.gitattributes` normalize line endings, a file may appear modified due to EOL only. Diffs and partial staging MUST operate on Git's view of content so that staged hunks match what Git records; cbranch MUST NOT corrupt EOLs when reconstructing patches. A whitespace/EOL-only change MUST still be stageable and committable.
- **Whitespace-only changes:** Must be visible and stageable; cbranch MUST NOT hide them. Any whitespace-ignoring view option is display-only and MUST NOT alter what gets staged.
- **New (untracked) file — partial stage:** Staging selected lines of a brand-new file MUST be supported by constructing an add-with-selected-lines patch; the unselected remainder stays untracked/unstaged. Staging the whole new file adds it normally.
- **Deleted file:** Staging a deletion records it; the diff shows all lines removed. Partial-staging a deletion (keeping some lines) MUST either be supported via the patch route or clearly offered as whole-file only; behavior MUST be consistent and reported.
- **Renamed/copied file:** Status MUST present rename/copy with similarity; staging/unstaging MUST preserve the rename relationship where Git does. Editing content of a renamed file yields mixed states that MUST display correctly.
- **Binary files:** Partial (hunk/line) staging is **not** meaningful for binary files; cbranch MUST offer only whole-file stage/unstage/discard for binaries and clearly indicate that line-level operations are unavailable.
- **Mixed staged + unstaged in one file:** Fully supported (REQ-P2-STATUS-002); the diff UI must let the user act on each side without one clobbering the other. Re-staging after further edits MUST be additive/correct, never silently dropping prior staged content.
- **Mode-only changes (executable bit, symlink):** A change to file mode with no content change MUST be stageable and shown as a mode change.
- **Unmerged/conflicted paths:** Shown distinctly; commit blocked until resolved (resolution UI is Phase 4). Attempting to stage a conflicted path follows Git's semantics (staging marks resolution) and MUST be reflected accurately, but auto-committing over markers is prevented.
- **Empty repository (no HEAD yet):** The first commit has no parent and amend/reuse-last-message are unavailable; the UI MUST reflect this gracefully rather than erroring.
- **GPG signing failures:** Missing key, locked key, or agent prompt required MUST surface a clear error; no unsigned commit is silently produced.
- **Patch application rejects:** If the working tree changed between reading the diff and applying a partial-stage patch, the operation MUST fail atomically, refresh status, and ask the user to retry.
- **Detached HEAD:** Commits are still permitted; the UI MUST clearly indicate detached-HEAD state and the implications.
- **Concurrent mutation:** The per-repo lock serializes operations; if the working tree is changed by an external process mid-action, cbranch MUST detect the inconsistency on refresh and present the new truth rather than acting on stale state.
- **Hooks:** Pre-commit/commit-msg hooks may modify the message or block the commit; cbranch MUST surface hook output and a hook-induced failure as a normal, visible error (and MUST NOT bypass hooks unless the user explicitly requests it).

## Out of scope

- Network sync: fetch, pull, push (Phase 3). (`git clone` is out of scope entirely — cbranch opens existing on-disk repositories.)
- Branch creation/switch/merge, tags, stash, worktrees (Phase 3).
- Conflict **resolution** UI / 3-pane merge editor, cherry-pick, blame, file history (Phase 4).
- Interactive rebase, reflog, bisect, archive, clean (beyond the explicit untracked-file delete above), gc/maintenance, submodule operations, settings (Phase 5).
- The VSCode webview extension (parallel track after core stabilizes); Phase 2 behavior is defined against the web transport but MUST remain transport-agnostic at the `GitEngine`/RPC boundary.
