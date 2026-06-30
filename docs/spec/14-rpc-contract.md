# RPC Contract (`@effect/rpc` + Effect Schema)

> **Status:** authoritative wire contract for cbranch. Closes audit blocker **#1** (contract was
> not enumerated), **#2** (history loading model), and the **#3** error-model duplication (this file
> defines the single canonical error union). Reflects the locked stack: **host-git-only** backend,
> **Effect v4 + `@effect/rpc`** (replaces birpc), **TanStack Query + a thin WS invalidation bus** for
> live client data (see [`15-sync-protocol.md`](15-sync-protocol.md)), **Zustand** for ephemeral UI.
> **Auth is out of scope** (private deployment behind a
> trusted perimeter — see §3.6) and **`clone` is out of scope** (the user clones via ssh and points the
> app at an on-disk path; the entry point is `repo.open`).
>
> **Reconciliation note for the spec author:** `04-domain-model.md` describes result types
> informally; the Effect Schemas defined here are the authoritative wire types. Merge `04`'s
> descriptions into these Schemas (do not keep two definitions), and link this file from `00-README.md`.

---

## 1. Pinned versions

Pin exact, no `^`; bump deliberately with an API re-validation step (decision: track latest, but the
pre-stable pillars get explicit pins):

| Package | Pin | Track |
|---|---|---|
| `effect` | `4.0.0-beta.92` | beta — RPC lives in `effect/unstable/rpc` (breaking changes allowed in minors) |
| `@tanstack/react-query` | `^5` | stable — floats (track latest) |

`effect/Schema` is on the **stable** semver track; `effect/unstable/*` (rpc, socket, http) is **not**.
**Quarantine every `effect/unstable/*` import behind a single adapter module** (`packages/rpc-contract/src/effect-rpc-adapter.ts`) so a rename touches one file. Lean on `Schema` + the
`RpcGroup`/method catalog as the transport-agnostic source of truth.

> **v4 is a committed choice — do NOT downgrade to Effect v3** to de-risk the beta. v3's split
> `@effect/*` packages and pre-rewrite APIs do not fit this architecture; the early-stage risk is
> accepted and absorbed through this adapter (re-validate `⚠` symbols on bump), not by retreating to v3.

> All `effect/unstable/rpc` API in this doc is validated against `4.0.0-beta.92`. On any bump, re-verify
> the symbols marked ⚠ below against the pinned source before relying on them.

---

## 2. Binding architecture

- **Contract package** `packages/rpc-contract` defines one `RpcGroup` (the method catalog) plus all
  payload/success/error Schemas. Imported unchanged by both server (`apps/web-server`) and client
  (`packages/ui`). This *is* the "single contract" guarantee.
- **Transport: one WebSocket per connection, NDJSON-framed, multiplexed.** A single socket carries all
  concurrent unary calls *and* streams, correlated by a branded `RequestId`; the server namespaces
  per connection by `clientId`. There is no second channel — live data push (see `15`) is just a
  long-lived streaming RPC over this same socket.
  - Server: `RpcServer.layerProtocolWebsocket({ path: "/rpc" })` + `RpcSerialization.layerNdjson` +
    the platform HTTP server/router layers. ⚠ confirm `layerProtocolWebsocket`.
  - Client: `RpcClient.layerProtocolSocket()` + `Socket.layerWebSocket(url)` +
    `Socket.layerWebSocketConstructorGlobal` + `RpcSerialization.layerNdjson` (all from
    `effect/unstable/socket` + `effect/unstable/rpc`). ⚠ there is **no** client `layerProtocolWebsocket`;
    use `layerProtocolSocket`.
- **Server runtime:** assemble one `Layer` and launch once at process root —
  `Effect.runFork(Layer.launch(MainLive))`. Do **not** run an Effect per request; the server layer
  drives a fiber per request internally.
- **Client runtime:** hold exactly **one** `ManagedRuntime.make(AppLayer)` for the app (never
  per-render). Call `.runPromise(effect, { signal })` / `.runFork(...)` at call sites and `.dispose()`
  on teardown. Pass an `AbortController.signal` (or keep the `runFork` fiber and `Fiber.interrupt` it)
  to cancel on unmount. `@effect-atom/atom-react` is an acceptable optional helper for unmount-driven
  interruption.

```ts
// packages/rpc-contract/src/group.ts
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc" // ⚠ unstable — via the adapter module

export const GitRpcs = RpcGroup.make(
  Rpc.make("RepoOpen",      { payload: { path: Schema.String }, success: RepoHandle, error: OpenError }),
  Rpc.make("RepoSubscribe", { payload: { repoId: RepoId },      success: InvalidationEvent, error: GitError, stream: true }),
  Rpc.make("LogStream",     { payload: LogQuery,                success: CommitSummary,   error: GitError, stream: true }),
  Rpc.make("CommitCreate",  { payload: CommitInput,             success: CommitCreated,   error: GitError }),
  // … full catalog in §7
)
```

---

## 3. Cross-cutting conventions (apply to every method)

### 3.1 `OpContext` and identity
Every method carries an implicit `OpContext` (provided by the server runtime, not in the payload):
the resolved `repoId`, a server-generated `opId`, and the interrupt signal. **Every payload that
targets a repository includes `repoId`** (see §3.5 for why state is per-connection but the lock is
per-repo).

### 3.2 Mutations are serialized per repository
Every **mutating** method acquires a per-`repoId` `Effect.Semaphore(1)` (`withPermits(1)`) for the
duration of the host-git invocation. Reads do not take the lock. The lock is **shared across all
connections/tabs** touching the same `repoId`. Acquisition is itself interruptible (a cancelled
caller releases its wait). The **per-operation policy table** (queue vs fail-fast, and the
acquisition timeout that surfaces as `GitError{ code: "repoLocked" }`) MUST be authored in
`12-nonfunctional.md`; default is **queue** with a bounded timeout.

### 3.3 Non-interactive git (host-git-only)
Every spawn sets `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, and an
askpass that fails fast — git must never block on a prompt. Credential/ssh material is provided
out-of-band at the host (§3.6). Reads use `--no-optional-locks`. Object reads go through a per-repo
long-lived `git cat-file --batch`/`--batch-check` **process pool** (this is the performance story
that replaced an in-process engine; see `02-architecture.md`).

### 3.4 Cancellation & backpressure (native)
Unary call → `Effect`; streaming call → `Stream`. Streaming uses **ack-based backpressure**: the
server emits a chunk and awaits the client `Ack` before the next. **Cancelling/unsubscribing =
interrupting the consuming fiber**, which sends an `Interrupt{ requestId }`; the server interrupts
the in-flight request fiber (and kills the spawned `git` process via `acquireRelease`). A dropped
connection interrupts all that client's fibers.

### 3.5 `repoId` derivation
`repoId` = a stable hash of the repository's **common git directory** (`git rev-parse --git-common-dir`,
resolved absolute), so that **sibling worktrees of the same repository share one `repoId`** (and thus
one mutation lock and one set of synced collections). The recent-repos list is keyed by the resolved
top-level working path (a repo may be opened at multiple worktree paths that map to one `repoId`).

### 3.6 Trust model (auth descoped for v1)
cbranch assumes **private deployment behind a trusted perimeter** (LAN / VPN / Tailscale). There is
**no app-level authentication, login, or session token** in v1. The service MUST bind to the
perimeter interface (configurable; default loopback) and MUST NOT be exposed to the public internet —
state this prominently in the run docs. Git **remote** authentication (e.g. GitHub over ssh/https) is
handled **out-of-band at the host** via the user's existing `ssh-agent` / `credential.helper` /
`gh` setup; cbranch never holds remote credentials. Adding app-level auth later is a non-breaking
additive change (a future `Authorization`/handshake layer in front of the same `RpcGroup`).

### 3.7 Large / binary payloads
Do **not** send archives or large blobs as base64 over the RPC channel. Expose a separate
**streamed HTTP download endpoint** (same server, same perimeter) for `archive.export` output and
`file.contentAtRev` above a configurable size cap. RPC methods return a short-lived **download
descriptor** (path + token-free, perimeter-protected URL), not bytes.

---

## 4. Canonical error model (closes #3)

One tagged-error union, defined with `Schema.TaggedErrorClass` (⚠ v4 name — **not** `Schema.TaggedError`).
Delete the `EngineError`-vs-`GitError` duplication elsewhere; this is the single source.

```ts
import { Schema } from "effect"

export class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  code: GitErrorCode,                 // closed string union, below
  message: Schema.String,
  detail: Schema.optional(Schema.Unknown),  // typed per-code where useful (see variants)
}) {}

export const GitErrorCode = Schema.Literals([
  // process / environment
  "hostGitMissing", "hostGitTooOld", "gitFailed", "fsError", "permissionDenied", "repoUnavailable",
  // concurrency / lifecycle
  "repoLocked", "lockTimeout", "cancelled",
  // domain
  "repoNotFound", "notARepository", "dirtyWorkingTree", "nonFastForward", "mergeConflict",
  "hookRejected", "authRequired", "authFailed", "networkError", "refExists", "invalidRefName",
  "emptyOrAlreadyApplied", "detachedHead", "unsupportedRepoShape",
])
```

- **Classification rules (must be deterministic, not locale-dependent):** map host-git exit codes and
  machine-readable output to codes; for ambiguous stderr (auth vs network vs hook), prefer
  exit-code + known sentinel matching, never localized message parsing. `nonFastForward`,
  `mergeConflict`, `hookRejected`, `dirtyWorkingTree` are detected from git's structured signals /
  state files, not prose.
- `emptyOrAlreadyApplied` is a **distinct non-error outcome** for cherry-pick/revert (see `SequencerOutcome`), surfaced as data, not thrown, where the UX needs to continue.
- Streaming RPCs put their error type on the per-item error channel (the top-level error becomes
  `Never` under `stream: true`); model the same `GitError` there.

---

## 5. Shared Schemas (representative — author the rest to match)

```ts
import { Schema } from "effect"

export const RepoId = Schema.String.pipe(Schema.brand("RepoId"))
export const Oid    = Schema.String.pipe(Schema.brand("Oid"))

// Liveness is a WS invalidation bus (see 15-sync-protocol.md): the server pushes which DOMAINS
// changed; the client invalidates + refetches the matching queries. No row-level deltas.
export const Domain = Schema.Literals([
  "refs", "status", "stash", "worktrees", "tags", "commits", "config", "inProgress",
])
export class InvalidationEvent extends Schema.Class<InvalidationEvent>("InvalidationEvent")({
  repoId: RepoId, domains: Schema.Array(Domain),
}) {}

export class LogQuery extends Schema.Class<LogQuery>("LogQuery")({
  repoId: RepoId,
  // ordering is FIXED: topo + date, so every parent sorts below its child (graph needs this).
  cursor: Schema.optional(Schema.String),   // opaque server token; see §6
  limit:  Schema.Number,                     // server-bounded
  refScope: Schema.optional(Schema.Literals(["all", "current", "pattern"])),
  refPattern: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  grep: Schema.optional(Schema.String),
  since: Schema.optional(Schema.String),
  until: Schema.optional(Schema.String),
}) {}

// Log rows are LIGHT (cheap at 100k commits); full body/stats come from CommitDetail.
export class CommitSummary extends Schema.Class<CommitSummary>("CommitSummary")({
  oid: Oid, parents: Schema.Array(Oid),
  authorName: Schema.String, authorEmail: Schema.String, authorDate: Schema.String,
  committerDate: Schema.String, subject: Schema.String,
  refs: Schema.Array(Schema.String),    // decoration tips at this commit
}) {}

export class DiffSpec extends Schema.Class<DiffSpec>("DiffSpec")({
  repoId: RepoId, target: Schema.String, base: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)), cached: Schema.Boolean,
  whitespace: Schema.Literals(["show", "ignore-all", "ignore-change"]),
  context: Schema.Number, renames: Schema.Boolean, combined: Schema.Boolean,
}) {}

export class CommitInput extends Schema.Class<CommitInput>("CommitInput")({
  repoId: RepoId, subject: Schema.String, body: Schema.optional(Schema.String),
  amend: Schema.Boolean, signoff: Schema.Boolean,
  sign: Schema.optional(Schema.Struct({ format: Schema.Literals(["gpg", "ssh"]), keyId: Schema.optional(Schema.String) })),
  authorOverride: Schema.optional(Schema.Struct({ name: Schema.String, email: Schema.String })),
  allowEmpty: Schema.Boolean, noVerify: Schema.Boolean,
}) {}

// Discriminated outcomes (data, not errors) where one git verb has several success shapes:
export const MergeOutcome = Schema.Union([
  Schema.TaggedStruct("FastForward",  { to: Oid }),
  Schema.TaggedStruct("MergeCommit",  { oid: Oid }),
  Schema.TaggedStruct("UpToDate",     {}),
  Schema.TaggedStruct("Squashed",     {}),
  Schema.TaggedStruct("Conflicted",   { paths: Schema.Array(Schema.String) }),
])
export const PushOutcome = Schema.Union([
  Schema.TaggedStruct("Updated",      { refs: Schema.Array(Schema.Struct({ ref: Schema.String, from: Oid, to: Oid })) }),
  Schema.TaggedStruct("UpToDate",     {}),
  Schema.TaggedStruct("Rejected",     { nonFastForward: Schema.Array(Schema.String) }),
])
export const SequencerOutcome = Schema.Union([
  Schema.TaggedStruct("Completed",          { oids: Schema.Array(Oid) }),
  Schema.TaggedStruct("Conflicted",         { op: SequencerOp, paths: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("EmptyOrAlreadyApplied", {}),
])
```

⚠ `Schema.Literals` / `Schema.TaggedStruct` / `Schema.Struct` symbol names are validated against
`4.0.0-beta.92`; re-confirm on bump.

---

## 6. History & streaming model (closes #2)

There is **one** history feed and it is a **streaming RPC**, not cursor-paged-by-discrete-response:

- `log.stream(LogQuery)` returns `Stream<CommitSummary, GitError>`. The server runs
  `git rev-list --parents --topo-order --date-order --format=…` and emits summaries as they parse,
  with **ack-based backpressure** (the virtualized list/graph pulls as the user scrolls). The head
  window is a normal query (cached/refetched); deep scroll continues the same stream by `cursor`.
- **Ordering is fixed at `--topo-order --date-order`** so every parent sorts below its child — the
  commit-graph layout (`10-commit-graph.md`) depends on this. `05-phase1-browse.md` must be updated to
  match (it currently says `--date-order` alone).
- **`cursor` is an opaque server token** for resumable windows (e.g. "load older than X"): a new
  `log.stream` with `cursor` continues from that boundary preserving the same ordering. The cursor
  encodes the boundary commit + traversal state; clients treat it as opaque. **Live/incremental
  updates** (new commits appearing at the tips, ref movement) do **not** come through `log.stream` —
  they arrive via `repo.subscribe` as **invalidation events**; the client re-runs the affected
  queries (and the head window of `log.stream`) — see `15`. So:
  **history depth = `log.stream` (pull); liveness = `repo.subscribe` invalidation (push).** This split removes the
  prior streaming-vs-pagination contradiction.
- "Scroll to commit by hash" = a `log.stream` seeded with a `cursor`/anchor resolving that oid.

---

## 7. Method catalog

Conventions: ✎ = mutating (takes the per-repo lock); ⇉ = streaming RPC. All payloads include
`repoId` unless noted. All errors are `GitError` unless a narrower union is listed.

### Repository & live state — P1
| Method | Payload | Success | Notes |
|---|---|---|---|
| `repo.open` | `{ path }` | `RepoHandle` | `OpenError = repoNotFound \| notARepository \| fsError`. Entry point (no clone). |
| `repo.recentList` | `{}` | `RecentRepo[]` | keyed by resolved top-level path |
| `repo.recentRemove` ✎ | `{ repoId }` | `void` | |
| `repo.state` | `{ repoId }` | `RepoState` | HEAD, current branch, detached, in-progress op, counts |
| `repo.subscribe` ⇉ | `{ repoId }` | `InvalidationEvent` | WS invalidation bus → query refetch (see `15`) |

### History & diff — P1
| Method | Payload | Success | Notes |
|---|---|---|---|
| `log.stream` ⇉ | `LogQuery` | `CommitSummary` | the one history feed (§6) |
| `commit.detail` | `{ repoId, oid }` | `CommitDetail` | full body, parents, stats |
| `commit.diff` | `DiffSpec` | `DiffFile[]` | diff of a commit/range |
| `diff.workingFile` | `{ repoId, path, staged }` | `DiffFile` | working-tree / index diff |
| `file.contentAtRev` | `{ repoId, path, rev }` | `FileContent` \| download descriptor | large → HTTP side-channel (§3.7) |

### Working tree, stage & commit — P2
| Method | Payload | Success | Notes |
|---|---|---|---|
| `status.get` | `{ repoId }` | `WorkingTreeStatus` | re-fetched on `repo.subscribe` invalidation (`status`) |
| `stage.files` ✎ | `{ repoId, paths }` | `void` | |
| `unstage.files` ✎ | `{ repoId, paths }` | `void` | |
| `stage.hunks` ✎ | `{ repoId, path, patch }` | `void` | patch built per §"hunk" rule below |
| `unstage.hunks` ✎ | `{ repoId, path, patch }` | `void` | |
| `discard.files` ✎ | `{ repoId, paths }` | `void` | destructive — UX guard |
| `reset.to` ✎ | `{ repoId, mode, target }` | `void` | `mode = soft \| mixed \| hard` |
| `commit.create` ✎ | `CommitInput` | `CommitCreated` | hooks run on host git; `noVerify` to bypass |

**Hunk staging rule:** the server builds the unified patch from the client's selected line ranges and
applies via `git apply --cached --recount -` (and `--reverse` for unstage). The spec author MUST cover
patch-header synthesis for **new files** (`/dev/null` + new mode), **deletions**, and byte-faithful
reconstruction under `autocrlf`/`.gitattributes` (must not corrupt EOLs). This is the highest-risk P2
detail.

### Branches & merge — P3
| Method | Payload | Success |
|---|---|---|
| `branch.list` | `{ repoId }` | `BranchInfo[]` (upstream + ahead/behind) |
| `branch.create` ✎ | `{ repoId, name, startPoint?, checkout }` | `void` |
| `branch.checkout` ✎ | `{ repoId, target, dirtyPolicy }` | `CheckoutOutcome` |
| `branch.rename` ✎ | `{ repoId, from, to }` | `void` |
| `branch.delete` ✎ | `{ repoId, name, remote, force }` | `void` |
| `branch.setUpstream` ✎ | `{ repoId, branch, upstream? }` | `void` |
| `merge.run` ✎ | `MergeInput` | `MergeOutcome` |

`dirtyPolicy`: the server **pre-classifies** a dirty working tree *before* a destructive switch (via a
temporary-index/merge-tree simulation — not by parsing localized stderr after failure) to offer
Stash / Carry / Discard.

### Remotes & sync (host git over ssh) — P3
| Method | Payload | Success | Notes |
|---|---|---|---|
| `remote.list` | `{ repoId }` | `RemoteInfo[]` | |
| `remote.add/setUrl/remove/rename` ✎ | … | `void` | |
| `fetch.run` ✎ ⇉ | `FetchInput` | `ProgressEvent` then `FetchOutcome` | streams progress |
| `pull.run` ✎ ⇉ | `PullInput` | `ProgressEvent` then `PullOutcome` | `--ff-only/--rebase/--no-rebase`, autostash; pre-classify dirty tree |
| `push.run` ✎ ⇉ | `PushInput` | `ProgressEvent` then `PushOutcome` | `--force-with-lease`, `--set-upstream`, `--tags`, delete ref |

⚠ streaming-with-final-value: model as a `Stream` whose items are a union `Progress \| Result`, or a
progress stream that completes carrying the outcome — pick one and apply uniformly to fetch/pull/push.

### Worktrees / stash / tags — P3
| Method | Payload | Success |
|---|---|---|
| `worktree.list` / `worktree.add` ✎ / `worktree.remove` ✎ / `worktree.prune` ✎ | … | `WorktreeInfo[]` / `void` |
| `stash.list` / `stash.push` ✎ / `stash.apply` ✎ / `stash.pop` ✎ / `stash.drop` ✎ / `stash.clear` ✎ / `stash.show` | … | `StashEntry[]` / `void` / `DiffFile[]` |
| `tag.list` / `tag.create` ✎ / `tag.delete` ✎ / `tag.push` ✎ ⇉ | … | `TagInfo[]` / `void` / progress |

### Cherry-pick, revert, conflicts, blame — P4
| Method | Payload | Success |
|---|---|---|
| `cherryPick.run` ✎ | `{ repoId, oids, mainline?, noCommit, recordOrigin }` | `SequencerOutcome` |
| `revert.run` ✎ | `{ repoId, oids, mainline? }` | `SequencerOutcome` |
| `sequencer.continue/skip/abort` ✎ | `{ repoId, op }` | `SequencerState` |
| `conflict.list` | `{ repoId }` | `ConflictFile[]` (porcelain `u` XY classification) |
| `conflict.stages` | `{ repoId, path }` | `{ base?, ours?, theirs? }` (blob text for the 3-way editor) |
| `conflict.takeSide` ✎ | `{ repoId, path, side }` | `void` |
| `conflict.markResolved` ✎ | `{ repoId, paths }` | `void` |
| `blame.get` | `{ repoId, path, rev?, range? }` | `BlameResult` |
| `fileHistory.stream` ⇉ | `{ repoId, path, follow }` | `CommitSummary` |

### Power features — P5
| Method | Payload | Success |
|---|---|---|
| `rebase.start` ✎ | `RebaseInput` (onto/upstream/interactive `todo[]`) | `SequencerState` |
| `rebase.continue/skip/abort` ✎ / `rebase.editTodo` ✎ | … | `SequencerState` |
| `reflog.list` | `{ repoId, ref? }` | `ReflogEntry[]` |
| `bisect.start/good/bad/skip/reset` ✎ | … | `BisectState` |
| `archive.export` | `{ repoId, format, treeish, paths? }` | download descriptor (§3.7) |
| `clean.preview` / `clean.run` ✎ | `{ repoId, opts }` | `string[]` / `void` |
| `gc.run` ✎ ⇉ | `{ repoId }` | progress |
| `submodule.list/update/sync/add/remove` ✎ | … | `SubmoduleInfo[]` / `void` |
| `config.get/set/unset` | `{ repoId, scope, … }` | `ConfigEntry[]` / `void` |

**Interactive rebase note:** the `todo[]` is driven on host git via a non-interactive sequence-editor
mechanism (a shim set as `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR` that writes the supplied todo); the
in-progress state is read from git's rebase state directory. `rebase` returns `SequencerState`, not a
single `Stream<RebaseStep>` — the pause/continue/skip/abort UX needs request/response per step.

---

## 8. In-progress operation state (shared by P1 banner, P4/P5 verbs)
`RepoState.inProgress` is derived from git-dir markers (enumerate the exact mapping in the spec:
`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/` vs `rebase-apply/`, `BISECT_LOG`,
`sequencer/`). It selects which `sequencer.*` / `rebase.*` / `bisect.*` verbs are offered.

---

## 9. Open items handed to the spec author
- Author the remaining payload/success Schemas to the patterns in §5 (one per catalog row).
- Reconcile `04-domain-model.md` result types into these Schemas (single definition).
- Add the per-operation **lock policy table** + acquisition timeout to `12-nonfunctional.md` (§3.2).
- Add **min host-git version** + per-flag fallbacks (drives the startup version gate) to `02`/`03`/`12`.
- Update `05-phase1-browse.md` ordering to `--topo-order --date-order` (§6).
- Link this file and `15-sync-protocol.md` from `00-README.md`.
