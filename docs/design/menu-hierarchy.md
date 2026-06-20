# cbranch Menu Hierarchy

The full top-menu structure for the cbranch desktop-style shell (see
[`desktop-layout-parity.md`](desktop-layout-parity.md) §2.2). This is a forward design spec: it lists
every menu, its items, grouping (separators shown as `---`), and a one-line description of what each
command does.

**Phase tags** map each command to its delivery phase so the coding agent knows what should be wired vs.
rendered-but-inert early on:

- `P1` browse/read-only · `P2` stage & commit · `P3` branches/sync/worktrees/stash/tags ·
  `P4` cherry-pick/conflicts/blame · `P5` power features (rebase/reflog/bisect) · `—` shell/always-on ·
  `(later)` post-MVP / out of current scope.

Items marked `(later)` should still appear (greyed/disabled) to preserve the dense desktop feel, unless
noted otherwise. Captions ending in `...` open a dialog/panel; the rest act immediately or toggle state.

Top-level order: **Start · Repository · Navigate · View · Commands · GitHub · Plugins · Tools · Help**.

---

## Start

Repo lifecycle and app entry. Visible on the dashboard (no repo open) and in the main shell.

```txt
Start
  Create new repository...     P3   Init a new git repo at a chosen path.
  Open...                      P1   Open an existing repo by on-server path (primary entry point).
  Favorite repositories        —    Submenu: pinned repos for quick switching.
  Recent repositories          —    Submenu: most-recently-opened repos (MRU list).
  ---
  Clone repository...      (later)   Out of MVP scope — user clones via ssh, then Open...s the path.
  ---
  Exit                         —    Close the app / return to the dashboard.
```

> Note: `Clone repository...` is descoped for the MVP (the user clones over ssh manually and points
> cbranch at the on-server path). Keep the item present but disabled, or omit until the clone phase.

---

## Repository

Repo-wide maintenance and configuration for the currently open repo.

```txt
Repository
  Refresh                      P1   Re-read refs/status/history from disk.
  # File Explorer                —    Reveal the repo's working dir in the host file browser (host-side).
  ---
  Remote repositories...       P3   Manage remotes (add/edit/remove URLs, fetch refspecs).
  ---
  Manage submodules...     (later)   Init/update/sync submodules.
  Update all submodules    (later)   Recursively update every submodule.
  Synchronize all submodules (later) Sync submodule URLs from .gitmodules.
  ---
  Manage worktrees...          P3   List/add/remove linked worktrees.
  ---
  Edit .gitignore          (later)   Open .gitignore in the editor (authoring is out of MVP scope).
  Edit info/exclude        (later)   Open .git/info/exclude.
  Edit .gitattributes      (later)   Open .gitattributes.
  Edit .mailmap            (later)   Open .mailmap.
  Sparse working copy      (later)   Configure sparse-checkout (out of MVP scope).
  ---
  Maintenance                  P3   Submenu (see below).
    Compress git database      P3   Run gc / repack.
    Recover lost objects...    P5   Browse dangling objects (fsck/reflog recovery).
    Delete index.lock          —    Remove a stale index.lock left by a crashed process.
    Edit config                P3   Open the repo-level git config.
  Repository settings...       P3   Per-repo settings (identity, hooks display, etc.).
  ---
  Close (go to Dashboard)      —    Close the repo and return to the dashboard.
```

---

## Navigate

Move the selection within the history graph. (Mostly keyboard-driven; mirrors the revision-grid commands.)

```txt
Navigate
  Toggle artificial / HEAD commits   P2   Jump between the working-dir/index rows and HEAD.
  Go to current revision             P1   Select the checked-out commit (HEAD).
  Go to commit...                    P1   Jump to a commit by hash/ref (input box).
  Go to child commit                 P1   Move to a child of the selected commit.
  Go to parent commit                P1   Move to the first parent.
  Go to first parent commit          P1   Move to parent #1 of a merge.
  Go to last parent commit           P1   Move to the last parent of a merge.
  Go to common ancestor (merge base) P1   Select the merge base of the selected commits / HEAD.
  ---
  Navigate backward                  P1   Go back in the selection history (like a browser back).
  Navigate forward                   P1   Go forward in the selection history.
  ---
  Quick search                       P1   In-grid incremental search of visible commits.
  Quick search previous              P1   Previous quick-search match.
  Quick search next                  P1   Next quick-search match.
```

---

## View

Toggle what the history graph shows and which columns are visible. All `P1` (read-only display state).

```txt
View
  Show all branches            P1   Graph includes every local + remote branch.
  Show current branch only     P1   Graph limited to the checked-out branch.
  Show filtered branches       P1   Graph limited to the active branch filter.
  Show reflog references       P5   Include reflog entries as graph tips.
  ---
  Advanced filter...           P1   Open the full history-filter dialog (path/author/date/message).
  ---
  Draw non-relatives gray      P1   Dim commits not reachable from the selection.
  Highlight selected branch    P1   Emphasize the selected branch's lane until next refresh.
  ---
  Show artificial commits      P2   Show the synthetic working-dir / index rows at the top.
  Show stashes                 P3   Render stash entries inline in the graph.
  Show git notes               (later)  Show attached git notes.
  ---
  Show remote branches         P1   Include remote-tracking refs as labels.
  Show tags                    P1   Include tag labels.
  Show superproject tags       (later)  Show tags from the parent (super)project.
  Show superproject branches   (later)  Show branches from the parent (super)project.
  ---
  Show commit-message body     P1   Show the message body, not just the subject, in details.
  Show author date             P1   Use author date (vs. commit date) in the time column.
  Show relative date           P1   "8 hours ago" vs. absolute timestamps.
  Show build status icon       (later)  CI status glyph per commit.
  Show build status text       (later)  CI status text per commit.
  ---
  Show revision graph column   P1   Toggle the graph lane column.
  Show author avatar column    P1   Toggle the avatar/initials column.
  Show author name column      P1   Toggle the author column.
  Show date column             P1   Toggle the date column.
  Show SHA column              P1   Toggle the short-hash column.
  ---
  Sort commits by author date  P1   Order by author date.
  Arrange by topo order        P1   Topological (ancestor) ordering.
  ---
  Save current view as default P1   Persist the current view toggles as the default.
```

---

## Commands

The core git actions on the open repo / selected revision. This is the workhorse menu.

```txt
Commands
  Commit...                    P2   Open the stage & commit panel.
  Undo last commit...          P2   Soft-reset HEAD by one, keeping changes staged.
  Pull / Fetch...              P3   Fetch and optionally merge/rebase from a remote.
  Push...                      P3   Push the current branch (with upstream / force options).
  ---
  Manage stashes...            P3   Create/apply/pop/drop stashes.
  Reset changes...             P2   Discard working-dir/index changes (with confirmation).
  Clean working directory...   P2   Remove untracked files/dirs (dry-run preview first).
  ---
  Create branch...             P3   Branch from the selected commit / HEAD.
  Delete branch...             P3   Delete local (and optionally remote) branches.
  Checkout branch...           P3   Switch the working tree to a branch.
  Merge branches...            P3   Merge another branch into the current one.
  Rebase...                    P5   Rebase the current branch (incl. interactive).
  Solve merge conflicts...     P4   Open the 3-way conflict resolver (in-app / kdiff3).
  ---
  Create tag...                P3   Create a lightweight or annotated tag.
  Delete tag...                P3   Delete a tag (local / remote).
  ---
  Cherry pick...               P4   Apply the selected commit(s) onto the current branch.
  Archive revision...      (later)  Export a tree as a zip/tar archive.
  Checkout revision...         P3   Detached-checkout an arbitrary commit.
  Bisect...                    P5   Start/advance a good/bad bisect session.
  Show reflog...               P5   Browse the reflog.
  ---
  Format patch...          (later)  Export commits as .patch files.
  Apply patch...           (later)  Apply a .patch / mailbox file.
  View patch file...       (later)  Open and inspect a patch without applying.
```

---

## GitHub

Integration with the GitHub remote (the user's host). Optional; depends on host-side git credentials.

```txt
GitHub
  Fork / Clone repository... (later)  Fork or clone a GitHub repo (tied to the descoped clone flow).
  View pull requests...      (later)  List PRs for the repo.
  Create pull request...     (later)  Open a PR from the current branch.
  Add upstream remote        (later)  Add the parent repo as `upstream` for a fork.
```

> The entire GitHub menu is post-MVP. Keep the top-level menu present (it sets the desktop feel) but its
> items disabled until a forge-integration phase. Auth is handled out-of-band at the host (perimeter
> trust model), not by cbranch.

---

## Plugins

Extension point. cbranch ships no plugin system in the MVP; the menu is a placeholder.

```txt
Plugins
  (no plugins loaded)        (later)  Populated dynamically when a plugin host exists.
  ---
  Plugin settings...         (later)  Configure installed plugins.
```

---

## Tools

External tooling and app-level diagnostics. The original desktop launchers (Git bash, Git GUI, GitK,
PuTTY) are Windows-desktop-specific and **do not apply** to cbranch's cross-platform / web-over-SSH model;
they are replaced below with cbranch-appropriate equivalents.

```txt
Tools
  Open terminal here       (later)  Open a shell at the repo path on the host (if a terminal surface exists).
  ---
  Git command log              —    Show the actual git commands cbranch has run (transparency / debugging).
  ---
  Settings...                  —    Open app-level settings (theme, editor, diff, paths).
```

> Dropped vs. the desktop reference: `Git bash`, `Git GUI`, `GitK`, and the `PuTTY` ssh-agent submenu —
> all Windows-desktop tools with no place in a remote/web client. `Git command log` is kept (and
> valuable) because cbranch shells out to host git; surfacing the exact commands aids trust and debugging.

---

## Help

Docs, feedback, and about. Mostly always-on.

```txt
Help
  User manual                  —    Open cbranch documentation.
  Changelog                    —    Show release notes for the running version.
  ---
  Translate                (later)  Link to the localization workflow.
  ---
  Report an issue              —    Open the issue tracker / bug-report flow.
  Check for updates        (later)  Self-update is out of scope; link to releases instead.
  About                        —    Version, license (MIT), and credits.
```

> Dropped vs. the desktop reference: the `Donate` and telemetry-consent items. If cbranch ever adds
> optional telemetry, gate it behind an explicit opt-in in `Settings...`, not a Help-menu toggle.

---

## Implementation notes for the coding agent

- **Render the full chrome from day one.** Even in P1, show all nine top menus with their items so the
  layout reads as a dense desktop client. Disable (grey) anything not yet wired rather than hiding it.
- **Single source of truth for enablement.** Drive each item's enabled/visible state from a capability +
  phase flag, not ad-hoc conditionals, so later phases just flip flags.
- **Captions are functional, not branded.** Use plain git terminology; do not reuse any third-party
  product's branding for menu titles or icons.
- **Keyboard parity.** Navigate/View commands are primarily keyboard-driven in desktop git clients;
  assign accelerators and show them in the menu (right-aligned), even before all commands are live.
- **Context menus reuse these commands.** The revision-grid right-click menu is a subset of Commands +
  Navigate; implement the command set once and surface it in both places.
