# Non-functional Requirements

## Purpose

This section defines the cross-cutting quality requirements for `cbranch` — the
characteristics that every feature must satisfy regardless of which functional
area it belongs to. It covers how the product is tested, how fast it must
respond, how it behaves for keyboard and assistive-technology users, how text is
localized and themed, how errors are surfaced, what is logged, how configuration
persists, how the product is packaged and run behind a trusted perimeter, how it
is versioned and released, and the security review gates it must pass before a
release.

These requirements apply to all packages in the monorepo
(`packages/core`, `packages/rpc-contract`, `packages/ui`, `apps/web-server`,
and the later `apps/vscode-ext`) and to the single-backend `GitEngine`
implementation (one host-`git` backend behind the `GitEngine` interface — there
is no in-process pure-JS engine; hot reads use a per-repo `git cat-file --batch`
process pool and `--no-optional-locks`).

Each requirement has a stable identifier of the form `NF-<area>-<n>` so it can be
referenced from test plans and traceability matrices. Requirements are testable
and describe observable behavior.

## User stories

- As a developer relying on `cbranch` to mutate real repositories, I want a test
  suite that exercises real Git behavior against disposable fixture repositories,
  so I can trust that a refactor did not silently corrupt index, commit, or sync
  behavior.
- As a contributor, I want the RPC contract between browser and host service to
  be validated by automated contract tests, so a change on one side that breaks
  the other side is caught before release.
- As a keyboard-only or screen-reader user, I want every primary action
  reachable without a mouse and announced correctly, so I can manage repositories
  with assistive technology.
- As a user working in a non-English locale, I want all visible strings
  localizable, so the product can be translated without code changes.
- As a security-conscious operator running the service behind a trusted perimeter
  (LAN / VPN / Tailscale, or loopback-over-SSH), I want the product to bind to
  loopback by default, reject cross-site connection attempts (Origin/Host check),
  and emit no telemetry unless I opt in, so I am not surprised by outbound
  connections or open ports.
- As an operator, I want a single, documented way to install and launch the host
  service and to connect a browser, so onboarding is reliable.
- As a maintainer, I want predictable versioning and a security checklist gating
  releases, so I can ship with confidence.

## Functional requirements

### Testing strategy

- **NF-TEST-1 — Test runner.** The project MUST provide a single command per
  package to run that package's automated tests, and a single root command that
  runs all packages' tests. Both MUST exit non-zero on any failure and print a
  machine-readable summary (counts of passed, failed, skipped).
- **NF-TEST-2 — Core/engine unit tests.** `packages/core` MUST have unit tests
  covering each public operation of the `GitEngine` interface against disposable
  fixture repositories (NF-TEST-3), asserting the parsed domain shape and
  observable result for representative inputs. (There is a single host-`git`
  backend, so no cross-backend parity test is required; tests MAY still assert that
  results equal the equivalent direct `git` invocation.)
- **NF-TEST-3 — Fixture-repository harness.** The test suite MUST include a
  harness that programmatically creates throwaway Git repositories in a temporary
  directory and tears them down after each test. The harness MUST support, at
  minimum: initializing an empty repository; creating commits with specified
  author, committer, message, timestamp, and file contents; creating and deleting
  branches and tags; creating detached-HEAD states; creating merge commits and
  divergent histories; staging partial changes; producing dirty working trees;
  producing unmerged/conflicted index states; and configuring local remotes
  (using a second on-disk repository as the remote) so fetch/pull/push paths can
  be exercised without a network. Each fixture MUST be reproducible from a
  declarative description so tests are deterministic.
- **NF-TEST-4 — Deterministic fixtures.** Fixture creation MUST allow fixed
  commit timestamps and identities so that resulting commit hashes are stable
  across runs and machines, enabling assertions on exact hashes where useful.
- **NF-TEST-5 — RPC contract tests.** `packages/rpc-contract` MUST have tests
  that validate, for every RPC method: the request and response payload schemas;
  that the typed client and the server handler agree on method names and shapes;
  and that an intentionally malformed payload is rejected with a typed error
  rather than crashing the service. Contract tests MUST fail if a method is added
  on one side without a corresponding definition.
- **NF-TEST-6 — Transport-agnostic contract tests.** RPC contract tests MUST run
  against an in-memory transport (no sockets) so they are fast and independent of
  the WebSocket/HTTP or webview transport implementation.
- **NF-TEST-7 — UI component tests.** `packages/ui` MUST have component tests for
  interactive components (forms, dialogs, lists, the command palette, the diff
  and merge views) that assert rendered output and behavior in response to
  simulated user events, using mocked RPC responses. Component tests MUST NOT
  require a live host service.
- **NF-TEST-8 — End-to-end tests.** There MUST be an e2e suite that starts the
  real host service against a throwaway repository, connects a real browser
  context, and drives primary workflows (open repository; view log/graph; stage
  and commit; create/switch/delete branch; fetch/pull/push against a local
  remote; stash; resolve a conflict). E2e repositories MUST be created and
  destroyed per test run and MUST never point at a user's real repositories.
- **NF-TEST-9 — Per-repo lock tests.** There MUST be explicit tests proving that
  mutating operations on a single repository are serialized: when two mutating
  operations are issued concurrently for the same repository, the second MUST NOT
  begin until the first completes, and the repository MUST end in a consistent
  state. A complementary test MUST prove that mutating operations on *different*
  repositories are allowed to proceed concurrently.
- **NF-TEST-10 — Invalidation-bus tests.** There MUST be explicit tests proving
  that a mutation — whether performed through cbranch **or by an external `git`
  invocation in a terminal** — causes the host filesystem watcher to emit an
  `InvalidationEvent` for the correct domains (see `15-sync-protocol.md`) and that a
  subsequent read reflects the change. The test MUST fail if a read returns stale
  pre-mutation data after the event fires. (There is no in-process engine cache;
  object reads are content-addressed via the `cat-file --batch` pool.)
- **NF-TEST-11 — Coverage gate.** CI MUST measure line and branch coverage for
  `packages/core` and `packages/rpc-contract` and MUST fail if coverage for those
  packages drops below a configured threshold (default: 80% lines). The threshold
  MUST be configurable per package.
- **NF-TEST-12 — CI execution.** All test suites (unit, contract, component, e2e,
  lock, invalidation) MUST run in continuous integration on every pull request, and
  a release MUST be blocked if any suite fails.

### Performance budgets

Budgets are measured on a reference host (4 vCPU, 8 GB RAM, SSD) against a
reference repository of 50,000 commits and 20,000 tracked files, with the browser
connected over a typical remote link (round-trip latency up to 80 ms). Each budget
is a requirement and MUST have an automated or scripted measurement. Budgets
assume the reference repository size, not million-file monorepos (see Out of
scope).

- **NF-PERF-1 — Initial repository view.** After a repository is selected, the
  first screen of the commit log/graph (the first viewport of rows) MUST be
  visible within 1.5 s at the 95th percentile.
- **NF-PERF-2 — Incremental log loading.** The commit log MUST load
  incrementally; the user MUST NOT wait for the entire history before seeing and
  scrolling the first results. Additional pages MUST load on demand as the user
  scrolls.
- **NF-PERF-3 — Large-list virtualization.** Any list that can exceed 200 rows
  (commit log, file lists, branch lists, reflog) MUST be virtualized so that
  rendering cost is bounded by the visible viewport and does not grow with total
  item count. Scrolling 50,000 commits MUST stay at or above an effective 50 fps
  on the reference host.
- **NF-PERF-4 — Diff rendering.** A diff of a file up to 5,000 changed lines MUST
  render its first viewport within 500 ms. Larger diffs MUST be progressively
  rendered or offered as collapsed with an explicit "load full diff" action.
- **NF-PERF-5 — Status responsiveness.** Computing and displaying working-tree
  status after a file change MUST complete within 750 ms at the 95th percentile
  on the reference repository.
- **NF-PERF-6 — Mutation feedback latency.** For any mutating action, visible
  acknowledgement (progress indicator or optimistic state) MUST appear within
  150 ms of the user action, even if the underlying Git operation takes longer.
- **NF-PERF-7 — Memory bound.** The host service's steady-state resident memory
  for a single open reference repository MUST stay below 1 GB. Caches MUST be
  bounded and evictable; an open repository MUST NOT cause unbounded memory
  growth over a long session.
- **NF-PERF-8 — Payload efficiency.** RPC responses for paged data MUST send only
  the requested page; full-history payloads MUST NOT be sent in a single
  response. Binary file contents MUST NOT be sent to the browser unless explicitly
  requested for preview, and previews MUST be size-capped with a documented
  default cap.
- **NF-PERF-9 — Performance regression CI gate.** The measurement scripts for the
  above budgets MUST run in CI on the reference host (or a documented equivalent)
  and MUST record results as a CI artifact (the baseline). The gate MUST **fail the
  build** if any budget regresses by more than a configured tolerance — **default
  10%** — versus the recorded baseline, or if any absolute budget (NF-PERF-1..8) is
  exceeded. The baseline and tolerance MUST be documented and updatable with review.

### Thresholds & limits (configurable)

All thresholds below MUST be configurable in the settings store (NF-CFG-7) under a
`thresholds` object; the values given are the **defaults**. They protect the UI and
transport from pathological inputs.

- **NF-LIMIT-1 — Large-diff deferral.** A file diff exceeding **2,000 changed
  lines** OR **512 KB** of patch text MUST be deferred: render a collapsed
  placeholder with an explicit "load full diff" action (ties to NF-PERF-4).
- **NF-LIMIT-2 — Binary-preview cap.** Inline binary/image preview MUST be capped at
  **5 MB**; beyond the cap the UI shows metadata (type, size) instead of fetching
  content.
- **NF-LIMIT-3 — Blame / file-content cap.** `blame.get` and `file.contentAtRev`
  MUST cap inline delivery at **10 MB**; larger content MUST be delivered via the
  streamed HTTP download side-channel (`14 §3.7`), never base64 over RPC.
- **NF-LIMIT-4 — Merge-editor size limit.** The 3-pane merge editor MUST refuse to
  open a conflicted file larger than **2 MB** inline, offering the external merge
  tool / download path instead, so the editor stays responsive.
- **NF-LIMIT-5 — Log page size.** `log.stream` MUST request history in bounded
  windows; the default window/limit is **500** commits, server-bounded regardless of
  a larger client request.
- **NF-LIMIT-6 — RPC payload cap.** A single RPC message MUST be capped at **1 MB**;
  any larger payload MUST use the HTTP side-channel (`14 §3.7`). The cap MUST be
  enforced on both send and receive.

### Accessibility

- **NF-A11Y-1 — Keyboard-first.** Every primary action MUST be invokable from the
  keyboard without a pointing device. There MUST be no action that is reachable
  only via hover or only via mouse.
- **NF-A11Y-2 — Visible focus.** A visible focus indicator MUST be present on the
  currently focused element at all times during keyboard navigation, with
  contrast meeting WCAG 2.1 AA against its background.
- **NF-A11Y-3 — Logical focus order.** Tab order MUST follow a logical reading
  order. Opening a dialog MUST move focus into the dialog and trap focus within it
  until it is dismissed; closing it MUST return focus to the control that opened
  it.
- **NF-A11Y-4 — ARIA roles and names.** Interactive elements MUST expose correct
  roles, accessible names, and states to assistive technology. Lists MUST use
  appropriate list/grid semantics; the commit graph and file trees MUST expose
  position and selection state; toggles and menu items MUST announce their state.
- **NF-A11Y-5 — Live regions.** Asynchronous outcomes (operation succeeded,
  operation failed, background fetch completed) MUST be announced via an ARIA live
  region so screen-reader users are informed without moving focus.
- **NF-A11Y-6 — Command palette.** The product MUST provide a command palette
  (cmdk) reachable by a documented keyboard shortcut from anywhere in the app. The
  palette MUST allow searching for and invoking any primary command by name, MUST
  be fully keyboard-operable, and MUST be screen-reader accessible.
- **NF-A11Y-7 — Color independence.** No information (e.g., added/removed lines,
  branch status, conflict state) may be conveyed by color alone; a non-color cue
  (icon, text, or shape) MUST accompany it.
- **NF-A11Y-8 — Contrast.** Text and meaningful UI elements MUST meet WCAG 2.1 AA
  contrast ratios in both light and dark themes.
- **NF-A11Y-9 — Reduced motion.** When the user's system indicates a reduced-motion
  preference, non-essential animations and transitions MUST be disabled or
  minimized.
- **NF-A11Y-10 — Automated a11y checks.** Component tests MUST include automated
  accessibility assertions (role/name/state checks) on dialogs, forms, the command
  palette, and primary navigation, and these checks MUST run in CI.

### Internationalization

- **NF-I18N-1 — Externalized strings.** All user-visible text MUST be sourced from
  i18next resource bundles. No user-visible string may be hard-coded in component
  logic.
- **NF-I18N-2 — Fresh bundles.** All translation resources MUST be authored fresh
  for `cbranch`. No translation strings from any other product may be copied or
  imported. The default and source locale is English (`en`).
- **NF-I18N-3 — Key structure.** Resource keys MUST be namespaced by feature area
  (e.g., `commit.*`, `branch.*`, `merge.*`, `errors.*`) to keep bundles
  maintainable and to allow lazy loading per area.
- **NF-I18N-4 — Interpolation and pluralization.** Strings with variables MUST use
  named interpolation, and count-dependent strings MUST use i18next pluralization
  rather than string concatenation, so locales with different plural rules render
  correctly.
- **NF-I18N-5 — Locale selection.** The active locale MUST be selectable by the
  user and MUST persist (see Configuration persistence). If a requested locale or
  key is missing, the product MUST fall back to English and MUST NOT show a raw
  key to the user where a fallback exists.
- **NF-I18N-6 — No layout breakage.** The UI MUST tolerate strings up to roughly
  1.5x the English length without truncation that hides meaning or breaks layout.
- **NF-I18N-7 — Locale-aware formatting.** Dates, times, and numbers shown to the
  user MUST be formatted according to the active locale; raw Git timestamps from
  the engine MUST be formatted at the presentation layer, not stored pre-formatted.
- **NF-I18N-8 — Missing-key detection.** A build or test check MUST detect keys
  present in the source locale but missing from other shipped locales, and MUST
  detect keys referenced in code but absent from the source bundle.

### Theming

- **NF-THEME-1 — CSS-variable theming.** Theming MUST be driven by the shadcn/ui
  (`base-lyra` on Base UI) CSS custom properties (design tokens) over Tailwind v4.
  Components MUST reference theme variables rather than hard-coded color values.
- **NF-THEME-2 — Light and dark.** The product MUST ship at least a light and a
  dark theme. The active theme MUST be user-selectable with options for light,
  dark, and "follow system", and the selection MUST persist.
- **NF-THEME-3 — System preference.** When "follow system" is selected, the theme
  MUST track the operating-system/browser color-scheme preference and update live
  if it changes.
- **NF-THEME-4 — Editor theme mapping (extension).** In the VSCode webview
  extension, the product MUST map the host editor's theme tokens (foreground,
  background, accent, and editor colors) onto the cbranch CSS theme variables so
  the embedded UI visually matches the editor's active theme, and MUST update when
  the editor theme changes.
- **NF-THEME-5 — Diff and merge theming.** Syntax highlighting (Shiki) and
  diff/merge coloring MUST derive from the active theme so that added/removed/
  conflict regions remain legible and contrast-compliant in both themes (subject to
  NF-A11Y-7 and NF-A11Y-8).
- **NF-THEME-6 — No flash.** The initially correct theme MUST be applied before
  first meaningful paint to avoid a visible light/dark flash on load.

### Telemetry

- **NF-TELEM-1 — Off by default.** The product MUST collect and transmit no
  telemetry, analytics, or usage data by default. A fresh installation MUST make no
  outbound network connection for telemetry.
- **NF-TELEM-2 — Opt-in only.** Any telemetry MUST be strictly opt-in via an
  explicit user action. The default state MUST be off, and the opt-in MUST be
  revocable at any time with immediate effect.
- **NF-TELEM-3 — Transparency.** If telemetry is enabled, the product MUST document
  exactly what is collected and where it is sent, and MUST never include repository
  contents, file paths, commit messages, remote URLs, credentials, or identities.
- **NF-TELEM-4 — No silent endpoints.** There MUST be no hidden or undocumented
  network endpoints contacted by the product for any reason.

### Error handling and user feedback

- **NF-ERR-1 — Typed errors across RPC.** Engine and service errors MUST cross the
  RPC boundary as the canonical **`GitError`** union defined in `14 §4` (a stable
  machine-readable `code`, a human-readable `message`, and optional typed `detail`),
  never as opaque stack traces. Classification MUST be deterministic (exit-code +
  known sentinels, not locale-dependent message parsing).
- **NF-ERR-2 — Toasts for outcomes.** Transient operation outcomes MUST be surfaced
  to the user as toast notifications (sonner): success, failure, and long-running
  progress. Failure toasts MUST present a clear message and, where applicable, an
  action (retry, view details, open conflict resolver).
- **NF-ERR-3 — Actionable messages.** Error messages MUST be phrased in terms of
  what happened and what the user can do next, localized via i18next, and MUST NOT
  expose internal stack traces or absolute internal paths to the end user.
- **NF-ERR-4 — Non-destructive on failure.** If a mutating operation fails, the
  product MUST leave the repository in a defined, recoverable state and MUST tell
  the user the current state (e.g., "merge aborted; working tree unchanged" or
  "merge stopped with conflicts; resolve to continue"). Partial UI state MUST be
  reconciled with the real repository state after a failure.
- **NF-ERR-5 — Lock contention feedback.** If an operation cannot start because the
  per-repository lock is held, the user MUST be informed that another operation is
  in progress rather than seeing a silent hang or an error.
- **NF-ERR-6 — Connection loss.** If the RPC transport (the multiplexed WebSocket)
  disconnects, the UI MUST show a non-blocking "reconnecting" indicator, MUST stop
  presenting data as live, and MUST attempt to reconnect. On reconnect it MUST
  re-establish the `repo.subscribe` stream and **invalidate every query for the
  active repo** (a full resnapshot via refetch — `15 §5`), rather than trust
  potentially stale cached data. No missed-event replay is needed (state is
  re-derivable on demand). Ties to `01` EC-9.
- **NF-ERR-7 — Confirmation for destructive actions.** Destructive actions (e.g.,
  force operations, branch/tag deletion, discarding changes, history rewrite) MUST
  require explicit confirmation via a dialog (shadcn/ui AlertDialog) that names the
  specific target and consequence.

### Live data: filesystem watcher & reconnect (reliability)

- **NF-WATCH-1 — Watcher configuration.** The host service MUST run a per-`repoId`
  filesystem watcher (**chokidar**, pinned) over the repository's common git dir
  (`git rev-parse --git-common-dir`) plus the worktree, feeding the invalidation
  bus (`15`). It MUST **ignore** high-volume irrelevant churn — at minimum the glob
  patterns `*.lock` and `objects/**` — and MUST coalesce a burst of changes within a
  **~150 ms debounce window** into a single `InvalidationEvent` whose `domains` is
  the union of all affected domains for that tick.
- **NF-WATCH-2 — Watcher lifecycle.** One watcher per `repoId` MUST be shared across
  all connections/tabs subscribed to that repo, and MUST be torn down when the last
  `repo.subscribe` subscriber disconnects (no watcher leak; ties to REQ-ARCH-042).
- **NF-WATCH-3 — Echo tolerance.** A cbranch-initiated mutation already invalidates
  the relevant queries on the calling client; the watcher firing for that same
  on-disk change MAY cause a redundant invalidation. This MUST be acceptable
  (coalescing + query dedup absorb it) and MUST NOT be suppressed so aggressively
  that a concurrent external (terminal) change is missed (`15 §4`).

### Logging

- **NF-LOG-1 — Structured server logs.** The host service MUST emit structured logs
  (one JSON object per line) including timestamp, level, a request/operation
  correlation id, the operation name, and outcome. Logs MUST be written to stderr/a
  file, never sent to any third party.
- **NF-LOG-2 — Configurable level.** The log level MUST be configurable (at least
  error, warn, info, debug) via configuration or environment variable, defaulting
  to info.
- **NF-LOG-3 — Git command logging.** At debug level, the service MUST log each
  host-`git` invocation it runs (subcommand and flags) and its exit status, to aid
  troubleshooting. It MUST redact credentials and MUST NOT log remote URLs'
  embedded secrets or token values.
- **NF-LOG-4 — No secret leakage.** Logs MUST never contain credentials (e.g.
  remote-URL-embedded secrets, credential-helper output) or file contents. A test
  MUST assert that known secret values do not appear in emitted logs. (There is no
  app-level session token in v1.)
- **NF-LOG-5 — Client diagnostics.** The browser MUST be able to surface a
  diagnostics view or downloadable log of recent client-side errors and the last
  RPC failures, to support bug reports, without transmitting them anywhere
  automatically.

### Configuration persistence

- **NF-CFG-1 — Persisted preferences.** User preferences (active theme, locale, UI
  layout choices, the list of known repositories for the repo switcher, and per-view
  settings) MUST persist across sessions.
- **NF-CFG-2 — Host-side store.** Preferences that belong to the host environment
  (known repositories, service settings, log level) MUST persist on the host in a
  documented configuration file location. The file format MUST be human-readable
  (e.g., JSON) and editable.
- **NF-CFG-3 — Browser-side store.** Purely presentational, per-browser preferences
  MAY persist in browser storage, but MUST degrade gracefully if storage is
  unavailable (the product still functions with defaults).
- **NF-CFG-4 — No repo config mutation without intent.** The product MUST NOT modify
  a repository's own Git configuration as a side effect of viewing it. Any change to
  repository or global Git config MUST be an explicit, user-initiated action.
- **NF-CFG-5 — Defaults and migration.** Missing or unreadable configuration MUST
  fall back to documented defaults without crashing. When the configuration schema
  changes between versions, the service MUST migrate or safely ignore unknown fields
  rather than fail to start.
- **NF-CFG-6 — Secrets handling.** cbranch MUST NOT write any credentials to the
  persisted preference files. Network credentials for sync MUST be handled by the
  host `git` binary and its configured credential mechanisms (`ssh-agent` /
  `credential.helper` / `gh`), not stored by cbranch. (There is no app-level session
  token in v1; see the trust model in `14 §3.6` and NF-PKG-2/NF-SEC-2.)
- **NF-CFG-7 — Settings store schema & location.** Host-side settings MUST persist
  as human-readable JSON at `$XDG_CONFIG_HOME/cbranch/config.json` (default
  `~/.config/cbranch/config.json`; on Windows `%APPDATA%\cbranch\config.json`),
  overridable via `CBRANCH_CONFIG`. The file MUST carry a top-level integer
  `version` for migration and at least these fields:
  - `version` — schema version.
  - `recentRepos: [{ path, name, repoId, lastOpenedAt }]` — the single source for
    the repo switcher's recent list (`repoId` per `14 §3.5`; `path` is the resolved
    top-level working path).
  - `theme` (`light | dark | system`), `locale`, `logLevel`
    (`error | warn | info | debug`).
  - `bind: { address, port }` — service bind address and port (defaults NF-PKG-9).
  - `thresholds` — the configurable limits in NF-LIMIT-1..6.
  - `keybindings` — user key-binding overrides.
  Missing/unreadable config falls back to documented defaults (NF-CFG-5); unknown
  fields are migrated or safely ignored.

### Packaging and distribution (web target)

- **NF-PKG-1 — Single deployable unit.** The web target MUST be distributable as a
  single Node host service plus a pre-built static single-page application served by
  that service. Running one documented command MUST start the service and serve the
  SPA.
- **NF-PKG-2 — Local binding by default.** By default the service MUST bind to
  `127.0.0.1` only. Binding to any non-loopback interface MUST require an explicit,
  documented opt-in (config `bind.address` or `CBRANCH_BIND_ADDRESS`) and MUST emit
  a prominent startup warning that the deployment relies on a trusted perimeter
  (LAN/VPN/Tailscale) and MUST NOT be exposed to the public internet (there is no
  app-level auth — NF-SEC-2).
- **NF-PKG-3 — Run instructions.** Distribution MUST include clear instructions for
  the intended deployment: run the service on the host, reach it within a trusted
  perimeter (loopback, or forward the port over SSH —
  `ssh -L <local>:127.0.0.1:<remote> user@host`, or VSCode Remote-SSH automatic
  forwarding), then open the URL in a browser. The instructions MUST state that v1
  has no app login/token (access control is the perimeter) and that the bind address
  MUST stay loopback unless the operator deliberately widens it (NF-PKG-2).
- **NF-PKG-4 — Companion-agent installer.** There MUST be a documented installer for
  the companion host agent (the service) that works on the supported remote
  platforms, verifies that a compatible host `git` binary and Node runtime are
  present, and fails with a clear message if prerequisites are missing.
- **NF-PKG-5 — Prerequisite checks & Git version floor.** On startup the service
  MUST run `git --version` once and verify a **minimum host Git version of 2.37**,
  reporting a clear, actionable typed error if `git` is absent
  (`GitError{ code: "hostGitMissing" }`) or too old
  (`GitError{ code: "hostGitTooOld" }`) rather than crashing. The floor is set by
  mandated flags:

  | Flag / behavior | Min git | If older |
  |---|---|---|
  | `--no-optional-locks` (reads) | 2.9 | — |
  | `status --porcelain=v2 -z` | 2.11 | hard error (parsing depends on v2) |
  | `switch` / `restore` | 2.23 | documented fallback to `checkout`/`reset` acceptable |
  | `stash push --staged` | 2.35 | hard error for partial-stash; whole-stash still works |
  | `worktree list --porcelain -z` | 2.36 | hard error for worktree listing |
  | `log --since-as-filter` | 2.37 | documented fallback to `--since` acceptable |

  Where a documented fallback exists the service MAY degrade that one feature; where
  the floor flag is structural to parsing it MUST surface `hostGitTooOld`. The
  version is detected once and gates version-dependent flags (never pass an unknown
  flag).
- **NF-PKG-6 — Reproducible build.** Building the distributable MUST be reproducible
  from a clean checkout with a single documented command, producing the static SPA
  assets and the runnable service.
- **NF-PKG-7 — No global side effects.** Installing and running the web target MUST
  NOT require root, MUST NOT modify system-wide state, and MUST be removable by
  deleting its install directory and configuration file.
- **NF-PKG-8 — Extension packaging (later track).** The VSCode extension, when
  shipped, MUST package the shared core and UI as a webview extension that reuses the
  same RPC contract over `webview.postMessage`, with no fork of core logic.
- **NF-PKG-9 — Bind/port defaults & env vars.** The service MUST default to bind
  address `127.0.0.1` and port **7420** (arbitrary; overridable). Configuration MUST
  be settable via the settings store (NF-CFG-7) and via environment variables, which
  take precedence: `CBRANCH_BIND_ADDRESS`, `CBRANCH_PORT`, `CBRANCH_CONFIG`,
  `CBRANCH_LOG_LEVEL`. A non-loopback `CBRANCH_BIND_ADDRESS` triggers the NF-PKG-2
  warning.

### Versioning and release

- **NF-REL-1 — Semantic versioning.** The product and its published packages MUST
  follow semantic versioning (MAJOR.MINOR.PATCH). Breaking changes to the RPC
  contract MUST increment the MAJOR version.
- **NF-REL-2 — RPC compatibility policy.** Within a MAJOR version, the host service
  MUST accept RPC requests from any client of an equal or older MINOR version, or
  MUST detect and clearly report a version mismatch on connect rather than failing
  obscurely.
- **NF-REL-3 — Version handshake.** On connection the client and service MUST
  exchange version information; on incompatibility the user MUST see a clear message
  indicating which side to update.
- **NF-REL-4 — Changelog.** Every release MUST have a human-readable changelog entry
  describing notable changes, with security-relevant fixes called out.
- **NF-REL-5 — Release gating.** A release MUST NOT be published unless all CI suites
  pass (NF-TEST-12) and the security review checklist (below) is completed for that
  release.
- **NF-REL-6 — Pinned dependencies.** Released artifacts MUST be built from a locked
  dependency set (lockfile committed) so a given version is reproducible.

### Security review checklist

The following items MUST be verified and recorded before each release
(NF-REL-5). Each is a requirement.

- **NF-SEC-1 — Local binding verified.** Confirm the service binds `127.0.0.1` by
  default and that any non-local binding requires explicit opt-in with a warning.
- **NF-SEC-2 — Trust model documented (no app auth in v1).** Confirm the build ships
  with **no app-level authentication/login/session token** and that the
  trusted-perimeter model and default loopback bind are documented in the run docs
  (`14 §3.6`, NF-PKG-2/3). Confirm a non-loopback bind requires explicit opt-in and
  emits the startup warning (NF-SEC-1).
- **NF-SEC-3 — Origin/Host checks (retained).** Confirm the WebSocket upgrade **and**
  the HTTP side-channel validate the `Origin`/`Host` header against a strict
  allowlist and reject mismatches — even with auth descoped — to defend against
  cross-site / DNS-rebinding access to the loopback service from a page in the user's
  browser. This rejection MUST happen before any `GitEngine` method runs.
- **NF-SEC-4 — No credential persistence.** Confirm cbranch never holds or persists
  remote Git credentials (handled by the host's `ssh-agent`/`credential.helper`/`gh`
  — NF-CFG-6) and never logs them (NF-LOG-4). (There is no app session token to
  generate, store, or rotate in v1.)
- **NF-SEC-5 — Path containment.** Confirm that no RPC input can cause the service to
  read or write outside the selected repository's directory tree (no path traversal
  via crafted file paths, ref names, or pathspecs).
- **NF-SEC-6 — Command-injection safety.** Confirm that all host-`git` invocations
  pass arguments as a discrete argument list (never a concatenated shell string), so
  branch names, paths, messages, and other user-supplied values cannot inject shell
  commands or extra git flags. Confirm `--` separators are used where Git supports
  them to prevent option injection via values that begin with `-`.
- **NF-SEC-7 — No telemetry/outbound surprises.** Confirm no telemetry or other
  outbound connections occur by default (NF-TELEM-1, NF-TELEM-4).
- **NF-SEC-8 — Dependency audit.** Confirm a dependency vulnerability audit has been
  run for the release and that known high-severity issues are resolved or documented
  with mitigation.
- **NF-SEC-9 — Secret redaction.** Confirm credentials and remote-embedded secrets
  are redacted from logs and error messages shown to the user (NF-LOG-3, NF-ERR-3).
- **NF-SEC-10 — Lock and invalidation integrity.** Confirm the per-repository
  mutation lock and the filesystem-watcher → invalidation bus are active in the
  released build (traceable to NF-TEST-9 and NF-TEST-10), so concurrent mutation or
  stale-read corruption cannot occur.
- **NF-SEC-11 — Content-type and asset safety.** Confirm static assets and any
  user-content previews are served with correct content types and are not executed in
  a way that enables script injection into the SPA.
- **NF-SEC-12 — Confirmation gates present.** Confirm destructive actions retain
  their confirmation gates (NF-ERR-7) in the released build.

### Concurrency & per-operation lock policy

- **NF-LOCK-1 — Per-repo serialization.** Every mutating method acquires the
  per-`repoId` `Effect.Semaphore(1)` for the duration of its host-`git` work
  (`14 §3.2`); reads do not take the lock. The lock is shared across all
  connections/tabs on the same `repoId`. Acquisition is interruptible (a cancelled
  caller releases its wait) and finally-guaranteed (no leak — REQ-ARCH-034).
- **NF-LOCK-2 — Acquisition policy & timeout.** The default policy is **QUEUE**
  (FIFO) with a bounded acquisition timeout of **30 s**; a wait that exceeds it
  rejects with `GitError{ code: "lockTimeout" }`, and a fail-fast method that finds
  the lock held rejects immediately with `GitError{ code: "repoLocked" }`. Policy
  per mutating method group (from `14 §7`):

  | Method group | Policy | Notes |
  |---|---|---|
  | `stage.*` / `unstage.*` / `discard.files` / `reset.to` | queue | fast; UI also reflects busy state |
  | `commit.create` | queue | hooks/signing run on host git |
  | `branch.create/checkout/rename/delete/setUpstream` | queue | checkout pre-classifies dirty tree (`14 §7`) |
  | `merge.run` | queue | |
  | `fetch.run` / `pull.run` / `push.run` | **fail-fast if an identical sync to the same remote/ref is already in flight**, else queue | avoids piling up duplicate network ops |
  | `stash.*` / `tag.*` / `worktree.*` | queue | |
  | `cherryPick/revert/sequencer.* / rebase.* / bisect.*` | queue | sequencer/rebase state is single-writer by nature |
  | `clean.run` / `gc.run` / `submodule.*` | queue | `gc` may be long; show progress |
  | `config.set/unset` | queue | |

  The chosen policy per method MUST be deterministic and documented; the UI surfaces
  `repoLocked`/`lockTimeout` as a non-destructive "operation in progress" state
  (NF-ERR-5, REQ-ARCH-082).

## Git operations

This is a non-functional section and defines cross-cutting requirements rather
than new Git workflows; the exact subcommands for each feature are specified in
their respective functional sections. The cross-cutting requirements on how Git
is invoked are:

- **NF-GIT-1 — Argument-list invocation.** Every host-`git` invocation MUST pass
  the subcommand and flags as a structured argument array (e.g.,
  `git push origin <branch>` issued as discrete arguments), never as an
  interpolated shell command line. This is verified by NF-SEC-6.
- **NF-GIT-2 — Machine-readable output.** Where cbranch parses host-`git` output,
  it MUST prefer Git's stable machine-readable forms (for example
  `git status --porcelain=v2 -z`, `git for-each-ref --format=...`,
  `git log --format=...`, `git -z`/NUL-delimited output, and explicit
  `--no-color`) so parsing does not depend on locale- or color-formatted human
  output.
- **NF-GIT-3 — Locale-stable parsing.** Invocations whose output is parsed MUST be
  made in a way that prevents the host user's locale from altering the parsed text
  (e.g., by not relying on translated human-readable messages for control flow).
- **NF-GIT-4 — Exit-status handling.** cbranch MUST treat each host-`git`
  invocation's exit status as authoritative for success/failure and map it to a
  typed error (NF-ERR-1), rather than inferring success from stdout text alone.

## UI/UX requirements

- **NF-UX-1 — Command palette presence.** A cmdk-based command palette MUST be
  available globally (NF-A11Y-6) and MUST list every primary command with a
  localized label and, where present, its keyboard shortcut.
- **NF-UX-2 — Toast feedback.** All operation outcomes MUST use sonner toasts per
  NF-ERR-2, with consistent placement and dismissal behavior, and MUST be
  announced to assistive technology (NF-A11Y-5).
- **NF-UX-3 — Confirmation dialogs.** Destructive actions MUST use a shadcn/ui
  AlertDialog naming the target and consequence (NF-ERR-7), and the dialog MUST
  follow focus-management rules (NF-A11Y-3).
- **NF-UX-4 — Progress and disabled states.** While a mutating operation runs, the
  triggering control MUST reflect a busy state and MUST prevent duplicate
  submission; this MUST be consistent with the per-repo lock (NF-ERR-5).
- **NF-UX-5 — Connection indicator.** The UI MUST show a clear connection-state
  indicator and MUST visibly degrade when the transport is disconnected
  (NF-ERR-6).
- **NF-UX-6 — Theme and locale controls.** The UI MUST provide accessible controls
  to change theme (light/dark/system) and locale, both of which persist (NF-CFG-1,
  NF-THEME-2, NF-I18N-5).
- **NF-UX-7 — Virtualized lists.** Large lists MUST use `@tanstack/react-virtual`
  to meet NF-PERF-3 while preserving keyboard navigation and correct ARIA
  semantics (NF-A11Y-4).

## Acceptance criteria

- All test suites described in NF-TEST-1 through NF-TEST-12 exist, run in CI, and
  pass; the lock test (NF-TEST-9) and cache-invalidation test (NF-TEST-10) are
  present and demonstrably fail when their guarantees are removed.
- Each performance budget (NF-PERF-1 through NF-PERF-9) has a measurement that can
  be run on demand and reports whether the budget is met on the reference setup.
- An automated accessibility pass over dialogs, forms, the command palette, and
  primary navigation reports no violations of the checked rules (NF-A11Y-10), and
  a manual keyboard-only walkthrough of P1–P3 workflows completes every primary
  action without a pointer.
- With no opt-in, a network capture during a full P1–P3 session shows zero
  telemetry/outbound connections beyond the RPC transport within the trusted
  perimeter and the host's own `git` remote traffic (NF-TELEM-1, NF-SEC-7).
- Switching theme and locale persists across a full restart of the browser and the
  host service (NF-CFG-1).
- The service rejects WebSocket upgrades and HTTP side-channel requests whose
  `Origin`/`Host` is not on the allowlist before any `GitEngine` method runs
  (NF-SEC-3), and ships with no app-level auth per the documented trust model
  (NF-SEC-2), verified by tests.
- A crafted file path / ref name cannot escape the repository directory or inject
  extra git arguments (NF-SEC-5, NF-SEC-6), verified by tests.
- The documented run instructions (loopback, or over an SSH tunnel), followed on a
  fresh host with the prerequisites installed, result in a working browser session
  (NF-PKG-3, NF-PKG-4, NF-PKG-5).
- The security review checklist (NF-SEC-1 through NF-SEC-12) is completed and
  recorded for the release (NF-REL-5).

## Edge cases & error handling

- **Stale UI after external change.** If the repository is changed outside cbranch
  (another tool or a terminal `git` command), the filesystem watcher MUST emit an
  `InvalidationEvent` and the affected queries MUST refetch so the UI reflects the
  change; the invalidation bus MUST NOT leave the UI showing stale state (ties to
  NF-TEST-10, NF-WATCH-1, NF-ERR-6).
- **Concurrent mutation attempts.** Two near-simultaneous mutating actions on the
  same repository MUST be serialized with clear feedback (NF-ERR-5); the UI MUST
  not allow a duplicate submission to corrupt state (NF-UX-4).
- **Missing or outdated host git.** If the host `git` binary is missing or below the
  minimum version, the service MUST report this clearly at startup and network-sync
  features MUST be disabled with an explanatory message rather than failing
  cryptically (NF-PKG-5).
- **Transport drop mid-operation.** If the connection drops while a mutating
  operation is in flight on the host, the host operation completes or fails on its
  own; on reconnect the UI MUST reconcile to the true repository state rather than
  assume the pre-drop optimistic state (NF-ERR-6).
- **Missing translations.** A missing locale key MUST fall back to English and MUST
  never render a raw key to the user where a fallback exists (NF-I18N-5); the
  missing-key check (NF-I18N-8) MUST flag it for translators.
- **Unavailable browser storage.** If browser storage is blocked, presentational
  preferences MUST default gracefully and the app MUST remain fully functional
  (NF-CFG-3).
- **Very large diffs/files.** Diffs and previews beyond the configured cap MUST be
  collapsed or offered behind an explicit load action rather than freezing the UI
  (NF-PERF-4, NF-PERF-8).
- **Secrets in remote URLs.** If a remote URL or git output contains an embedded
  credential, it MUST be redacted from logs and any user-facing message
  (NF-LOG-3, NF-SEC-9).
- **Theme flash on load.** The correct theme MUST apply before first paint to avoid
  a flash (NF-THEME-6).

## Out of scope

- Specific feature workflows (log/graph, staging, commit, branches, sync, stash,
  tags, cherry-pick, conflicts, blame, history, rebase, reflog, bisect, archive,
  clean, gc, submodules, settings) — these are defined in their own sections; this
  section only constrains their quality attributes.
- The detailed RPC method catalog and payload schemas — defined in the RPC
  contract section; here they are only subject to contract-testing and versioning
  requirements.
- Multi-repository simultaneous editing — cbranch operates on one repository at a
  time with a fast switcher; concurrent multi-repo workspaces are not in scope.
- App-level authentication of any kind (login, session/bearer token, multi-user
  accounts, SSO) — out of scope for v1; the model is a trusted perimeter with a
  default loopback bind plus the retained `Origin`/`Host` check (NF-SEC-2/3).
  Adding auth later is a non-breaking additive layer in front of the same RPC group.
- Hosting cbranch as a public, internet-exposed multi-tenant service — the product
  is designed for a trusted perimeter with a default loopback bind.
- Any reuse of third-party or pre-existing translation bundles — all locale
  resources are authored fresh (NF-I18N-2).
- **Git LFS** — smudge/pointer handling is not special-cased in v1; LFS-tracked
  paths MUST route reads to host git so a raw LFS pointer is not shown as file
  content.
- **sparse-checkout / partial (blobless) / shallow clone** — not supported in v1;
  `SKIP_WORKTREE` files MUST NOT be shown as deleted, and a shallow graft boundary
  is not rendered as a real root.
- **Custom/advanced refspecs and mirror / `--all` push** — only ordinary
  branch/tag push is in scope.
- **`.gitignore` / `.gitattributes` authoring** — cbranch displays ignored files
  but does not edit ignore/attribute rules.
- **git notes display/edit** — the `note` ref kind in `04` is carried but not
  rendered in v1.
- **Monorepo accelerators** (fsmonitor, sparse-index, untracked-cache) — not
  integrated; performance budgets assume the reference repo size, not million-file
  worktrees.
- **RTL / bidirectional-text layout** — not a v1 target.
- **Submodule clone-init recursion** over the tunnel — submodule listing/status is
  in scope (P5) but recursive network init is not.
- **App/service self-update** — upgrades are a manual reinstall in v1.
