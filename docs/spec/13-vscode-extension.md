# VSCode Extension (parallel track)

## Purpose

`cbranch` ships primarily as a browser-based Git GUI served by a host-side
service over an SSH tunnel. This section specifies a **second delivery surface**:
a VSCode extension that embeds the exact same product UI inside an editor
webview panel and reuses the same Git orchestration core.

The goal is **feature parity** with the web app for every implemented phase
(P1–P5, as each ships), achieved with **minimal additional code**. The same
`packages/ui` React application and the same `packages/core` `GitEngine`
orchestration run unchanged; only two things are new and extension-specific:

1. the **transport binding** (how typed RPC messages cross the boundary between
   the webview and the extension host), and
2. the **host bootstrap** (how the service is constructed and where it runs).

Target shared code: roughly **85–90%** across web and extension surfaces.
The extension contributes a thin host bootstrap plus a thin platform adapter in
the UI; everything else is imported from the existing packages.

The extension exists because users who already work inside the editor —
especially over Remote-SSH — want the same visual Git management without
opening a separate browser tab or managing a tunnel by hand. When the editor
window is attached to a remote host, the extension is expected to run its host
half **on that remote host** (in the editor's remote extension host), so the
engine operates directly against the real on-disk repository there, exactly as
the web service does.

## User stories

- As a developer working inside the editor on a remote SSH host, I want to open
  cbranch in an editor tab and manage my repository visually, without starting a
  browser or wiring a tunnel myself.
- As a developer, I want the cbranch panel to look like it belongs in my editor:
  it should follow my current editor color theme and switch instantly when I
  change themes.
- As a developer, I want to resolve a merge conflict from a cbranch file row and
  have it open the editor's own built-in 3-way merge experience, so I use one
  consistent merge surface across all my tooling.
- As a developer, I want the cbranch panel to remember what I was looking at
  (selected repository, selected revision, expanded sections, active tab) when I
  reload the editor window or reopen the panel.
- As a developer, I want to launch cbranch from the command palette and from a
  dedicated activity-bar view, and have it activate only when I actually use it
  so it does not slow down editor startup.
- As a developer, I want the same operations, keyboard interactions, and command
  palette (in-app) that I already know from the cbranch web app.

## Functional requirements

Requirements use stable identifiers of the form `REQ-VSX-NNN`. Each is testable
and describes observable behavior.

### Reuse & parity

- **REQ-VSX-001** The extension MUST render the identical `packages/ui` React
  application used by the web target. No fork of the UI tree is permitted; any
  UI behavior present in the web app for an implemented phase MUST be present and
  functional in the extension for that same phase.
- **REQ-VSX-002** The extension MUST drive its Git operations through the same
  `GitEngine` interface and the same `packages/core` orchestration used by the
  web service. No extension-specific Git logic, command construction, or output
  parsing is permitted in the extension package.
- **REQ-VSX-003** The only extension-specific code permitted is: (a) the host
  bootstrap (activation, service construction, webview creation/wiring), (b) the
  RPC **transport** binding to the webview message channel, and (c) a small
  **platform adapter** consumed by `packages/ui` for state persistence and
  environment facts. All three MUST conform to interfaces defined in
  `packages/rpc-contract` (transport) and `packages/ui` (platform adapter) so
  that the web target supplies its own conforming implementations.
- **REQ-VSX-004** The set of RPC methods, their request/response types, and their
  semantics MUST be byte-for-byte the same contract (`packages/rpc-contract`)
  used by the web target. The extension MUST NOT add, remove, or alter RPC
  methods relative to the web target for the same shipped phase.

### Webview creation & wiring

- **REQ-VSX-010** The extension MUST host the UI in a webview that has scripting
  enabled and that retains its in-memory context when hidden, so that switching
  away from and back to the cbranch tab does not reload or reset the running UI.
- **REQ-VSX-011** All static UI assets (the built `packages/ui` bundle: scripts,
  styles, fonts, images, worker files) MUST be loaded through webview-safe
  resource URIs produced by the host's `asWebviewUri` mechanism. The extension
  MUST NOT reference assets by raw filesystem paths or by `http(s)://localhost`
  URLs.
- **REQ-VSX-012** The webview's allowed local resource roots MUST be restricted
  to the directory (or directories) that contain the built UI bundle. Assets
  outside those roots MUST NOT load.
- **REQ-VSX-013** The HTML document served into the webview MUST carry a
  Content-Security-Policy that (a) sets a restrictive `default-src`, (b) permits
  scripts only when carrying a per-load cryptographic **nonce**, (c) permits
  styles from the webview resource origin (and inline styles only as required by
  the UI toolkit, ideally also nonce- or hash-gated), (d) permits images/fonts
  only from the webview resource origin and `data:` where required, and (e)
  forbids loading or connecting to arbitrary network origins.
- **REQ-VSX-014** A fresh nonce MUST be generated for every webview HTML load and
  applied to every first-party `<script>` tag. Scripts without the current nonce
  MUST NOT execute.
- **REQ-VSX-015** Because the engine runs in the extension host (not in the
  webview), the webview MUST NOT require any `connect-src` to a network host for
  normal operation; all data flows over the webview message channel, not over
  HTTP or WebSocket from inside the webview.

### Transport binding

- **REQ-VSX-020** RPC between the UI (webview side) and the service (extension
  host side) MUST be carried over the editor's webview message channel
  (`postMessage` from the webview to the host, and the host's
  `webview.postMessage` back to the webview), adapted to the transport interface
  defined in `packages/rpc-contract`.
- **REQ-VSX-021** The transport binding MUST present the **same transport
  interface** that the web target's multiplexed NDJSON WebSocket binding presents,
  binding the same `@effect/rpc` `RpcGroup` from `packages/rpc-contract`, so that
  the RPC layer and `packages/core` are unaware of which surface they run on.
  (birpc is not used; there is no second contract.)
- **REQ-VSX-022** The transport MUST support full bidirectional messaging:
  request/response calls and streaming RPCs initiated by the UI, and
  server-initiated events/pushes initiated by the host — including the
  `repo.subscribe` **invalidation bus** (`15-sync-protocol.md`) carried over the
  same postMessage channel (that channel is the single multiplexed transport, the
  analogue of the web target's one WebSocket).
- **REQ-VSX-023** Messages MUST be correlated by an id so concurrent in-flight
  calls resolve to their correct responses; out-of-order responses MUST be
  handled correctly.
- **REQ-VSX-024** The transport MUST serialize only structured-clone-safe values.
  Any non-clonable value MUST be converted to a serializable form by the contract
  layer before transmission; attempting to send a non-serializable value MUST
  produce a typed error, not a silent drop.
- **REQ-VSX-025** If the webview is disposed or reloaded, in-flight RPC calls on
  the UI side MUST reject with a typed "transport closed" error rather than hang
  indefinitely, and the host side MUST stop attempting to post to the disposed
  webview.
- **REQ-VSX-026** The host MUST reject inbound webview messages that do not match
  the expected message envelope shape before dispatching any RPC method. No
  app-level token is used on this channel — the webview message channel is
  origin-isolated and carries no network socket (REQ-VSX-061; `14 §3.6`).

### Platform adapter & state persistence

- **REQ-VSX-030** `packages/ui` MUST consume environment- and persistence-related
  capabilities exclusively through a `PlatformAdapter` interface (state
  load/save, clipboard, open-external, environment facts such as surface kind and
  whether running on a remote host) — the typed contract is **REQ-VSX-036**. The
  web target and the extension each provide a conforming implementation; the UI
  code MUST NOT branch on the surface kind except where behavior is explicitly
  specified to differ.
- **REQ-VSX-031** In the extension, the `PlatformAdapter` persistence methods MUST
  be backed by the webview state mechanism (`getState`/`setState`). State written
  via `setState` MUST be restored via `getState` after the webview is reloaded
  within the same window session.
- **REQ-VSX-032** Persisted UI state MUST follow the versioned `PersistedUiState`
  shape (**REQ-VSX-037**) and include at minimum: the selected repository, the
  selected revision/commit, the active primary tab/view, and the
  expanded/collapsed state of major panels. On reload, the UI MUST restore these
  so the user returns to substantially the same view.
- **REQ-VSX-033** Persisted UI state MUST be treated as a non-authoritative cache:
  on restore, the UI MUST reconcile against fresh data from the engine and MUST
  gracefully drop any persisted selection that no longer exists (e.g., a deleted
  branch, a repository no longer open).
- **REQ-VSX-034** Persisted state MUST NOT contain secrets (no credentials). There
  is no app-level session/bearer token on this surface (REQ-VSX-061), so none is
  stored or injected.
- **REQ-VSX-035** When the host supports cross-session retention (`retainContext`
  plus serialized state via the editor's webview serializer), the extension
  SHOULD restore the same view after a full editor restart; when it does not, the
  in-window reload behavior of REQ-VSX-031 is the minimum requirement.
- **REQ-VSX-036** `packages/ui` MUST define the `PlatformAdapter` interface (the
  surface-abstraction contract); the web target and the extension each provide one
  conforming implementation. It MUST cover at least persisted-state load/save,
  clipboard access, open-external, theme-change subscription, and surface facts:

  ```ts
  interface PlatformAdapter {
    /** Surface + environment facts the UI may branch on. */
    readonly surface: SurfaceFacts;
    /** Persisted UI state — a non-authoritative cache (see REQ-VSX-037). */
    loadState(): Promise<PersistedUiState | null>;
    saveState(state: PersistedUiState): Promise<void>;
    /** Clipboard via the host (the webview cannot assume the browser clipboard). */
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<void>;
    /** Open a URL/host path in the user's real browser/host (never window.open). */
    openExternal(target: string): Promise<void>;
    /** Subscribe to host-driven theme-token changes (REQ-VSX-042); returns unsubscribe. */
    onThemeChange(handler: (tokens: ThemeTokens) => void): () => void;
  }

  interface SurfaceFacts {
    kind: "web" | "extension";
    isRemoteHost: boolean;          // engine runs on a remote (Remote-SSH) host
    themeKind: "light" | "dark" | "highContrast";
    hasBuiltinMergeEditor: boolean; // editor's built-in 3-way merge available (REQ-VSX-050/053)
    kdiff3CompanionReachable: boolean; // client-side kdiff3 companion agent reachable (doc 11)
  }
  ```

  The UI MUST NOT branch on `surface.kind` except where behavior is explicitly
  specified to differ (e.g. merge-editor delegation, REQ-VSX-050).
- **REQ-VSX-037** The persisted UI state MUST use a versioned shape with a
  `schemaVersion` tag for migration/discard (EC-3); it is a non-authoritative
  cache (REQ-VSX-033) and MUST contain no secrets (REQ-VSX-034):

  ```ts
  interface PersistedUiState {
    schemaVersion: number;       // bump on incompatible change; mismatch → discard
    selectedRepoId?: string;
    selectedRevision?: string;   // oid or ref
    activeView?: string;         // active primary tab/view
    expanded?: Record<string, boolean>; // collapse/expand of major panels
    theme?: "light" | "dark" | "system";
    locale?: string;
  }
  ```

  In the extension this is saved/loaded via the webview state mechanism
  (`getState`/`setState`, REQ-VSX-031); the web target satisfies the same adapter
  contract over browser storage. Fields that overlap the host config store in
  `12-nonfunctional.md` (theme, locale, layout) MUST use the same names and
  semantics; the **authoritative recent-repos list remains the host config
  store's** responsibility — this state persists only the current selection and
  view, not that list.

### Theming

- **REQ-VSX-040** The UI MUST render using the editor's current color theme. The
  extension MUST map editor theme color tokens (exposed to webviews as CSS custom
  properties on the document root, e.g. `--vscode-*`) onto the design-token CSS
  variables that the shadcn/ui (`base-lyra` on Base UI) + Tailwind v4 UI consumes,
  so that backgrounds,
  foregrounds, borders, accents, and state colors track the active editor theme.
- **REQ-VSX-041** The mapping MUST cover light, dark, and high-contrast theme
  kinds. The document MUST carry the editor-provided theme-kind indicator so the
  UI can apply the correct token set, including a distinct high-contrast
  treatment.
- **REQ-VSX-042** When the user changes the editor theme while the panel is open,
  the UI MUST update to the new theme **without a reload** and without losing UI
  state. (The editor updates the injected CSS variables live; the UI MUST consume
  them via CSS variables rather than hard-coded colors so the change propagates
  automatically.)
- **REQ-VSX-043** Color contrast for text and essential UI affordances MUST remain
  legible across all three theme kinds; the UI MUST NOT hard-code colors that
  override the mapped theme tokens for primary surfaces.

### Merge editor delegation

- **REQ-VSX-050** When the user initiates conflict resolution for a conflicted
  file from within cbranch (e.g., from a conflicted-file row in the conflicts
  view), the extension MUST open that file in the **editor's built-in 3-way merge
  editor** rather than the cbranch in-app custom merge editor.
- **REQ-VSX-051** Delegation MUST be performed by invoking the editor's built-in
  merge command for the target file via the extension-host command API. The
  extension MUST resolve the file's absolute on-host path from engine data and
  pass it to that command.
- **REQ-VSX-052** After the user completes (or abandons) the merge in the editor's
  merge editor, the cbranch UI MUST reflect the file's updated conflict/staged
  status. The UI MUST re-query the engine for status (directly or via a
  repository-changed event) so the conflicts list updates without a manual
  refresh.
- **REQ-VSX-053** If the editor build does not expose a usable built-in merge
  command, the extension MUST fall back to the cbranch in-app 3-pane merge editor
  (the shared CodeMirror 6 + `@codemirror/merge` surface used by the web target) so
  conflict resolution remains possible. This fallback MUST be observable (the
  in-app editor opens) and MUST not error out.
- **REQ-VSX-054** All other diff and editing surfaces (read-only diffs, hunk
  staging, single-file editing) remain the cbranch in-app components shared with
  the web target; only the **conflict 3-way merge** is delegated to the editor.

### Activation, commands & views

- **REQ-VSX-060** The extension MUST NOT activate on editor startup. It MUST
  declare activation events tied to actual use: invoking a contributed cbranch
  command, or opening/focusing the contributed cbranch view. Until one of these
  occurs, neither the host service nor the engine may be constructed.
- **REQ-VSX-061** On first activation within a window, the host MUST construct the
  service/engine and wire the webview transport. The extension MUST NOT open any
  network socket and MUST NOT use an app-level token: the webview message
  channel's origin isolation is the trust boundary (REQ-ARCH-074; `14 §3.6`). The
  host validates the message envelope shape (REQ-VSX-026) and relies on the host
  editor's webview sandbox for isolation rather than a network credential.
- **REQ-VSX-062** The extension MUST contribute at minimum these commands to the
  command palette: **Open cbranch** (open/reveal the main panel), **Open cbranch
  for Repository…** (choose among open/known repositories, matching the web
  app's repo switcher behavior), and **Reload cbranch Panel**. Each command MUST be
  invocable from the editor command palette and MUST be a no-op-safe to call when
  already in the requested state.
- **REQ-VSX-063** The extension MUST contribute a cbranch container/view in the
  activity bar (or equivalent) that, when opened, activates the extension and
  presents an entry point to open the main panel. Opening this view MUST satisfy
  the activation event of REQ-VSX-060.
- **REQ-VSX-064** Only one main cbranch panel per window is required; invoking
  **Open cbranch** when a panel already exists MUST reveal/focus the existing
  panel rather than create a duplicate.
- **REQ-VSX-065** The extension MUST operate against the repository on the host
  where the extension host runs. When the window is attached to a remote host via
  Remote-SSH, the extension MUST run as a **workspace/remote** extension so its
  host half (service + engine) executes on the remote host against the real
  on-disk repository, never on the local UI machine.
- **REQ-VSX-066** The in-app cmdk command palette of the web UI MUST remain
  available inside the webview (it is part of `packages/ui`); it is independent of
  and additional to the editor's own command palette. Both MUST function.

## Git operations

The extension performs **no Git operations of its own** and constructs **no git
command lines**. All Git behavior — local read/index/commit/graph and network
sync (fetch/pull/push), rebase, revert, cherry-pick, worktrees, blame, submodules,
reflog, gc/maintenance, merges, and external merge-tool launches — is performed by
the shared single host-`git` `GitEngine` backend in `packages/core`, identically
to the web target (no in-process pure-JS engine; `clone` is out of scope). The
exact subcommands, flags, and parsed output are defined by the engine/core
sections of this specification and are not redefined here.

The only host-command interaction unique to this surface is **non-git**: invoking
the editor's built-in 3-way merge command to open a conflicted file
(REQ-VSX-051). That command receives a file path and performs no git invocation
on cbranch's behalf; cbranch detects the resulting on-disk changes through the
engine's status query (REQ-VSX-052).

## UI/UX requirements

- **REQ-VSX-070** The webview content is the unmodified shared UI: the revision
  list/graph, file trees, diff/merge surfaces, branch/sync/stash/tag controls,
  command palette, and virtualized large lists (`@tanstack/react-virtual`) all
  behave exactly as in the web target for the shipped phase.
- **REQ-VSX-071** Server cache (`@tanstack/react-query`, the sole feeder for
  synced data) and ephemeral UI state (Zustand) layers are reused unchanged; the
  invalidation bus (`15`) drives refetches over the postMessage channel
  (REQ-VSX-022). Only the persistence sink differs, routed through the
  `PlatformAdapter` (REQ-VSX-030–037). TanStack DB is not used.
- **REQ-VSX-072** Toasts, dialogs, context menus, and confirmation flows
  (shadcn/ui components) MUST render and function inside the webview without
  relying on browser-only APIs that the webview does not expose. Where the web
  target uses a browser capability (e.g., clipboard, open-external link), the UI
  MUST route through the `PlatformAdapter` so the extension can fulfill it via
  the extension-host API.
- **REQ-VSX-073** "Open externally" actions (e.g., opening a remote URL) MUST be
  routed through the `PlatformAdapter` to the editor's open-external mechanism,
  not via raw `window.open`, so links open in the user's real browser/host.
- **REQ-VSX-074** Keyboard interactions defined by the shared UI MUST work inside
  the webview. Where the editor reserves a chord that would otherwise be consumed
  by the UI, the UI's documented shortcut takes precedence within the focused
  webview to the extent the host permits.
- **REQ-VSX-075** Long-running operations MUST surface progress in the shared UI
  via server-initiated events over the transport (REQ-VSX-022), identically to
  the web target; the extension is not required to additionally use editor
  progress notifications, though it MAY.

## Acceptance criteria

- **AC-1** Building the extension produces a webview whose loaded document
  references all UI assets via webview resource URIs and carries a CSP with a
  per-load nonce; no first-party script lacking the nonce executes, and no asset
  outside the configured resource roots loads. (Verifies REQ-VSX-011–014.)
- **AC-2** Diffing the extension package against the web target shows the UI tree
  and the `GitEngine`/core are imported, not duplicated; the only
  surface-specific code is the host bootstrap, the transport binding, and the
  platform adapter, all implementing the shared contract interfaces. Measured
  shared code is ≥ 85%. (Verifies REQ-VSX-001–004, REQ-VSX-021, REQ-VSX-030.)
- **AC-3** With the panel open, every operation available in the web app for the
  current shipped phase is performable in the extension and produces the same
  engine result. (Verifies REQ-VSX-001, REQ-VSX-070.)
- **AC-4** Concurrent RPC calls issued from the UI resolve to correct responses,
  and a server-initiated progress/repository-changed event is received and
  applied by the UI. (Verifies REQ-VSX-022, REQ-VSX-023.)
- **AC-5** Reloading the webview within the same window restores the selected
  repository, selected revision, active tab, and panel expand/collapse state;
  a persisted selection that no longer exists is dropped without error.
  (Verifies REQ-VSX-031–033.)
- **AC-6** Changing the editor color theme while the panel is open updates the UI
  colors live, across light/dark/high-contrast kinds, without reload and without
  losing UI state. (Verifies REQ-VSX-040–043.)
- **AC-7** Triggering conflict resolution on a conflicted file opens the editor's
  built-in 3-way merge editor for that exact file; after completion the cbranch
  conflicts list updates without a manual refresh. When the built-in merge
  command is unavailable, the in-app 3-pane merge editor opens instead.
  (Verifies REQ-VSX-050–053.)
- **AC-8** The extension does not activate at editor startup; it activates only on
  invoking a cbranch command or opening the cbranch view, and only then is the
  host service/engine constructed. (Verifies REQ-VSX-060, REQ-VSX-063.)
- **AC-9** In a Remote-SSH window, the extension's host half runs on the remote
  host and operates on the remote on-disk repository. (Verifies REQ-VSX-065.)
- **AC-10** An inbound webview message not matching the expected envelope shape is
  rejected and dispatches no RPC method; the extension opens no network socket and
  uses no app-level token. (Verifies REQ-VSX-026, REQ-VSX-061.)

## Edge cases & error handling

- **EC-1** **Webview disposed mid-call.** If the user closes the panel or the
  webview reloads while RPC calls are in flight, UI-side promises reject with a
  typed "transport closed" error and the host stops posting to the disposed
  webview (REQ-VSX-025). No unhandled rejection or hang is permitted.
- **EC-2** **Panel hidden then shown.** Hiding and re-showing the panel MUST NOT
  reload the UI or reset transport/state (REQ-VSX-010); in-flight and subsequent
  calls continue to function.
- **EC-3** **Corrupt or stale persisted state.** If `getState` returns
  malformed, version-incompatible, or stale state, the UI MUST discard it and
  start from defaults rather than crash (REQ-VSX-033). A schema/version tag
  SHOULD be stored so incompatible state is detected and dropped.
- **EC-4** **Theme tokens missing.** If an expected editor theme variable is
  absent for the active theme kind, the UI MUST fall back to a defined default
  token value so no element renders with an unreadable or transparent color
  (REQ-VSX-041, REQ-VSX-043).
- **EC-5** **Built-in merge command absent or fails.** If invoking the editor
  merge command throws or the command id is not registered, the extension MUST
  catch the failure and open the in-app 3-pane merge editor fallback, surfacing a
  non-blocking notice in the UI (REQ-VSX-053).
- **EC-6** **Conflict resolved outside cbranch.** If the user resolves or alters
  conflicts via the editor merge editor or any other tool, the cbranch UI MUST
  reconcile on the next status query or repository-changed event and reflect the
  current state (REQ-VSX-052).
- **EC-7** **Malformed envelope.** Webview messages that do not match the expected
  envelope shape MUST be rejected by the host without executing any RPC method; if
  the channel is lost or the webview is reloaded, the UI SHOULD surface a
  recoverable error prompting a panel reload (REQ-VSX-026, REQ-VSX-025).
- **EC-8** **Non-serializable payload.** Attempting to transmit a value that is
  not structured-clone-safe MUST yield a typed contract error at the boundary,
  not a silent message drop (REQ-VSX-024).
- **EC-9** **Repository disappears.** If the active repository is removed/closed
  while the panel is open, the UI MUST drop the selection (REQ-VSX-033) and
  present the repo switcher / open-repository entry point rather than render
  against missing data.
- **EC-10** **Local (non-remote) window.** When the window is not attached to a
  remote host, the extension host half runs locally and operates on the local
  repository; behavior is otherwise identical (REQ-VSX-065).

## Out of scope

- Any change to the Git engine, RPC contract, or UI behavior that is not equally
  present in the web target for the same phase. The extension is a delivery
  surface, not a feature fork.
- A second/alternative UI, a native (non-webview) tree-based reimplementation of
  cbranch views, or editor-specific visual redesigns.
- A bespoke conflict merge editor for the extension surface beyond delegating to
  the editor's built-in merge editor (with the shared in-app editor only as
  fallback).
- Marketplace packaging, publishing, signing, update channels, and telemetry
  policy (covered by release/operations specifications, not this section).
- Multi-window orchestration beyond one main panel per window, and any
  cross-window shared session state.
- Replacing or duplicating the editor's own SCM provider; cbranch is a standalone
  visual surface, not an SCM-provider contribution.
