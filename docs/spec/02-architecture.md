# System Architecture

## Purpose

This section defines the internal structure of `cbranch`: how the monorepo is
partitioned, the single Git abstraction (`GitEngine`) that every feature is
built on, the host-`git` execution backend (with a batch-process pool for fast
reads), how concurrent mutations are serialized, how live state is propagated,
the typed RPC transport that connects the browser view to the service, and the
trust model that keeps the service reachable only by the intended developer.

`cbranch` is a single-repository Git GUI. The service component runs **on the
host** (the same machine that holds the working tree and `.git` directory) and
operates against the **real on-disk repository** through the host filesystem and
the host `git` binary. The browser (or VSCode webview) is a pure presentation
layer that holds no Git logic and reaches the service exclusively over a typed
RPC transport. The authoritative wire contract is
[`14-rpc-contract.md`](14-rpc-contract.md); the live-data design is
[`15-sync-protocol.md`](15-sync-protocol.md). This section reconciles to both and
does not re-define their content.

```
┌─────────────────────────────┐         ┌──────────────────────────────────────┐
│ Browser / VSCode webview     │  RPC    │ Host (Linux / macOS / Windows)         │
│ packages/ui (React 19)       │ (one    │ apps/web-server (Effect platform HTTP) │
│  - views, no Git logic       │ multi-  │   ↳ packages/core                      │
│  - React Query + Zustand     │ plexed  │       ↳ GitEngine                      │
│  - invalidation bus client   │ NDJSON  │           └─ host `git` (child_process)│
│                              │◄──WS───►│              + cat-file --batch pool   │
│                              │  (over  │   ↳ fs watcher → invalidation bus      │
│                              │ trusted │   ↳ real .git on host fs               │
└─────────────────────────────┘ perim.) └──────────────────────────────────────┘
```

## User stories

- As a developer connected to a host (locally, over SSH, or over a VPN/Tailscale
  perimeter), I want the service to run next to my repository so that all Git work
  happens against the real working tree with real remote credentials, not a copy.
- As a developer, I want a single, well-typed Git abstraction so that every
  feature consumes the same contract, and the engine's invocation details stay
  invisible to callers.
- As a developer pushing or pulling over SSH remotes, I want network sync to use
  my host's own `git` and SSH configuration so authentication, host keys, and
  credential helpers work exactly as they do on my command line.
- As a developer, I want long-running operations (fetch, push, rebase) to stream
  progress and be cancellable so the UI stays responsive and I can abort a runaway
  operation.
- As a developer, I want concurrent actions against one repository to be
  serialized so two mutations can never corrupt the index or refs.
- As a developer, I want the UI to reflect changes I make in a terminal without a
  manual refresh, so cbranch and my shell never disagree about repository state.

## Functional requirements

### Monorepo & package boundaries

- **REQ-ARCH-001** The product MUST be organized as a single repository managed
  with pnpm workspaces, containing at minimum these packages: `packages/core`,
  `packages/rpc-contract`, `packages/ui`, `apps/web-server`, and (later)
  `apps/vscode-ext`.
- **REQ-ARCH-002** `packages/core` MUST contain all Git orchestration logic and
  MUST be transport-agnostic: it MUST NOT import any HTTP, WebSocket, or webview
  symbols, and MUST be unit-testable against a temporary on-disk repository with
  no network or browser present.
- **REQ-ARCH-003** `packages/rpc-contract` MUST define the typed RPC surface
  (the `@effect/rpc` `RpcGroup` method catalog, request/response payload Schemas,
  streaming event types, and the canonical error union) plus the transport
  binding, and MUST NOT depend on `packages/ui` or on any concrete transport
  implementation. All `effect/unstable/*` imports MUST be quarantined behind one
  adapter module (`14 §1`).
- **REQ-ARCH-004** `packages/ui` MUST contain only presentation and client-side
  state. It MUST NOT contain Git logic and MUST reach the service only through
  the RPC contract types from `packages/rpc-contract`.
- **REQ-ARCH-005** `apps/web-server` MUST be the host-side process that
  instantiates `packages/core`, binds the WebSocket+HTTP transport (Effect
  platform layers), and enforces the trust model. It MUST be the only package that
  opens a listening socket.
- **REQ-ARCH-006** `apps/vscode-ext` MUST reuse the same `packages/core` and
  `packages/rpc-contract` and MUST provide only a different transport binding
  (`webview.postMessage`). No Git logic may be duplicated in the extension.
- **REQ-ARCH-007** Dependency direction MUST be acyclic: `ui` → `rpc-contract`;
  `web-server`/`vscode-ext` → `core` + `rpc-contract`; `core` → `rpc-contract`
  (types only). A build or lint check MUST fail if a forbidden edge is
  introduced (e.g. `core` importing `ui`).

### The GitEngine interface

- **REQ-ARCH-010** The product MUST expose a single `GitEngine` interface that
  is the sole entry point for all Git behavior. All RPC handlers MUST call
  through `GitEngine` and MUST NOT invoke Git directly.
- **REQ-ARCH-011** Every `GitEngine` method that performs work MUST accept a
  cancellation signal (modeled as Effect interruption / an `AbortSignal` at the
  boundary) and MUST stop work and reject promptly when interrupted.
- **REQ-ARCH-012** Every `GitEngine` method that can produce incremental output
  (history, status, fetch, push, rebase) MUST support reporting progress events
  to the caller without buffering the entire result in memory (Effect `Stream`
  with ack-based backpressure — `14 §3.4`).
- **REQ-ARCH-013** `GitEngine` methods MUST be grouped and named by capability
  area: history/read, working-tree/status, staging, commit, refs/branches/tags,
  sync, stash, worktrees, and advanced. The interface MUST be stable enough that
  internal invocation choices (e.g. routing reads through the `cat-file --batch`
  pool) are invisible to callers.
- **REQ-ARCH-014** `GitEngine` methods MUST report failures as the typed,
  structured **`GitError`** union defined canonically in `14 §4` (a single tagged
  union — there is no separate `EngineError`), so the UI can distinguish, for
  example, a merge conflict from an auth failure from a "not a Git repository"
  condition without parsing free-text English.

An original interface sketch we are designing (illustrative; final names may be
refined during implementation). Cancellation + progress are threaded through every
operation; the **result and error types are the Effect Schemas in `14 §5`/`§4`**
(`GitError`, the discriminated success outcomes such as `MergeOutcome` /
`PushOutcome` / `SequencerOutcome`) — the simplified `Result`/`OpContext` shown
here is for grouping illustration only:

```ts
/** Cancellation + coarse progress, provided by the server runtime (14 §3.1). */
interface OpContext {
  signal: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
}

interface ProgressEvent { phase: string; current?: number; total?: number; message?: string }

interface GitEngine {
  // ── history / read ───────────────────────────────────────────────
  log(opts: LogQuery, ctx: OpContext): AsyncIterable<CommitSummary>;   // streaming (14 §6)
  getCommit(id: string, ctx: OpContext): Promise<CommitDetail>;
  graph(opts: GraphQuery, ctx: OpContext): Promise<GraphData>;        // topology for the renderer
  diff(spec: DiffSpec, ctx: OpContext): Promise<FileDiff[]>;
  blame(path: string, rev: string | null, ctx: OpContext): Promise<BlameResult>;
  fileHistory(path: string, ctx: OpContext): AsyncIterable<CommitSummary>;
  readBlob(rev: string, path: string, ctx: OpContext): Promise<Uint8Array>;

  // ── working tree / status ────────────────────────────────────────
  status(ctx: OpContext): Promise<WorkingTreeStatus>;
  listTree(rev: string, dir: string, ctx: OpContext): Promise<TreeEntry[]>;
  clean(opts: CleanOptions, ctx: OpContext): Promise<string[]>;

  // ── staging ──────────────────────────────────────────────────────
  stage(paths: string[], ctx: OpContext): Promise<void>;
  unstage(paths: string[], ctx: OpContext): Promise<void>;
  applyHunks(patch: PatchSpec, ctx: OpContext): Promise<void>;        // hunk/line staging (14 §7)
  discard(paths: string[], ctx: OpContext): Promise<void>;

  // ── commit ───────────────────────────────────────────────────────
  commit(input: CommitInput, ctx: OpContext): Promise<CommitSummary>;
  amend(input: AmendInput, ctx: OpContext): Promise<CommitSummary>;

  // ── refs / branches / tags ───────────────────────────────────────
  listRefs(ctx: OpContext): Promise<RefSet>;
  createBranch(name: string, startPoint: string, ctx: OpContext): Promise<void>;
  checkout(target: CheckoutTarget, ctx: OpContext): Promise<void>;
  renameBranch(from: string, to: string, ctx: OpContext): Promise<void>;
  deleteBranch(name: string, force: boolean, ctx: OpContext): Promise<void>;
  createTag(input: TagInput, ctx: OpContext): Promise<void>;
  deleteTag(name: string, ctx: OpContext): Promise<void>;
  merge(input: MergeInput, ctx: OpContext): Promise<MergeOutcome>;
  reset(input: ResetInput, ctx: OpContext): Promise<void>;

  // ── sync (network; host git over ssh) ────────────────────────────
  fetch(input: FetchInput, ctx: OpContext): Promise<FetchOutcome>;
  pull(input: PullInput, ctx: OpContext): Promise<PullOutcome>;
  push(input: PushInput, ctx: OpContext): Promise<PushOutcome>;
  listRemotes(ctx: OpContext): Promise<Remote[]>;
  // NOTE: clone is out of scope — repositories are opened by existing on-disk path.

  // ── stash ────────────────────────────────────────────────────────
  stashSave(input: StashInput, ctx: OpContext): Promise<void>;
  stashList(ctx: OpContext): Promise<StashEntry[]>;
  stashApply(ref: string, drop: boolean, ctx: OpContext): Promise<void>;
  stashDrop(ref: string, ctx: OpContext): Promise<void>;

  // ── worktrees ────────────────────────────────────────────────────
  listWorktrees(ctx: OpContext): Promise<Worktree[]>;
  addWorktree(input: WorktreeInput, ctx: OpContext): Promise<void>;
  removeWorktree(path: string, force: boolean, ctx: OpContext): Promise<void>;

  // ── advanced ─────────────────────────────────────────────────────
  cherryPick(input: CherryPickInput, ctx: OpContext): Promise<SequencerState>;
  revert(input: RevertInput, ctx: OpContext): Promise<SequencerState>;
  rebase(input: RebaseInput, ctx: OpContext): Promise<SequencerState>;  // sequence-editor shim (14 §7)
  reflog(ref: string, ctx: OpContext): Promise<ReflogEntry[]>;
  bisect(input: BisectInput, ctx: OpContext): Promise<BisectState>;
  submodules(ctx: OpContext): Promise<Submodule[]>;
  archive(input: ArchiveInput, ctx: OpContext): Promise<void>;          // output via HTTP side-channel (14 §3.7)
  runMaintenance(input: MaintenanceInput, ctx: OpContext): Promise<void>; // gc, etc.
}
```

### Execution backend (host-git only)

- **REQ-ARCH-020** The `GitEngine` MUST be implemented with a **single backend**
  that invokes the host's `git` executable via the system's child-process
  facility. There is **no in-process pure-JS backend** (isomorphic-git is not
  used); consequently there is no dual-backend divergence or cross-backend cache
  invalidation to manage. Hot read paths are served by a per-repository
  long-lived **`git cat-file --batch` / `--batch-check` process pool** (object
  reads without per-call process spawn) and by passing **`--no-optional-locks`** on
  read operations.
- **REQ-ARCH-021** **All** operation classes use the host-git backend: local
  read/index/commit/graph operations as well as network sync (`fetch`, `pull`,
  `push`), rebase (including interactive, via a non-interactive sequence-editor
  shim), revert, cherry-pick, worktree management, blame, submodule operations,
  reflog, maintenance/gc, archive, clean, merges, and launching external merge
  tools. Each spawn runs with the active repository as its working directory and
  sets `GIT_TERMINAL_PROMPT=0` plus a fail-fast askpass / `ssh -o BatchMode=yes`
  so git never blocks on a prompt (`14 §3.3`).
- **REQ-ARCH-022** Network sync MUST use host-git because real remotes are
  typically reached over SSH (and via the user's existing host keys, agent,
  config, and credential helpers). The product MUST NOT attempt in-process SSH
  transport, and MUST NOT hold remote credentials itself — remote auth is the
  host's responsibility (`14 §3.6`).
- **REQ-ARCH-025** The engine MUST verify the presence and a minimum acceptable
  version of the host `git` binary at startup and MUST surface a clear, typed
  error (`hostGitMissing` / `hostGitTooOld`) if it is missing or too old. The
  minimum version and per-flag fallbacks are pinned in `12-nonfunctional.md`.

### Concurrency: locking & live state

- **REQ-ARCH-030** The engine MUST serialize mutating operations **per
  repository** using a lock (an `Effect.Semaphore(1)` keyed by `repoId`) so that
  at most one mutation executes at a time against a given repository. The lock is
  shared across all connections/tabs touching the same `repoId` (`14 §3.2`).
- **REQ-ARCH-031** A request for the lock while it is held MUST either queue
  (preserving submission order) or fail fast with a `repoLocked` error; the chosen
  behavior MUST be deterministic and documented per operation (the per-operation
  policy table lives in `12-nonfunctional.md`). Read-only operations MUST NOT be
  blocked by the mutation lock except where a read would observe a half-applied
  mutation.
- **REQ-ARCH-032** Live state MUST be propagated by the **filesystem watcher →
  invalidation bus** (`15`): after any mutation (by cbranch or by an external
  terminal), the per-`repoId` watcher detects the on-disk change and the server
  pushes an `InvalidationEvent` over `repo.subscribe`, and the client refetches
  the affected queries. The engine holds no stale in-process object cache, because
  object reads are content-addressed and the `cat-file --batch` pool only serves
  immutable objects; ref/index/status freshness is driven by the watcher, not by a
  cross-backend cache.
- **REQ-ARCH-033** Lock acquisition MUST respect cancellation: a cancelled queued
  request MUST be removed from the queue and MUST NOT acquire the lock.
- **REQ-ARCH-034** The engine MUST guarantee no permanent lock leak: a lock held
  by an operation MUST be released on success, failure, or cancellation
  (Effect `acquireRelease` / `ensuring`).

### Service placement & filesystem

- **REQ-ARCH-040** The service MUST run on the host that owns the repository and
  MUST operate against the real on-disk `.git` directory and working tree via the
  host filesystem. It MUST NOT use a browser-side virtual filesystem for
  repository data.
- **REQ-ARCH-041** The service MUST operate on exactly one active repository per
  connection and MUST provide a fast mechanism to switch the active repository (a
  repo switcher) without restarting the process. `repoId` is derived from the
  repository's common git dir so sibling worktrees map to one `repoId` (`14 §3.5`).
- **REQ-ARCH-042** On switching or closing the active repository, the engine MUST
  re-scope the per-repository lock and MUST tear down the per-repo watcher /
  `repo.subscribe` subscription when the last subscriber for that `repoId`
  disconnects.

### Typed RPC transport

- **REQ-ARCH-050** Communication between the view and the service MUST use the
  typed RPC layer defined once in `packages/rpc-contract` (`@effect/rpc` `RpcGroup`
  + Effect Schema), providing request/response calls, server-to-client streaming
  events, and cancellation. The authoritative binding is `14 §2`.
- **REQ-ARCH-051** The RPC layer MUST be transport-abstracted: the same `RpcGroup`
  catalog MUST run over (a) one multiplexed NDJSON WebSocket for the web server and
  (b) `webview.postMessage` for the VSCode extension, selected by a transport
  binding without changing call sites.
- **REQ-ARCH-052** Every RPC method that maps to a streaming or long-running
  `GitEngine` operation MUST deliver incremental progress events to the client as
  an Effect `Stream` and MUST expose cancellation: interrupting the consuming
  fiber sends an `Interrupt{ requestId }` that aborts the underlying `GitEngine`
  operation and kills the spawned `git` process (via `acquireRelease`) — `14 §3.4`.
- **REQ-ARCH-053** RPC errors MUST carry the structured `GitError` shape (tag +
  payload), not just a string, so the UI can branch on error type (`14 §4`).
- **REQ-ARCH-054** The RPC contract MUST be the single source of truth for payload
  types shared by client and server; both sides MUST consume the same Effect
  Schemas so a contract change produces a compile-time error on whichever side is
  out of date.
- **REQ-ARCH-055** Large outputs (full history, large diffs, fetch progress) MUST
  be streamed in chunks with ack-based backpressure rather than returned as one
  buffered payload, so a slow client cannot force unbounded buffering on the
  server. Large/binary blobs and archives MUST use the streamed HTTP download
  side-channel rather than the RPC channel (`14 §3.7`).

### Process lifecycle (host-git child processes)

- **REQ-ARCH-060** Each host-git invocation MUST be spawned with explicit
  argument arrays (never a shell-interpolated command string) to avoid shell
  injection, MUST use `--` separators where Git supports them to prevent option
  injection, and MUST run with the active repository as its working directory.
- **REQ-ARCH-061** A host-git process MUST be terminable: cancelling the owning
  RPC call MUST kill the child process and reap it so no orphan/zombie process
  remains (resource-safe via `acquireRelease`).
- **REQ-ARCH-062** The service MUST consume the child process's stdout and stderr
  streams incrementally and apply backpressure, so that a command emitting a very
  large amount of output cannot exhaust service memory.
- **REQ-ARCH-063** The service MUST capture exit code, signal, stdout, and stderr
  and map non-zero exits to the appropriate `GitError` code deterministically
  (exit-code + known sentinel matching, never localized message parsing —
  distinguishing auth failure, non-fast-forward, and conflict outcomes; `14 §4`).
- **REQ-ARCH-064** On service shutdown, all in-flight child processes MUST be
  terminated and reaped.

### Trust model (auth descoped for v1)

- **REQ-ARCH-070** The web server MUST bind to a configurable interface,
  **defaulting to loopback (`127.0.0.1`)**, and MUST NOT be exposed to the public
  internet. cbranch assumes **private deployment behind a trusted perimeter**
  (LAN / VPN / Tailscale, or a loopback-over-SSH tunnel). Binding to any non-loopback
  interface MUST require an explicit, documented configuration change and MUST emit
  a startup warning (`12-nonfunctional.md`).
- **REQ-ARCH-071** There is **no app-level authentication, login, or session
  token** in v1 (auth is descoped — `14 §3.6`). Remote *Git* authentication is
  handled out-of-band at the host (`ssh-agent` / `credential.helper` / `gh`);
  cbranch never holds remote credentials. Adding app-level auth later is a
  non-breaking additive change in front of the same `RpcGroup`.
- **REQ-ARCH-072** Even with auth descoped, the server MUST validate the
  `Origin`/`Host` header on the WebSocket upgrade (and on the HTTP side-channel)
  against a strict allowlist and MUST reject mismatches — a cheap, orthogonal
  control that defends against cross-site/DNS-rebinding access to the loopback
  service from a page in the user's browser.
- **REQ-ARCH-074** The VSCode binding MUST rely on the webview message channel's
  origin isolation, MUST NOT open any network socket, and MUST NOT require a
  network token.

## Git operations

This is a design/architecture section; it specifies *how* operations are
dispatched, not the concrete flag set of any one command (those are defined in
the feature-specific sections). At the architecture level:

- All Git operations — local reads, index/commit/graph, network sync, rebase,
  revert, cherry-pick, worktrees, blame, submodules, reflog, maintenance/gc,
  archive, clean, merges, and external merge-tool launches — are dispatched to the
  **host `git` binary** as child processes with explicit argument arrays, with
  stdout/stderr streamed and parsed into structured results and progress events.
- Hot read paths are accelerated by the per-repo `git cat-file --batch` pool and
  `--no-optional-locks`, without changing the `GitEngine` interface.
- The specific subcommands, flags, and parsed output formats for each capability
  are defined in their respective feature sections; this section guarantees only
  the dispatch policy, cancellation, backpressure, and error-mapping behavior
  around them.

## UI/UX requirements

- **REQ-ARCH-080** The UI MUST consume the RPC contract via a server-cache layer
  (React Query, the sole feeder for synced data) for reads, a separate UI-state
  store (Zustand) for ephemeral view state, and the invalidation-bus client (`15`)
  for liveness; Git results MUST NOT be re-implemented client-side.
- **REQ-ARCH-081** Long-running operations MUST surface their streamed progress in
  the UI (a progress indicator with the current phase/message) and MUST offer a
  cancel affordance that interrupts the consuming fiber (RPC cancellation).
- **REQ-ARCH-082** When the engine reports `repoLocked`, the UI MUST present a
  clear, non-destructive "operation in progress" state rather than silently
  dropping the user's action.
- **REQ-ARCH-083** Large lists fed by streamed engine output (history, status)
  MUST be rendered with list virtualization so the view stays responsive on
  repositories with very large histories.
- **REQ-ARCH-084** Structured `GitError` codes MUST drive distinct, actionable
  UI messaging (e.g. an auth failure prompts a credentials/SSH hint, a
  non-fast-forward push offers fetch/rebase guidance) rather than echoing raw
  command stderr by default.

## Acceptance criteria

- A feature can be implemented end-to-end by calling only `GitEngine` methods
  and RPC-contract types, with no direct Git access outside `packages/core`.
- Routing an object read through the `cat-file --batch` pool produces the same
  observable result as a direct `git` invocation, with no client or contract
  change.
- Triggering cancellation on a streaming operation (e.g. fetch) stops progress
  events, rejects the call with `cancelled`, and leaves no surviving child
  process.
- Submitting two mutations concurrently against one repository results in
  serialized execution (or a deterministic `repoLocked` rejection), never an
  interleaved/corrupt outcome.
- After a mutation (by cbranch or by an external terminal), the filesystem watcher
  emits an `InvalidationEvent` and a subsequent read reflects the change (no stale
  UI).
- The server binds loopback by default; a WebSocket upgrade with an `Origin`/`Host`
  not on the allowlist is rejected before any `GitEngine` method executes; the
  server is not reachable on a non-loopback interface without explicit opt-in.
- A dependency-direction check fails the build if `core` imports `ui`, or if any
  package opens a listening socket except `apps/web-server`.

## Edge cases & error handling

- **Host `git` missing or too old:** startup surfaces a clear typed error
  (`hostGitMissing` / `hostGitTooOld`); operations fail with a typed error rather
  than a crash.
- **Repository disappears or `.git` becomes inaccessible mid-session** (e.g.
  switched/unmounted): operations MUST fail with `notARepository`/`repoUnavailable`
  instead of hanging; the watcher tear-down MUST not leak.
- **Cancellation after a child process already committed an effect** (e.g. a push
  the remote already accepted): the engine MUST still terminate the process and
  report the most accurate outcome it can; it MUST NOT claim a clean rollback that
  did not happen.
- **Lock holder crashes:** the lock MUST be released (finally-guaranteed) so the
  repository does not become permanently unusable for mutations.
- **Backpressure / huge output:** a command producing very large output MUST not
  OOM the service; chunks are streamed and consumed with flow control.
- **WebSocket upgrade from an unexpected origin:** rejected at upgrade time
  (REQ-ARCH-072).
- **Connection loss:** on reconnect the client re-establishes `repo.subscribe`
  and invalidates every query for the repo (full resnapshot via refetch — `15 §5`),
  rather than trusting stale cached data.

## Out of scope

- Multi-repository simultaneous operation (the service handles one active
  repository per connection; only fast switching is in scope).
- An in-process (pure-JS) Git engine and any in-process / pure-JS SSH transport —
  not used; all Git goes through the host binary.
- `git clone` and repository creation — repositories are opened by existing
  on-disk path.
- App-level authentication / login / session tokens, and exposing the service on a
  public/routable address — the model is a trusted perimeter with a default
  loopback bind plus the Origin/Host check (REQ-ARCH-070..072).
- Concrete per-command flag sets and parsing formats, which are specified in the
  individual feature sections.
- Visual/branding design specifics (covered by UI/design sections); this section
  constrains only functional UI behavior.
