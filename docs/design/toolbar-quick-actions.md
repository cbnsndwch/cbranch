# cbranch Quick-Actions Bar (Toolbar)

Specifies the dense icon toolbar below the menu bar (see
[`desktop-layout-parity.md`](desktop-layout-parity.md) §2.3). Two rows:

1. **Primary actions toolbar** — repo/navigation/git-action buttons.
2. **Filter toolbar** — history scope and filter controls.

Icons are named from the **Lucide** set (the project's icon library). Every entry gives the closest Lucide
icon, the visible tooltip, the control kind, and a phase tag. Buttons are ~20×20px icons with a tooltip on
hover (see layout spec); most are icon-only.

**Phase tags:** `P1` browse · `P2` stage & commit · `P3` branches/sync/worktrees/stash/tags ·
`P4` conflicts · `P5` power · `—` shell/always-on · `(later)` post-MVP. Render every button from P1; grey
the ones whose phase isn't live yet.

**Kinds:** `button` (click) · `toggle` (on/off state) · `split` (primary click + dropdown caret) ·
`dropdown` (caret only) · `label` · `combo` (editable autocomplete input).

---

## 1. Primary actions toolbar

Left → right. `---` marks a separator (visual group divider).

| # | Lucide icon | Action | Tooltip | Kind | Phase |
|---|---|---|---|---|---|
| 1 | `refresh-cw` | Refresh | Refresh (re-read refs, status, history) | button | P1 |
| — | | --- | | | |
| 2 | `panel-left` | Toggle left panel | Show/hide the repository sidebar | toggle | P1 |
| 3 | `square-split-horizontal` | Toggle split layout | Switch history/details split between vertical and horizontal | toggle | P1 |
| 4 | `panel-bottom` | Commit info position | Where the commit details panel sits | split | P1 |
| — | | --- | | | |
| 5 | `boxes` | Submodules | Submodule actions / jump to superproject | split | (later) |
| 6 | `folder-tree` | Worktrees | Manage linked worktrees | split | P3 |
| 7 | `folder-git-2` | Working directory | Current repo path — click to switch repo | split | P1 |
| 8 | `git-branch` | Branch | Current branch — click to change branch | split | P1 / P3 |
| — | | --- | | | |
| 9 | `arrow-down-to-line` | Pull | Pull — fetch and integrate from remote | split | P3 |
| 10 | `arrow-up-from-line` | Push | Push the current branch to its remote | button | P3 |
| 11 | `git-commit-horizontal` | Commit | Commit staged changes | button | P2 |
| 12 | `archive` | Stashes | Stash / manage shelved changes | split | P3 |
| — | | --- | | | |
| 13 | `folder-open` | Reveal in files | Open the working directory in the host file browser | button | — |
| 14 | `terminal` | Open terminal | Open a shell at the repo path on the host | split | (later) |
| 15 | `settings` | Settings | Open app settings | button | — |

### Dropdowns (split / dropdown buttons above)

- **#4 Commit info position** (radio):
  - `panel-bottom` — Below the graph (default)
  - `panel-left` — Left of the graph
  - `panel-right` — Right of the graph
- **#5 Submodules** *(later)*: update all · synchronize all · manage submodules… · jump to superproject (`arrow-up-left`).
- **#6 Worktrees** `folder-tree`: list worktrees · add worktree… · manage worktrees…
- **#7 Working directory** `folder-git-2`: recent repos (MRU) · favorites · open another repo…
- **#8 Branch** `git-branch`: checkout branch… · create branch… (`git-branch-plus`) · merge into current… (`git-merge`)
- **#9 Pull** (primary = default action; configurable):
  - `git-merge` — Pull (merge)
  - `replace` — Pull (rebase)   *(P5 for rebase; otherwise greyed)*
  - `cloud-download` — Fetch
  - `cloud-download` — Fetch all
  - `scissors` — Fetch and prune all
  - --- 
  - `mouse-pointer-click` — Open pull dialog…
  - `pin` — Set default pull action
- **#12 Stashes** (primary = Stash):
  - `archive` — Stash
  - `archive` — Stash staged only
  - `archive-restore` — Stash pop
  - ---
  - `layers` — Manage stashes…
  - `archive-x` — Drop a stash
- **#14 Open terminal** *(later)*: lists available shells on the host.

> Commit button (#11) may show a **pending-change count** badge, e.g. `Commit (3)`, mirroring the layout
> spec's `Commit (0)`. Source the count from the `status` domain.

---

## 2. Filter toolbar

Controls the history graph's scope and filtering. All `P1` (read-only display state).

| # | Lucide icon | Action | Tooltip | Kind | Phase |
|---|---|---|---|---|---|
| 1 | `list-filter` | Advanced filter | Filter history by path, author, date, message… | split | P1 |
| 2 | `history` | Reflog refs | Show all reflog references in the graph | toggle | P5 |
| 3 | `eye` | Branch visibility | Choose which branches the graph shows | split | P1 |
| 4 | `git-branch` | Branches: | *(label)* | label | P1 |
| 5 | — | *(branch filter input)* | Filter by branch name (autocomplete) | combo | P1 |
| 6 | `filter` | Branch type | Filter branches by type | dropdown | P1 |
| — | | --- | | | |
| 7 | `search` | Filter: | *(label)* | label | P1 |
| 8 | — | *(revision filter input)* | Filter commits (autocomplete) | combo | P1 |
| 9 | `search` | Filter field | Which field the filter matches | dropdown | P1 |
| 10 | `git-fork` | First parent only | Show only first-parent history | toggle | P1 |

### Dropdowns

- **#1 Advanced filter** `list-filter`:
  - `filter-x` — Reset path filter
  - `filter-x` — Reset all revision filters
  - ---
  - `sliders-horizontal` — Advanced filter…
- **#3 Branch visibility** `eye` (radio):
  - All branches · Current branch only · Filtered branches
- **#6 Branch type** `filter` (multi-check): Local · Remote · Tag
- **#9 Filter field** `search` (radio): Commit message (default) · Committer · Author · Diff contains *(slow)*

---

## 3. Implementation notes for the coding agent

- **Icon-only with tooltips.** Buttons show only the Lucide glyph; the tooltip text in the tables above is
  the accessible name (`aria-label`) and hover tooltip. Labels (`Branches:`, `Filter:`) render as text.
- **Lucide names are exact.** Use them verbatim as imported component names (kebab-case → PascalCase, e.g.
  `git-commit-horizontal` → `GitCommitHorizontal`). If a name 404s in the installed Lucide version, pick
  the nearest sibling and note the swap — don't invent names.
- **Toggle state is visual.** `toggle` buttons reflect on/off via the active/pressed style from the
  `base-lyra` tokens, not a different icon (except where a paired open/close icon exists, e.g.
  `panel-left` ↔ `panel-left-close` — optional).
- **Split buttons:** primary region runs the default/last action; the caret opens the dropdown. The Pull
  default action is user-configurable (see #9 dropdown "Set default pull action").
- **Phase gating** is the same capability+phase flag pattern as the menu spec — a greyed button shows the
  tooltip plus a "available in a later phase" hint.
- **Adapted from the desktop reference:** the Windows shell launchers were collapsed into a single generic
  **Open terminal** (#14, host-side, post-MVP). No third-party tool branding is used for any icon or label.
- **Out of scope here:** a runtime "scripts"/custom-command toolbar exists in some desktop git clients;
  cbranch has no plugin/script host in the MVP, so that row is omitted (ties to the Plugins menu, also
  `(later)`).
