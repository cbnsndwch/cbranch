# Phase 7 — Shell Navigation, Filesystem Picker & Host Integrations

## Purpose

Phase 7 has three jobs.

1. **Finish wiring the desktop-style menu bar.** Large swaths of the **Navigate**
   and **View** menus are permanently greyed today — not because the underlying
   capability is missing, but because the menu-bar items are unwired (an item is
   enabled iff a handler is registered in `use-menu-actions.ts`). A handful are
   greyed by a plain **id mismatch** between `menu-model.ts` and the registered
   handlers (the feature is fully built and reachable from the palette/keyboard,
   yet the menu greys it out). This document re-states those wirings as fresh,
   testable requirements. Most are UI-only and mint **no new contract surface**;
   that is called out where it holds.

2. **Introduce a reusable filesystem explorer.** Every "select a repo/folder"
   surface in cbranch today is a raw text box where the user hand-types an absolute
   host path (Open repo, New repository destination, worktree path, …). Phase 7
   adds a single directory-listing RPC and a reusable **`<FilesystemPicker>`**
   component that those surfaces adopt. This is a **cross-cutting dependency** for
   the repository entry points below, so it is specified and sequenced **first**.

3. **Land the deferred host integrations, reconciled to v1 scope.** The Start,
   GitHub, Help, and Tools menus carry items deferred out of the MVP. Phase 7
   picks up the ones that fit the locked trust model — repository create entry
   points, Help & onboarding, a scoped GitHub read/URL surface, and (as an
   **isolated, off-by-default, security-gated track**) an embedded terminal —
   while explicitly keeping **clone/fork** and **plugins** out of scope.

All features in this phase obey the locked architecture (identical to `09`/`17`):

- All operations run **on the remote host** behind the single `GitEngine`
  interface (git operations) or, for the one deliberate non-git read primitive
  introduced here, a new transport-agnostic `core/src/fs/` module; the
  browser/webview is a pure view issuing typed RPC calls and rendering results.
- Every **mutating** operation is **serialized per repository** behind the
  `Effect.Semaphore(1)` repository lock, and after any mutation cbranch ensures
  subsequent reads reflect on-disk state via the filesystem watcher → invalidation
  bus (`15-sync-protocol.md`).
- Path-bearing inputs are contained per the security rules in `12` (NF-SEC-5/6).
  The filesystem-picker primitive is the one **deliberate exception** to per-repo
  containment (it browses *before* a repo is chosen); it substitutes an explicit
  **roots allow-list** as its bound (§Filesystem explorer).
- **Only `apps/web-server` opens a listening socket.** Any new channel introduced
  here (the terminal track) rides the web-server process and passes the existing
  `makeOriginGuard` before anything spawns; `core` never imports http/socket/ui.

> **Scope note.** Phase 7 is independent and à-la-carte like Phases 5 and 6: each
> feature area is separately shippable and separately gated. The **filesystem
> explorer (§FS)** should land first because the repository entry points depend on
> it. The **Navigate/View wiring (§NAV/§VIEW)** are cheap quick-wins that can land
> in parallel. **GitHub (§GH)** and especially the **terminal (§TERM)** are heavier
> and security-sensitive; the terminal in particular is recommended as an isolated
> later track and MAY be split into its own document if it slips this phase.

## User stories

- As a developer opening a repo, I want to **browse** the host filesystem to pick
  the folder instead of typing an absolute path from memory, with repo folders
  clearly badged.
- As a developer, I want the **Navigate** menu's "Go to commit…", "Go to current
  revision", and parent/child/find-next actions to actually work from the menu bar,
  not just from the keyboard.
- As a developer, I want the **View** menu's branch-scope, column-visibility, and
  label toggles to drive the graph, and to have those choices stick.
- As a developer starting fresh, I want a **Create new repository…** entry that is
  reachable from the Start menu (today it is greyed by an id typo) and uses the new
  folder picker for its destination.
- As a new user, I want **Help** to actually open the manual, changelog, keyboard
  shortcuts, and an About dialog that shows the real app and host-git versions.
- As a developer whose remote is on GitHub, I want to **open the repo/PR/commit on
  GitHub**, **add an `upstream` remote**, and (where host credentials exist)
  **list pull requests** — without cbranch ever storing a secret.
- As a power user, I want to **open a terminal** at the repo path on the host —
  understanding it is a real host shell — when the operator has explicitly enabled
  it.

## Functional requirements

REQ identifiers are stable. Each requirement is testable and describes
**observable** behavior. Requirements that light up an existing-but-greyed menu
item cite the menu-model id; the "enabled iff a handler is registered" capability
rule of `use-menu-actions.ts` is assumed throughout.

### Filesystem explorer + directory-listing RPC (sequence first)

> This is the cross-cutting dependency for §REPO's destination picker and for the
> Open-repo and worktree surfaces. It is a **read-only host-directory enumeration**
> primitive that **deliberately escapes** per-repo containment (NF-SEC-5/6 assume a
> *selected* repo; here we browse to choose one). Its bound is an explicit
> **roots allow-list**, not repo containment. The outer gate is unchanged: the
> service binds loopback by default and rejects off-allow-list `Origin`/`Host`
> before the engine runs (`12` NF-SEC-2/3), so the only caller is already inside
> the trusted loopback perimeter and already holds the operator's filesystem
> privileges — listing grants no privilege the caller lacks. That justification is
> load-bearing and MUST be stated in the implementation.

- **REQ-P7-FS-001** cbranch MUST expose a **directory-listing** read method
  (`fs.listDir`) that, given an absolute host path (or no path → the default
  root), returns the directory's immediate entries: for each, its **basename**
  (never a full path), a kind (`dir` / `file` / `symlink` / `other`), a hidden
  flag, and — for directories — whether the directory itself contains a `.git`
  (so the picker can badge repositories). One directory per call; the server
  **never** recurses.
- **REQ-P7-FS-002** The response MUST include the **resolved (realpath'd)**
  absolute directory listed, its `parent` (null when the path equals an allowed
  root, i.e. there is no "up"), a **breadcrumb** ancestor chain from the applicable
  root to the path, and the configured **roots** (label + path) for a roots
  selector.
- **REQ-P7-FS-003** `fs.listDir` MUST resolve every target against a configured,
  ordered **roots allow-list** and MUST reject (mapped to a `GitError`) any
  resolved target that is neither equal to nor a descendant of some allowed root.
  The default roots MUST be the user's **home directory** plus the **parent
  directories of the recent-repo list**; the host operator MAY widen the set via
  server config (a `CBRANCH_FS_ROOTS`-style variable, analogous to
  `CBRANCH_BIND_ADDRESS`). The **browser never sets the bounds**.
- **REQ-P7-FS-004** Symlinks MUST be handled TOCTOU-safely: the target is
  `realpath`'d **after** join and the allow-list is re-checked on the **resolved**
  path (defeating symlink escape out of a root). A symlink entry that resolves
  **outside** the roots MUST be reported but MUST be **non-navigable**. Entries
  are `lstat`'d so a symlink is reported as `symlink` with a post-realpath
  `resolvedKind`.
- **REQ-P7-FS-005** Hidden entries (dotfiles / OS-hidden) MUST be excluded by
  default and revealed by an explicit `showHidden` flag that **never** bypasses the
  roots check. `.git` MUST NOT be special-cased for *hiding*; instead a directory
  containing `.git` is flagged (REQ-P7-FS-001). Obviously dangerous system roots
  (`/proc`, `/sys`, `/dev` on Linux) SHOULD be denied even when otherwise
  reachable (defense in depth).
- **REQ-P7-FS-006** The listing MUST be **bounded**: the number of entries
  returned per call is capped with a truncation flag, so a pathological directory
  cannot blow up memory or latency. Enumeration uses async `opendir`/`readdir`.
- **REQ-P7-FS-007** cbranch MUST provide a reusable **`<FilesystemPicker>`**
  component with a `mode` of `dir` or `file` (file mode shows files as selectable;
  dir mode shows files greyed for context and selects a directory), breadcrumb
  navigation, a roots selector, a hidden-file toggle, keyboard navigation
  (↑/↓ move, →/Enter descend, ←/Backspace ascend, typeahead), and repo badges. The
  existing raw path text box is **kept** as an editable field synced to the browsed
  location (the picker augments, it does not replace). An optional flag MUST allow
  **typing a new leaf name** (for "create a folder here", used by New repo and
  worktree).
- **REQ-P7-FS-008** `fs.listDir` results MUST be cached under a **non-domain query
  key** (`["fs", "listDir", path, showHidden]`) that the invalidation bus never
  targets — this data is not repo-synced state (`rpc/query-keys.ts` convention).
- **REQ-P7-FS-009** This primitive is **read-only**: it does NOT take the per-repo
  mutation lock and is not repo-keyed. It rides the existing `/rpc` WebSocket
  (inheriting the Origin/Host guard) — it adds **no new socket or side-channel
  route**. Its `core` module imports only `node:fs` (no ui/http/socket), preserving
  the dependency rule.

### Menu completion — Navigate wiring (REQ-P7-NAV-*)

> Currently enabled Navigate items (`navigate.back`, `navigate.forward`,
> `navigate.quickSearch`) are out of scope here. Note the existing semantics gap to
> flag, not necessarily fix: `navigate.back/forward` drive **browser router
> history**, whereas the design doc intends **selection history**; a maintainer
> decision (see Open decisions).

- **REQ-P7-NAV-001** The **id-mismatch defects** MUST be fixed so the built-but-
  greyed items enable in the menu bar. At minimum `navigate.goToCommit` (built as
  handler `navigate.goto`, bound to `Ctrl/⌘+G`, already reachable from the palette)
  MUST enable and open the existing Go-to-commit dialog. The fix MUST keep a
  **single canonical id per command** across menu-model, palette, and keybindings
  — the recommended direction is aliasing the menu-model ids in the handler
  registry (the model is the reused source of truth for the revision-grid context
  menu). The same fix simultaneously resolves the sibling mismatches
  `start.create`→`repository.new`, `repository.editAttributes`→
  `repository.editGitattributes`, and `commands.formatPatch`→`commands.exportPatch`
  (see §REPO / cross-menu note). **No new RPC surface.**
- **REQ-P7-NAV-002** **`navigate.goToCurrent`** ("Go to current revision") MUST
  select `HEAD` in the grid and scroll it into view, reusing the P6 go-to-row
  machinery; `HEAD`'s oid is read from the already-available repo-state. **No new
  RPC surface.**
- **REQ-P7-NAV-003** **Graph navigation** — `navigate.goToParent`,
  `navigate.goToFirstParent`, `navigate.goToLastParent`, and `navigate.goToChild`
  — MUST move the selection to, respectively, the selected commit's first parent,
  first parent, last parent, and a child (topmost when multiple), when that commit
  is present in the loaded history window, and MUST scroll it into view. This is a
  **client-only** move over the loaded parent pointers (a one-shot store signal
  consumed by the history list); **no new RPC surface**. If the target is not in
  the loaded window, cbranch either loads more or explains it is unavailable
  (REQ-P7-NAV-006 error clause), rather than doing nothing.
- **REQ-P7-NAV-004** **Quick-search stepping** — `navigate.quickSearchNext`
  (F3) and `navigate.quickSearchPrev` (Shift+F3) — MUST advance/retreat the find
  cursor over the existing find bar's matches. This requires lifting the currently
  list-local match cursor to an ephemeral store signal the menu can drive; **no new
  RPC surface**.
- **REQ-P7-NAV-005** **`navigate.goToMergeBase`** ("Go to common ancestor") MUST
  select the merge base of the selection and `HEAD` (exact operand set per Open
  decisions). Because the base may lie outside the loaded window, a client-only
  walk is unreliable; this requires a **new read method** `commit.mergeBase`
  (`git merge-base`, read-only, no lock) — see §RPC contract additions.
- **REQ-P7-NAV-006** Any navigation whose target does not resolve, is filtered out
  of the current view, or is not loadable MUST surface a clear, **non-destructive**
  message and leave the current selection unchanged.
- **REQ-P7-NAV-007** `navigate.toggleArtificial` ("Toggle artificial / HEAD
  commits") depends on the **artificial working-/index-row feature** which does not
  exist yet; it is paired with `view.showArtificial` (REQ-P7-VIEW-010) and is
  **out of scope for P7** (listed in Out of scope), not silently left greyed
  without note.

### Menu completion — View wiring (REQ-P7-VIEW-*)

> Already-wired View items (`view.showReflog`, `view.showRelativeDate`,
> `view.showNotes`) are out of scope here. Client-only view/nav state MUST live in
> the **Zustand ephemeral view-state store** (never React Query, never duplicating
> server data) per the UI data-flow rule; a single "view preferences" slice unlocks
> most of the menu at once.

- **REQ-P7-VIEW-001** **Branch-scope commands** — `view.showAllBranches`,
  `view.showCurrentBranch`, `view.showFilteredBranches` — MUST set the history
  `refScope` filter to `all` / `current` / `pattern` respectively, driving the
  existing log-stream re-scope. **No new RPC surface** (the `refScope` filter and
  its stream handling already exist).
- **REQ-P7-VIEW-002** **Column-visibility checkboxes** — `view.showAuthorColumn`,
  `view.showAvatarColumn`, `view.showDateColumn`, `view.showShaColumn` — MUST
  toggle the corresponding **persisted** `AppSettings.columns.*` key (the same
  store the P6 header column menu writes) and MUST reflect current state as the
  menu checkbox state. This reuses `config.appGet`/`config.appSet`; **no new git
  method**.
- **REQ-P7-VIEW-003** **Label toggles** — `view.showRemoteBranches`,
  `view.showTags` — MUST show/hide remote-tracking and tag ref chips in the grid.
  The refs are already carried on each row; these are **client-only** ephemeral
  toggles. **No new RPC surface.**
- **REQ-P7-VIEW-004** **Detail toggles** — `view.showMessageBody` (body in commit
  detail) and `view.showAuthorDate` (author date vs committer date) — MUST toggle
  the corresponding render; both fields are already carried on the loaded commit
  data. **Client-only.**
- **REQ-P7-VIEW-005** **Graph emphasis toggles** — `view.drawNonRelativesGray`
  (dim commits unreachable from the selection) and `view.highlightSelectedBranch`
  (emphasize the selected lane) — MUST change graph rendering based on the loaded
  parent pointers / selection. **Client-only**, no RPC.
- **REQ-P7-VIEW-006** **`view.saveAsDefault`** MUST persist the current set of view
  toggles as the default for future sessions. Columns already persist via
  `AppSettings.columns`; extending persistence to the other toggles defines a new
  app-settings "view defaults" key (a `config.appGet`/`config.appSet` value — **no
  git method**). What exactly constitutes "the view" is an Open decision.
- **REQ-P7-VIEW-007** **`view.showStashes`** (stash entries inline in the graph)
  MAY be delivered: the stash list is already available, but injecting stash tips
  into the graph is new graph work; if delivered it is a **client-side** overlay
  over existing stash data with an ephemeral toggle.
- **REQ-P7-VIEW-008** **`view.advancedFilter`** — the always-visible FilterBar
  already exposes path/author/message/since/until/scope. This item MUST either
  focus/expand the FilterBar or be resolved as redundant (Open decision); it MUST
  NOT remain a silently-dead menu entry.
- **REQ-P7-VIEW-009** **Order toggles** — `view.sortByAuthorDate` and
  `view.arrangeTopo` — are **explicitly deferred within P7** unless the maintainer
  decides to make log ordering client-selectable. Today `LogQuery` ordering is
  fixed server-side (`--topo-order --date-order`) and documented as *not* a client
  option; enabling these requires a **new `LogQuery.order` field** + engine flag
  and a reconciliation of that design note. Treated as an Open decision (see Out of
  scope if not taken).
- **REQ-P7-VIEW-010** `view.showArtificial`, `view.showSuperprojectTags`,
  `view.showSuperprojectBranches`, `view.showBuildStatusIcon`,
  `view.showBuildStatusText`, and `view.showGraphColumn` are **out of scope for
  P7** (artificial-rows feature not built; superproject awareness not built; build
  status needs forge/CI integration; the graph cell is spec-mandated always-present
  per REQ-GRAPH-UI-001). They remain deferred and are enumerated in Out of scope.

### Create / initialize a repository — entry points (REQ-P7-REPO-*)

> P6 already shipped `repo.init` (REQ-P6-INIT-001..005) and a New-repo dialog.
> Phase 7 **only** reconciles the greyed Start-menu entry point and adopts the new
> folder picker; it mints **no new init RPC**.

- **REQ-P7-REPO-001** The Start menu's **`start.create`** ("Create new
  repository…") MUST enable and open the existing New-repository dialog (it is
  greyed today purely by an id mismatch with handler `repository.new`; see
  REQ-P7-NAV-001's canonical-id fix). **No new RPC surface.**
- **REQ-P7-REPO-002** The New-repository destination input MUST adopt
  `<FilesystemPicker>` in `dir` mode with new-leaf entry enabled, so the user
  browses to a parent and names the new folder rather than typing an absolute path.
  The picker's selection feeds the existing `repo.init` payload unchanged.
- **REQ-P7-REPO-003** The **Open repository** surface (repository switcher's
  open-path, P1-UI-OPEN-1) and the **worktree add-path** input MUST adopt
  `<FilesystemPicker>` in `dir` mode
  (Open: repo badges on; default root home + recent parents. Worktree: new-leaf
  allowed; default root = the repo's parent directory). Type-ahead path entry is
  retained.
- **REQ-P7-REPO-004** **`start.clone`** ("Clone repository…") and
  **`github.forkClone`** MUST remain **out of scope and greyed**: `git clone` is a
  standing v1 descope (`01`/`02`/`04`) and the CLAUDE.md "no `git clone`" rule.
  P7 MUST NOT introduce clone/fork. (Lifting the clone descope, if ever, is a
  separate spec change — see Open decisions.)

### Help & onboarding (REQ-P7-HELP-*)

> All quick-wins here are **pure UI** in `packages/ui`; only the diagnostics method
> (REQ-P7-HELP-006) touches the backend. Offline/host-local trust model (`12`)
> argues for **bundling** manual/changelog content rather than assuming a live help
> site; external links (issue tracker, releases) are the only outbound egress and
> MUST open in a new browser tab.

- **REQ-P7-HELP-001** **`help.manual`** MUST open cbranch documentation — a bundled
  in-app markdown view is preferred (offline-safe); if an external link is used it
  opens in a new tab. **No new RPC surface.**
- **REQ-P7-HELP-002** **`help.changelog`** MUST render release notes for the
  running version, from a bundled `CHANGELOG.md`, in a focus-trapped dialog/panel.
- **REQ-P7-HELP-003** **`help.reportIssue`** MUST open the public GitHub issue
  tracker in a new tab, pre-filling a template with app version, host-git version,
  and OS. Prefilled diagnostics MUST NOT include repository paths (privacy).
- **REQ-P7-HELP-004** **`help.about`** MUST become a proper **focus-trapped
  dialog** (replacing today's toast) showing app name, app version, host-git
  version, MIT license, credits, and a copyable diagnostics block (NF-A11Y-3).
- **REQ-P7-HELP-005** cbranch MUST add a **Keyboard-shortcuts reference** surface
  (a new `help.shortcuts` menu item + palette command, on a documented chord)
  generated read-only from the effective keybindings (`mergeBindings` over the
  labelled command set), reusing the SettingsDialog shortcut rendering. This
  directly serves the keyboard-first discoverability obligation (NF-A11Y-1/6). The
  breadth of the cheat-sheet (only remappable bindings vs. a fuller catalog) is an
  Open decision.
- **REQ-P7-HELP-006** cbranch MUST expose a small read-only **`system.info`**
  method returning `{ appVersion, hostGitVersion, platform }` so About and
  Report-an-issue show the **real** host-git version (the engine already computes
  it for the NF-PKG-5 gate but does not expose it). Results are cached under a
  **non-domain** key and never invalidated. The `'0.0.0'` version placeholders MUST
  be replaced by a build-time inject from `package.json`.
- **REQ-P7-HELP-007** The **empty/first-run state** MUST be enriched from a bare
  "Open a repository" line into a welcome surface offering Open repository, New
  repository, the recent-repos list, and links to Shortcuts / Manual / About —
  reusing existing data (no new RPC).
- **REQ-P7-HELP-008** `help.translate` and `help.checkUpdates` remain **deferred**
  (self-update is out of scope); they stay greyed or, at most, become plain
  outbound links when their targets exist. Not built in P7.

### GitHub integration (REQ-P7-GH-*)

> **All GitHub network calls happen in the host process, never the browser** — the
> exact analogue of "only web-server opens a socket." Owner/repo MUST be derived
> **host-side from the repo's real `origin`**, never from client input (SSRF
> avoidance). cbranch MUST NOT store secrets (`NF-CFG-6`, `NF-LOG-4`): the default
> auth path **delegates to the host `gh`/`git` credentials**, so cbranch holds no
> token. The auth model, network-client placement, and REST-vs-GraphQL choice are
> Open decisions; this section scopes what MAY ship and pins the invariants.

- **REQ-P7-GH-001** **`github.addUpstream`** ("Add upstream remote") MUST be
  delivered as a **pure local-git** action: add a remote named `upstream` with a
  user-confirmed URL, reusing the existing remote-add capability. It needs **no
  forge API and no secret**. This is the safe first slice.
- **REQ-P7-GH-002** cbranch SHOULD provide **"Open on GitHub"** affordances that
  derive the web URL from `origin` (`git@github.com:o/r` / `https://github.com/o/r`)
  and open the repo / commit / branch / compare page in a new tab. This is a
  **client-side URL builder + `window.open`** — **no API, no secret**.
- **REQ-P7-GH-003** **`github.viewPrs`** ("View pull requests…") MAY be delivered
  as a **read-only** PR list via a new host-side method (`github.pullsList`), with
  owner/repo derived from `origin` and the call made through the **host `gh`** (or
  an isolated web-server HTTP client — Open decision). cbranch MUST store no token.
  PR data flows through React Query under a **non-domain** key (PR state is not in
  the invalidation-bus domains) with an explicit manual refresh. The host MUST read
  `X-RateLimit-*` and surface remaining/reset, backing off on secondary limits.
- **REQ-P7-GH-004** **`github.createPr`** ("Create pull request…") MAY be delivered
  as a second slice (a new `github.pullCreate` method: base/head/title/body),
  gated on write-capable host credentials. Whether such a network mutation takes
  the per-repo semaphore (it does not touch `.git`) is an Open decision.
- **REQ-P7-GH-005** If any native-token path is ever chosen instead of `gh`
  delegation, the token MUST live only in **host memory or a host secret store** —
  never in `config.json`, never on the wire to the browser, never in logs — and the
  existing secret-scrubbing test MUST be extended to cover GitHub token shapes
  (`ghp_*`, `github_pat_*`, `gho_*`). The client MAY read a boolean
  "token present?" capability but MUST NOT receive the token.
- **REQ-P7-GH-006** `github.forkClone` remains **out of scope** (clone descope,
  REQ-P7-REPO-004).

### Tools — Open terminal via ghostty-web (REQ-P7-TERM-*)

> **Recommendation: this is an isolated, off-by-default, separately-gated track,
> not folded into the P7 grab-bag.** An interactive host shell is, by design,
> arbitrary remote code execution: it **nullifies NF-SEC-5 (path containment) and
> NF-SEC-6 (arg-array, no shell)** — `cwd`-scoping to the repo is cosmetic. It also
> introduces a **native dependency** (node-pty), the **first non-git process spawn
> outside `GitEngine`**, and (if a dedicated channel) a **second socket type**. If
> it cannot ship with all gates below, it MUST be split into its own document
> (e.g. a `19-terminal.md` in this style) rather than shipped partially. The
> named frontend is **`ghostty-web`** (MIT, a WASM VT widget with an xterm-like
> API and **no server** — cbranch owns the entire host side); the named backend is
> **`node-pty`** (MIT). Both MUST be added to `LICENSES.md` or `license-audit`
> fails.

- **REQ-P7-TERM-001** When (and only when) enabled, **`tools.terminal`** ("Open
  terminal here") MUST open an interactive host shell whose working directory is
  the active repository, streamed to an embedded `ghostty-web` terminal in the UI.
  The item is wired inside the repo-open handler block (a terminal needs an open
  repo to scope `cwd`).
- **REQ-P7-TERM-002** The terminal MUST be **off by default**, enabled only by an
  explicit host config flag (`terminal.enabled=false` by default, per `NF-CFG-7`).
  It MUST never be on unless the operator sets it.
- **REQ-P7-TERM-003** The terminal channel MUST **hard-refuse to serve when the
  bind address is non-loopback** (`NF-PKG-2`), even if the operator widened the
  bind for LAN/VPN use — a remote-reachable unauthenticated shell is indefensible.
  At most, non-loopback exposure MAY be allowed behind a **second, louder**
  opt-in with a prominent startup warning (Open decision).
- **REQ-P7-TERM-004** The terminal channel's connection MUST pass the existing
  **`makeOriginGuard` (Origin/Host) check before any PTY is spawned** (mirroring
  how `/rpc` and the side-channels are guarded), closing the DNS-rebinding hole
  (`NF-SEC-3`).
- **REQ-P7-TERM-005** The PTY MUST inherit the **host user only** (no privilege
  elevation); documentation MUST state plainly that the shell has that user's full
  permissions and that `cwd`-scoping is **not** containment.
- **REQ-P7-TERM-006** The terminal backend (`node-pty`) MUST live in
  **`apps/web-server`** (the only package permitted socket/transport libraries),
  not in `core`. This is the first non-git process spawn outside `GitEngine` and
  MUST be recorded as an explicit architecture decision; `scripts/check-deps.mjs`
  expectations MUST be updated to permit it there only.
- **REQ-P7-TERM-007** The transport MUST NOT introduce a *second listening socket*:
  it either rides a new **raw-byte WebSocket path on the existing web-server**
  (recommended for stream correctness) or tunnels over the existing RPC stream
  (avoids base64-per-keystroke concerns but fights the request→stream model). Which
  is chosen MUST be reconciled into `14`/`15`'s "one multiplexed transport"
  statement (Open decision). Native-addon delivery (prebuilds vs. toolchain) MUST
  be reconciled against `NF-PKG-6/7`.
- **REQ-P7-TERM-008** The security-review checklist (`12` NF-SEC-1..12) MUST gain a
  terminal-specific item, and the terminal MUST be named in `NF-SEC-2`'s trust-
  model discussion, before this ships.

### Plugins — superseded by Phase 9

- **REQ-P7-PLUGIN-001 (superseded).** P7 did not add a plugin host. Phase 9 now
  owns `plugins.none` and `plugins.settings`; see `21-runtime-plugin-system.md`.

## RPC contract additions

> This section is the **contract delta** for Phase 7. It extends — and reconciles
> to — the authoritative `14-rpc-contract.md` without rewriting it. New methods
> follow the doc-14 house style: a PascalCase wire tag + a `<domain>.<verb>` doc
> label; payload/success modeled as named `Schema.Class`es (the FS types in a new
> `schemas/fs.ts`; GitHub/system in a `schemas/phase7.ts`); `error: GitError` on
> every method; ✎ = mutating (takes the per-repo lock), ⇉ = streaming.

**Reused, no new surface** (called out so they are not duplicated): `repo.init`
(`RepoInit`), `repo.open` (`RepoOpen`), the remote-add method (for
`github.addUpstream`), the log-stream `refScope` filter (branch-scope View items),
`config.appGet`/`config.appSet` (column visibility + view defaults),
`log.stream`/`commit.detail` (go-to-row navigation).

**New methods:**

| Method | Payload | Success | Notes |
|---|---|---|---|
| `fs.listDir` | `{ path?, showHidden? }` | `DirListing { path, parent, segments[], roots[], entries[], truncated? }` | **not repo-scoped**; bounded by the roots allow-list (§FS), not NF-SEC-5; read-only, no lock; one dir per call, never recurses |
| `commit.mergeBase` | `{ repoId, a, b }` | `MergeBaseResult { oid? }` | `git merge-base`; read-only; powers `navigate.goToMergeBase` |
| `system.info` | `{}` | `SystemInfo { appVersion, hostGitVersion, platform }` | global/immutable; non-domain query key; never invalidated |
| `github.pullsList` | `{ repoId, state? }` | `PullRequest[]` | owner/repo derived **host-side** from `origin`; via host `gh` (or isolated web-server HTTP client); no secret stored; surfaces rate-limit remaining/reset |
| `github.pullCreate` ✎? | `{ repoId, base, head, title, body }` | `PullCreateResult { number, url }` | second slice; write-capable host creds required; semaphore participation is an Open decision (no `.git` mutation) |

`DirEntry` (in `DirListing.entries`): `{ name, kind: dir|file|symlink|other,
resolvedKind?, isHidden, isGitRepo? }` — `name` is a basename only, never a full
path.

**GitError codes.** New failure modes reconcile to the single canonical `GitError`
union by **adding literals to the one closed `GitErrorCode` array** (`14 §4`) —
never a second error class. Reconcile against the existing set and reuse where one
fits before adding: a path **outside the allowed roots** and a **not-a-directory**
result for `fs.listDir` (or reuse the existing filesystem/exec code); `EACCES`
maps to the existing permission code, `ENOENT` to not-found. A **GitHub API / rate-
limit / auth** failure for the `github.*` methods (reuse the existing network/exec
code where possible). Merge-base "no common ancestor" is an ordinary
`MergeBaseResult.oid = null`, **not** an error.

## Git / host operations

The exact host operations cbranch runs (always non-interactive; git's editor is
redirected to a cbranch scripted editor per `09`):

- **Directory listing (non-git):** host filesystem read via `node:fs/promises`
  (`opendir`/`readdir({ withFileTypes: true })`, `lstat`, `realpath`) inside the
  new `core/src/fs/list-dir.ts`. The containment guard is modeled on
  `git/meta-files.ts` (`resolve` + `startsWith(root + sep)`) generalized to the
  roots allow-list. This is the **one deliberate non-git read**; it invokes no git
  and no shell (NF-SEC-6 trivially satisfied) and takes no lock.
- **Merge base:** `git merge-base <a> <b>` (read-only).
- **System info:** the host `git --version` value the engine already parses for the
  NF-PKG-5 gate, plus `process.platform` and the injected app version.
- **Add upstream:** `git remote add upstream <url>` — the existing remote-add
  engine path.
- **GitHub (default path):** host `gh` (e.g. `gh pr list --json …`,
  `gh pr create …`, or `gh api …`) via `child_process` with arg arrays — reuses the
  host's out-of-band credentials; cbranch stores nothing. (Alternative: an HTTP
  client isolated in `apps/web-server` — Open decision; `core` MUST NOT import an
  HTTP lib.)
- **Terminal (isolated track):** `node-pty` spawns the host `$SHELL` /
  `%COMSPEC%` (selection an Open decision) with `cwd` = the active repository, in
  `apps/web-server` only. No git subcommand.

## Side-channel / socket routes

- **Directory listing, GitHub, merge-base, system-info:** all ride the **existing
  `/rpc` WebSocket** (small JSON) and inherit the global Origin/Host guard —
  **no new route, no side-channel** (respects "only web-server opens a socket").
- **Terminal (isolated track only):** if delivered via a dedicated channel, a new
  **raw-byte WebSocket path on the existing web-server** (e.g. `/terminal`) whose
  upgrade passes `makeOriginGuard` **before** any PTY spawns, then pumps PTY↔WS
  bytes plus an out-of-band resize control frame. This is a new *path on the one
  process*, not a new listening socket, and its deviation from the "one multiplexed
  transport" statement MUST be reconciled into `14`/`15` (REQ-P7-TERM-007). No such
  route ships unless the terminal ships.

## UI/UX requirements

Expressed via shadcn/ui (`base-lyra` on Base UI); visual styling is out of scope,
component choice and behavior are not.

- **`<FilesystemPicker>` (new, reusable):** rendered inside the existing
  `ui/dialog.tsx`; breadcrumbs from `DirListing.segments`, a roots dropdown from
  `DirListing.roots`, a hidden-file toggle, repo badges (`isGitRepo`), keyboard
  navigation, and a retained editable current-path field. Adopting sites:
  **Open repository** (palette open-path, `dir` mode, repo badges),
  **New repository destination** (`dir` mode + new-leaf), and **worktree add-path**
  (`dir` mode + new-leaf). The submodule mount-point and archive sub-path inputs
  browse a **git tree**, not the host FS, and MUST NOT adopt this component (a
  sibling git-tree picker is a possible follow-up — Open decision).
- **Navigate menu:** the built Go-to-commit dialog enables from the menu bar;
  parent/child/current/find-next/prev act on the current selection and scroll the
  target into view; merge-base selects the computed base or reports none.
- **View menu:** branch-scope items re-scope the graph; column checkboxes reflect
  and toggle the persisted `AppSettings.columns.*`; label/detail/emphasis toggles
  change the grid/graph immediately; "Save current view as default" persists.
- **Help:** About/Changelog/Manual/Shortcuts are focus-trapped dialogs or panels
  (never a toast), reachable from both the Help menu and the command palette with
  correct roles/names (NF-A11Y-4/6); the shortcuts panel is read-only and generated
  from the effective keybindings; the empty state becomes a welcome surface.
- **GitHub:** "Add upstream" is a small confirm dialog reusing the remotes flow;
  "Open on GitHub" opens a new tab; the PR list (if built) is a virtualized panel
  with a manual refresh and a visible rate-limit indicator; nothing ever renders a
  token.
- **Terminal (isolated track):** a `TerminalPanel` wrapping `ghostty-web` (the
  ~400 KB WASM shipped as a static asset via the SPA bundle server), opened as a
  view/Sheet only when enabled; the UI states plainly this is a real host shell.
- **Concurrency feedback:** unchanged from P6 — while a mutating operation holds the
  repository lock, conflicting actions are disabled with a busy tooltip.

## Acceptance criteria

- Opening the folder picker lists the chosen directory's entries with repo folders
  badged; navigating up/down stays within the allowed roots; a path outside the
  roots or a symlink escaping them is rejected/non-navigable; hidden entries appear
  only when the toggle is on.
- New repository's destination and the worktree add-path are selectable via the
  picker (with a new leaf name), and the resulting path drives `repo.init` /
  worktree-add unchanged; the raw text field still accepts typed paths.
- "Go to commit…" is enabled in the Navigate menu bar (not only via `Ctrl+G`) and
  opens the dialog; "Go to current revision" selects and scrolls to `HEAD`;
  parent/child/first-parent/last-parent move the selection; find-next/prev step the
  matches; "Go to common ancestor" selects the merge base or reports none; an
  unresolvable target changes nothing.
- Branch-scope items re-scope the graph to all / current / pattern; toggling a
  column hides/shows it and the choice survives a reload; label/detail/emphasis
  toggles change rendering; "Save as default" persists the toggles across reload.
- Help → Manual / Changelog / Shortcuts / About open as focus-trapped surfaces;
  About and Report-an-issue show the real app and host-git versions from
  `system.info`; the empty state offers Open / New / recent / Help links.
- "Add upstream remote" adds a remote named `upstream`; "Open on GitHub" opens the
  correct web page derived from `origin`; if built, the PR list loads via host
  credentials with no token stored and shows rate-limit status.
- (If the terminal ships) `tools.terminal` opens a shell at the repo path only when
  the operator enabled it; the channel refuses to serve on a non-loopback bind and
  rejects a bad Origin/Host before spawning; the shell runs as the host user; with
  the flag off the item stays greyed.

## Edge cases & error handling

- **Empty / permission-denied / vanished directory** in `fs.listDir`: `EACCES` →
  permission error, `ENOENT` → not-found, `ENOTDIR` → filesystem error; no stack
  traces or unexpected absolute paths beyond the requested listing leak (`12`).
- **Symlink loop / escape:** the entry is listed but non-navigable; realpath +
  re-check on the resolved path prevents escaping a root (TOCTOU-safe).
- **Huge directory:** the listing truncates at the entry cap and flags truncation
  rather than hanging.
- **Windows/drive roots:** the roots list models drive letters / UNC; `parent` is
  null at each drive root (cross-platform breadcrumb semantics — Open decision).
- **Go-to navigation for a target outside the loaded window or filtered out:**
  cbranch loads more or explains it is filtered, never scrolls to nothing.
- **Merge base with no common ancestor:** `oid = null`, reported plainly, not an
  error.
- **GitHub with no host credentials / `gh` not installed:** the PR features surface
  a clear "host GitHub credentials not available" state and never prompt for or
  store a token; local-git items (`addUpstream`, "Open on GitHub") keep working.
- **GitHub rate limit hit:** the host surfaces remaining/reset and backs off on
  secondary limits; the client shows the throttle rather than hammering.
- **Terminal on a non-loopback bind:** the channel hard-refuses; if the second
  opt-in path is taken, a prominent warning precedes any spawn.
- **Terminal native-addon missing prebuild:** the feature is reported unavailable
  rather than crashing the server; the rest of cbranch is unaffected.

## Out of scope

- **`git clone` / fork** and any remote-cloning flow (`start.clone`,
  `github.forkClone`) — unchanged v1 descope; repositories are opened or `init`-ed
  by host path only.
- **Plugins** (`plugins.*`) — superseded by Phase 9's trusted-extension model.
- **Artificial working-/index-row feature** and its dependents
  (`view.showArtificial`, `navigate.toggleArtificial`) — not built.
- **Superproject-aware View items** (`view.showSuperprojectTags/Branches`) and
  **CI/build-status items** (`view.showBuildStatusIcon/Text`) — need superproject
  awareness / forge-CI integration; deferred.
- **`view.showGraphColumn`** — the graph cell is spec-mandated always-present
  (REQ-GRAPH-UI-001); not made hideable.
- **Log-order toggles** (`view.sortByAuthorDate`, `view.arrangeTopo`) unless the
  maintainer accepts a new `LogQuery.order` contract field (Open decision);
  otherwise deferred.
- **A general host file manager / arbitrary file read-write:** `fs.listDir` is
  **list-only**; a bounded `fs.readFile` (for e.g. picking a host `.patch` file) is
  a **separate** future method with its own size cap and side-channel — not in P7.
- **`help.translate` / `help.checkUpdates`** — localization workflow and self-update
  remain deferred.
- **Any change to the completed P0–P6 specifications;** Phase 7 references them and
  adds new requirements, but does not edit them.
