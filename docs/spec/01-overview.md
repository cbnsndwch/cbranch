# Product Overview & Glossary

## Purpose

`cbranch` is a cross-platform, browser-based graphical user interface for the
Git version control system. It is built for one specific and currently
underserved workflow: a developer who does their real work on a **remote
Linux or macOS host** (a build server, a cloud VM, a workstation reached over
SSH, including VSCode Remote-SSH sessions) and wants to **visually** inspect,
stage, commit, branch, and synchronize Git repositories on that host **from a
browser** — without copying the repository to their laptop, without installing
a native desktop application on the host, and without abandoning the comfort of
a graphical history view for a terminal.

### Problem statement

Today, a developer in this situation must choose between two poor options:

1. **Stay in the terminal.** Powerful, but the commit graph, diffs, conflict
   resolution, interactive staging, and branch topology are hard to read and
   slow to navigate as raw text over a possibly high-latency link.
2. **Run a native visual Git tool locally and point it at the remote.** This
   requires either mounting the remote filesystem (slow, fragile, and it
   defeats the purpose of doing the work where the code lives) or syncing the
   repository back and forth (error-prone and wasteful).

There is no good answer for "I want a fast, modern, visual Git GUI that runs
**where my code actually is** (the remote host) and that I reach through an
**ordinary browser over an SSH tunnel**." `cbranch` exists to be that answer.

The `cbranch` service runs **on the remote host** and operates directly on the
real on-disk repository through the host filesystem. The browser is a **pure
view**: it renders state and sends user intent over a typed remote-procedure
transport. No repository contents live in the browser, and no virtual browser
filesystem is involved. This keeps every operation fast (it happens next to the
data) and correct (it uses the host's own `git` binary and filesystem
semantics).

### What `cbranch` is

- A **visual Git client** for one repository at a time, with a fast switcher to
  jump between repositories the host can see.
- A **remote-first** tool: the engine and service execute on the host that owns
  the repository; the UI is delivered to a browser.
- A **read-and-write** tool across its shipping phases: from read-only history
  browsing (P1) up through staging/committing (P2) and full branch, sync,
  worktree, stash, and tag management (P3).

### What `cbranch` is not

- Not a code editor or IDE. It edits Git state (the index, branches, commits),
  not source files in general. (Targeted text interactions such as hunk
  selection and conflict resolution are in scope; a general-purpose project
  editor is not.)
- Not a hosting/forge service. It talks to whatever remotes the repository
  already has; it does not host repositories, issues, or pull requests.
- Not a CI/CD system, a code-review platform, or a project-management tool.
- Not a multi-tenant web app. Each running service is a personal, single-user
  endpoint reached over the user's own SSH tunnel.

## Target persona and usage context

**Primary persona — "the remote developer":**

- Writes and runs code on a remote Linux/macOS host (cloud VM, lab box, build
  server, or a beefy workstation they SSH into).
- Frequently connects via VSCode Remote-SSH or a plain SSH session.
- Is comfortable with Git concepts but strongly prefers a visual history graph,
  visual diffs, and click-to-stage over memorizing terminal flags.
- Values low-friction context switching between several repositories that live
  on the same host.
- Cares about safety: they do not want a GUI to silently do something
  destructive to a shared remote branch.

**Usage context:**

1. The user is connected to the host (SSH or Remote-SSH).
2. The `cbranch` service is started on the host. It binds to a loopback address
   on the host (`127.0.0.1`) only.
3. The user forwards the service port to their local machine through the SSH
   tunnel (with Remote-SSH, VSCode forwards it automatically).
4. The user opens `cbranch` in a local browser pointed at the tunneled (or
   otherwise perimeter-reachable) service. No app login is required.
5. All Git activity happens on the host; the browser only renders and sends
   intent.

`cbranch` v1 assumes **private deployment behind a trusted perimeter** (a
loopback-over-SSH tunnel, LAN, VPN, or Tailscale). The service **binds to
loopback by default** (the bind interface is configurable) and MUST NOT be
exposed to the public internet. There is **no app-level authentication** in v1;
as a cheap, orthogonal defense the service validates the `Origin`/`Host` header
on the WebSocket upgrade against an allowlist. It does **not** implement user
accounts, roles, or public network exposure. (Adding app-level auth later is a
non-breaking additive change — see `14 §3.6`. Remote *Git* authentication is
handled out-of-band at the host via ssh-agent / credential helpers.)

## The single-repository + fast-switcher model

`cbranch` is, at any moment, focused on **exactly one repository**. The entire
UI — history graph, branch list, staging area, diffs — reflects that one active
repository. This keeps the mental model and the screen uncluttered.

Switching repositories is a first-class, low-friction action:

- A **command-palette-style switcher** lists known repositories and lets the
  user filter by typing.
- Selecting a repository **replaces** the active context; `cbranch` never shows
  two repositories' data merged together.
- The switcher's list is populated from (a) repositories the user explicitly
  opens by path, and (b) a configurable, recently-used list. Filesystem-wide
  auto-discovery is not required for v1.

## MVP definition (Phases P1–P3)

The MVP is the union of phases **P1, P2, and P3**. Each phase is independently
shippable and adds a coherent slice of capability.

### P1 — Read-only browser (foundation)

- Open a repository by path; validate it is a Git repository.
- Render the **commit history** as a navigable graph with branch/tag labels.
- Show commit details: author, committer, dates, full message, parents.
- Show the **diff** for any commit (and for individual files within it).
- List **branches**, **remote-tracking branches**, and **tags** (read-only).
- Show the current **HEAD** and whether it is detached.
- Repository switcher.

### P2 — Stage & commit

- Show **working tree** changes and **index** (staged) changes separately.
- **Stage** / **unstage** whole files and individual **hunks**.
- Discard working-tree changes to a file (with confirmation).
- Compose and create a **commit** (message body, optional amend of the latest
  commit when safe).
- Show the diff of staged vs. unstaged vs. HEAD.

### P3 — Branches, sync, worktrees, stash, tags

- **Create**, **rename**, **delete**, and **check out** branches.
- **Fetch**, **pull**, and **push** against remotes (network operations run via
  the host `git` binary because real remotes are typically SSH).
- Show **ahead/behind** counts versus the upstream/remote-tracking branch.
- Manage **stashes**: create, list, show, apply, pop, drop.
- Manage **tags**: list, create (lightweight and annotated), delete, push.
- Manage **worktrees**: list, add, remove.
- Fast-forward and basic non-conflicting **merge** of a branch into the current
  branch, with clear reporting when a merge cannot proceed automatically.

### Out of scope for v1

The following are explicitly **deferred beyond the MVP** (they belong to later
phases P4/P5 or to the separate VSCode extension track) and must not block v1:

- Conflict-resolution merge editor, cherry-pick, blame, and file history (P4).
- Interactive rebase, reflog browser, bisect, archive export, `clean`,
  garbage-collection/maintenance UI, and submodule management (P5).
- The VSCode webview extension (parallel track after the core stabilizes).
- Multi-repository simultaneous views, repository hosting/forge features, user
  accounts, code review, and CI/CD.

## Success criteria

- **SC-1 — Remote-correct.** Every operation acts on the real on-disk
  repository on the host through the host filesystem and the host `git` binary
  where required; results are identical to running the equivalent host `git`
  commands.
- **SC-2 — Browser-only client.** A user can complete every MVP task using only
  a browser connected over the SSH tunnel, with no repository data persisted in
  the browser.
- **SC-3 — Responsive at scale.** History, branch, and change lists remain
  smooth (virtualized rendering, incremental loading) on repositories with tens
  of thousands of commits and large changesets.
- **SC-4 — Safe by default.** No destructive action (discard, force-push,
  branch delete, history-affecting operations) occurs without an explicit,
  clearly worded confirmation; mutating operations are serialized per
  repository so concurrent actions cannot corrupt state.
- **SC-5 — Low-friction switching.** A user can switch the active repository in
  a few keystrokes via the switcher.
- **SC-6 — Honest errors.** When a Git operation fails (e.g., push rejected,
  auth failure, merge conflict), `cbranch` surfaces the underlying reason in
  plain language and does not leave the repository in an ambiguous state.

## User stories

- **US-1.** As a remote developer, I open `cbranch` in my browser and see the
  commit graph of the repository on my host, so I can understand its history
  without scrolling terminal text.
- **US-2.** As a developer, I click any commit and instantly see who made it,
  when, the message, and the file-by-file diff.
- **US-3.** As a developer, I review my uncommitted changes, stage only the
  hunks I want, write a message, and commit — all from the browser.
- **US-4.** As a developer, I create a feature branch, check it out, and see the
  UI reflect the new HEAD.
- **US-5.** As a developer, I fetch and then push my branch to its remote and
  see the ahead/behind counts update; if the push is rejected I get a clear
  reason.
- **US-6.** As a developer juggling several repositories on the same host, I
  hit a shortcut, type a few letters, and switch the active repository.
- **US-7.** As a developer, I stash my work-in-progress, switch branches, then
  pop the stash back.
- **US-8.** As a cautious developer, before any destructive action I get a
  confirmation that names exactly what will happen.

## Functional requirements

Requirements use stable identifiers `REQ-OV-NNN`. Each is testable and
describes observable behavior.

### Repository context

- **REQ-OV-001.** `cbranch` SHALL operate on exactly one **active repository**
  at a time; all displayed Git state SHALL belong to that repository.
- **REQ-OV-002.** Given a host filesystem path, `cbranch` SHALL determine
  whether it is a valid Git repository (working tree or bare) and SHALL report a
  clear error for a non-repository path.
- **REQ-OV-003.** `cbranch` SHALL provide a switcher that lists known
  repositories, supports type-to-filter, and on selection replaces the active
  repository context entirely.
- **REQ-OV-004.** The switcher SHALL include recently-opened repositories and
  SHALL allow opening a new repository by entering its host path.
- **REQ-OV-005.** When no repository is active, `cbranch` SHALL present an empty
  state offering "open repository" rather than failing.

### Execution location & data handling

- **REQ-OV-006.** All Git reads and writes SHALL execute on the remote host
  against the on-disk repository via the host filesystem; the browser SHALL NOT
  hold a copy of repository objects or working-tree files.
- **REQ-OV-007.** The browser client SHALL communicate with the host service
  only through the typed RPC transport and SHALL render state it receives; it
  SHALL NOT execute Git logic locally.

### Safety & concurrency

- **REQ-OV-008.** Mutating operations SHALL be serialized per repository so that
  two mutating operations on the same repository cannot run concurrently.
- **REQ-OV-009.** Every destructive operation (discard changes, delete branch,
  delete tag, drop stash, force push, reset that loses commits) SHALL require an
  explicit user confirmation that names the affected entity and the effect.
- **REQ-OV-010.** After any host-side mutation, `cbranch` SHALL invalidate cached
  repository state so subsequent reads reflect the new on-disk reality.

### Phase capability gating

- **REQ-OV-011.** In P1, the UI SHALL expose only read operations and SHALL not
  present staging, committing, or sync controls.
- **REQ-OV-012.** In P2, `cbranch` SHALL display working-tree and index changes
  separately and SHALL support staging/unstaging at file and hunk granularity
  and creating commits.
- **REQ-OV-013.** In P3, `cbranch` SHALL support branch lifecycle (create,
  rename, delete, checkout), fetch/pull/push, ahead/behind reporting, stash,
  tag, worktree management, and non-conflicting merge.
- **REQ-OV-014.** Features designated out of scope for v1 (conflict editor,
  cherry-pick, blame, file history, interactive rebase, reflog, bisect, archive,
  clean, gc, submodules) SHALL NOT be required for MVP acceptance.

### Error reporting

- **REQ-OV-015.** When a Git operation fails, `cbranch` SHALL surface a
  human-readable cause and SHALL preserve the repository in a well-defined state
  (either fully applied or not applied, never a silent partial state that the UI
  misrepresents).
- **REQ-OV-016.** Network-dependent operations that fail due to authentication,
  connectivity, or remote rejection SHALL be distinguishable to the user from
  local failures.

### Security

- **REQ-OV-017.** The host service SHALL bind to a configurable interface,
  defaulting to a loopback address, SHALL NOT be exposed to the public internet,
  and SHALL require explicit opt-in plus a startup warning for any non-loopback
  bind.
- **REQ-OV-018.** v1 SHALL NOT implement app-level authentication (no login or
  session token); it assumes a trusted perimeter. Adding authentication later
  SHALL be a non-breaking additive change in front of the same RPC contract.
- **REQ-OV-019.** The service SHALL validate the request `Origin`/`Host` (and the
  WebSocket upgrade `Origin`) against an allowlist and SHALL reject mismatches,
  even though app-level auth is descoped (defense against cross-site/DNS-rebinding
  access to the loopback service).

## Git operations

This is a conceptual overview section; the precise subcommands, flags, and
parsed output for each capability are specified in their dedicated sections.
At a high level:

- **All Git operations** — local read/index/commit/graph as well as network
  synchronization (`fetch`, `pull`, `push`) and everything else (rebase including
  interactive, revert, cherry-pick, worktrees, blame, submodules, reflog,
  maintenance/gc, merges, and launching external merge tools) — are served by the
  **host `git` binary** via child processes. Network sync uses host `git` because
  real-world remotes are typically reached over SSH (host keys, agent, credential
  helpers), which a pure-JS engine cannot service.
- A single `GitEngine` interface fronts the one backend; the invocation details
  are invisible to callers. Hot read paths stay fast via a per-repository
  `git cat-file --batch` process pool and `--no-optional-locks` on reads (there is
  no in-process pure-JS engine).
- `clone` is out of scope — repositories are opened by an existing on-disk path.

Concrete command lines and the exact output formats parsed (for example, the
machine-readable porcelain status, the null-delimited field formats for log and
ref enumeration, and ahead/behind counts) are defined in the per-feature
specification sections, not here.

## UI/UX requirements

Expressed functionally in terms of the chosen component toolkit (a React
component library with virtualization, a command palette, and code-focused
editor components). No visual styling is prescribed here beyond behavior.

- **REQ-OV-UX-001.** The repository switcher SHALL be a command-palette overlay
  (cmdk-style) invokable by keyboard shortcut and by an always-visible control,
  supporting fuzzy type-to-filter and keyboard selection.
- **REQ-OV-UX-002.** Long lists (commit history, file lists, change lists)
  SHALL be virtualized so scrolling stays smooth on very large repositories.
- **REQ-OV-UX-003.** The primary layout SHALL present, for the active
  repository, a history/graph region, a details/diff region, and (from P2) a
  changes/staging region, navigable by both pointer and keyboard.
- **REQ-OV-UX-004.** Diffs SHALL render with clear add/remove/context
  distinction and support file-level and hunk-level granularity in the diff
  view component.
- **REQ-OV-UX-005.** Destructive actions SHALL be presented through a
  confirmation dialog that states the entity and the consequence; the
  confirming action SHALL be visually distinct from the cancel action.
- **REQ-OV-UX-006.** Long-running operations (sync, large diffs) SHALL show
  non-blocking progress or busy indication and SHALL not freeze the UI.
- **REQ-OV-UX-007.** Server-derived data SHALL be cached and revalidated through
  the data-fetching layer; transient UI state SHALL be held separately from
  server state.
- **REQ-OV-UX-008.** Errors SHALL be surfaced inline near the triggering action
  (and/or via a transient notification) with the plain-language cause from
  REQ-OV-015.

## Acceptance criteria

- **AC-1.** Opening a valid repository path renders its commit graph with
  branch and tag labels and the current HEAD indicated; opening an invalid path
  shows a clear, non-fatal error (covers REQ-OV-002, REQ-OV-005).
- **AC-2.** Selecting any commit shows author/committer/date/message/parents and
  a file-by-file diff that can be expanded to hunks (P1).
- **AC-3.** A user can stage a single hunk, leave other hunks unstaged, commit,
  and then see the new commit at the top of the graph (P2).
- **AC-4.** A user can create and check out a branch and observe HEAD move to it
  in the UI (P3).
- **AC-5.** A user can fetch then push; ahead/behind counts update accordingly,
  and a rejected push yields a distinguishable, plain-language error
  (REQ-OV-016).
- **AC-6.** A user can stash, switch branches, and pop the stash, observing the
  working tree restored (P3).
- **AC-7.** Triggering any destructive action without confirming leaves the
  repository unchanged; confirming performs exactly the stated effect
  (REQ-OV-009).
- **AC-8.** Switching the active repository in the switcher fully replaces the
  displayed context with no data from the previous repository remaining
  (REQ-OV-001, REQ-OV-003).
- **AC-9.** The service binds loopback by default and rejects a WebSocket upgrade
  whose `Origin`/`Host` is not on the allowlist; a non-loopback bind requires
  explicit opt-in (REQ-OV-017..019).

## Edge cases & error handling

- **EC-1 — Empty repository (no commits).** History view shows an explicit
  "no commits yet" state; commit (P2) is still possible to create the first
  commit.
- **EC-2 — Detached HEAD.** The UI clearly indicates a detached HEAD and the
  exact commit it points at, and warns appropriately before actions that would
  abandon commits made while detached.
- **EC-3 — Bare repository.** Recognized as valid; working-tree/staging features
  that require a working tree are unavailable and clearly indicated rather than
  erroring obscurely.
- **EC-4 — Repository becomes unavailable** (path removed, permissions change,
  unmounted): `cbranch` reports a clear error and offers to switch/reopen rather
  than showing stale data as if live.
- **EC-5 — Concurrent external changes** (the user also runs `git` in a
  terminal): after detecting or being told of a change, `cbranch` revalidates
  and reflects current on-disk state (REQ-OV-010).
- **EC-6 — Merge cannot auto-complete.** A merge that would conflict is reported
  as such with affected files listed; automatic conflict resolution is out of
  scope for v1 (deferred to P4).
- **EC-7 — Network/auth failures during sync.** Reported with a distinguishable,
  plain-language cause; the local repository is left consistent.
- **EC-8 — Very large diffs or binary files.** Rendered with appropriate
  truncation/placeholder handling so the UI stays responsive (binary files shown
  as "binary, N bytes changed" rather than attempting a text diff).
- **EC-9 — Lost service connection** (tunnel drops): the browser indicates a
  disconnected state and attempts to reconnect rather than silently presenting
  stale, un-actionable data.
- **EC-10 — Two mutating actions requested at once:** the second is queued or
  rejected per the per-repository lock (REQ-OV-008), never interleaved.

## Out of scope

For v1 (the P1–P3 MVP), the following are explicitly out of scope and tracked
for later phases or separate tracks:

- Conflict-resolution merge editor, cherry-pick, blame, and file history (P4).
- Interactive rebase, reflog browser, bisect, archive export, working-tree
  `clean`, garbage-collection/maintenance UI, and submodule management (P5).
- The VSCode webview extension (parallel track; shares the same core).
- Simultaneous multi-repository views, repository hosting/forge functionality,
  multi-user accounts and permissions, code review, and CI/CD integration.
- Public/non-loopback network exposure and any app-level authentication model
  (v1 assumes a trusted perimeter with a default loopback bind plus an
  `Origin`/`Host` check; remote Git auth is handled out-of-band at the host).

## Glossary

Plain-language definitions of the Git concepts referenced throughout the
`cbranch` specification.

- **Repository.** The complete database of a project's version history,
  including all commits, branches, tags, and configuration. On disk it is the
  data managed inside the project's Git control directory.
- **Working tree (working directory).** The actual files on disk that you edit.
  It reflects a checked-out snapshot plus any uncommitted modifications.
- **Index (staging area).** An intermediate area that holds the exact set of
  changes that will go into the next commit. Staging moves changes from the
  working tree into the index; the index is what a commit is built from.
- **Ref (reference).** A human-friendly name that points to a commit. Branches
  and tags are kinds of refs.
- **Branch.** A movable ref that points to a commit and advances as you add new
  commits. It represents an independent line of development.
- **Remote-tracking branch.** A local, read-only ref that records where a branch
  on a remote was the last time you communicated with that remote. It is how
  `cbranch` shows "what the remote looked like" and computes ahead/behind.
- **Tag.** A ref that marks a specific commit, typically a release point.
  Lightweight tags are just a name pointing at a commit; annotated tags also
  carry their own message, author, and date.
- **Commit.** An immutable snapshot of the tracked content at a point in time,
  identified by a hash, carrying metadata (author, committer, dates, message)
  and pointers to one or more parent commits.
- **HEAD.** A pointer to "where you are now" — normally the branch you currently
  have checked out (and thus the commit at its tip).
- **Detached HEAD.** The state where HEAD points directly at a commit rather than
  at a branch. New commits made here are not on any branch and can be lost if you
  move away without creating a branch to keep them.
- **Stash.** A saved bundle of uncommitted working-tree and index changes set
  aside so you can return to a clean working tree, then restored (applied or
  popped) later.
- **Worktree.** An additional working directory linked to the same repository,
  allowing a different branch to be checked out simultaneously without cloning.
- **Hunk.** A contiguous block of changed lines within a file's diff, with a few
  surrounding context lines. Hunks are the unit of granular staging.
- **Diff.** A computed comparison between two states (e.g., working tree vs.
  index, index vs. HEAD, or one commit vs. another) showing added, removed, and
  context lines.
- **Merge.** Combining the histories of two branches into one, producing (when
  needed) a merge commit with multiple parents. A fast-forward merge simply
  advances a branch pointer when no divergence exists.
- **Rebase.** Reapplying a series of commits onto a different base commit,
  producing new commits and a linear history. (Deferred beyond v1.)
- **Cherry-pick.** Applying the change introduced by a specific commit onto the
  current branch as a new commit. (Deferred beyond v1.)
- **Fetch.** Downloading new objects and updating remote-tracking branches from a
  remote, without changing your local branches or working tree.
- **Pull.** Fetching and then integrating (merging or rebasing) the fetched
  changes into the current branch.
- **Push.** Sending local commits to a remote and updating the remote's branch,
  subject to the remote accepting the update.
- **Upstream.** The remote-tracking branch a local branch is configured to
  compare and sync against; the basis for ahead/behind counts.
- **Ahead/behind.** The number of commits a local branch has that its upstream
  lacks (ahead) and that the upstream has that the local branch lacks (behind).

## High-level feature map by phase

| Capability | P1 | P2 | P3 | Later (P4/P5/ext) |
| --- | :-: | :-: | :-: | :-: |
| Open repo / validate path | x | | | |
| Repository switcher | x | | | |
| Commit history graph + labels | x | | | |
| Commit details + diff (file & hunk view) | x | | | |
| List branches / remote-tracking / tags (read) | x | | | |
| HEAD / detached-HEAD indication | x | | | |
| Working-tree vs. index views | | x | | |
| Stage/unstage files and hunks | | x | | |
| Discard working-tree changes (confirmed) | | x | | |
| Create commit (+ amend latest when safe) | | x | | |
| Branch create/rename/delete/checkout | | | x | |
| Fetch / pull / push (host `git`) | | | x | |
| Ahead/behind reporting | | | x | |
| Stash create/list/show/apply/pop/drop | | | x | |
| Tag list/create/delete/push | | | x | |
| Worktree list/add/remove | | | x | |
| Non-conflicting merge | | | x | |
| Conflict merge editor, cherry-pick, blame, file history | | | | x (P4) |
| Interactive rebase, reflog, bisect, archive, clean, gc, submodules | | | | x (P5) |
| VSCode webview extension | | | | x (ext) |
