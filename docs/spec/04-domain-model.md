# Domain Model & RPC Contract

## Purpose

This section defines the TypeScript domain types that model a Git repository
inside `cbranch` — the shared vocabulary across `packages/core`,
`packages/rpc-contract`, and `packages/ui`. The **authoritative wire contract**
(method catalog, payload/success/error Schemas, the canonical `GitError` union,
transport binding, streaming, and trust model) is defined in
[`14-rpc-contract.md`](14-rpc-contract.md); this document describes the **field
semantics and parsing rules** for those types and is realized AS the Effect
Schemas in `14 §4`/`§5` — a single definition, not two. Where this document and
`14` overlap, `14` wins.

The domain model is **transport-agnostic**. All data is produced by parsing the
output of the single host-`git` backend (there is no in-process pure-JS engine).
The contract describes **what** the view may request and **what shape** comes
back, never **how** the engine produces it.

Goals:

- One canonical representation per Git concept (commit, ref, status entry, diff,
  etc.).
- Stable, machine-readable parsing rules (NUL-delimited / porcelain formats)
  that survive arbitrary file names, encodings, and locales.
- A predictable RPC surface (defined authoritatively in `14`): typed params and
  results, the single `GitError` union, Effect `Stream` progress, and
  interrupt-based cancellation.
- A deterministic query-key strategy aligned with the invalidation bus (`15`) so
  the client refetches exactly the affected domains after any mutation.

## User stories

- As a developer on a remote host, I open a repository and immediately see a
  consistent snapshot (branches, current HEAD, working-tree status) modeled by
  the same types regardless of repo size.
- As a UI developer, I consume one `Commit` type and one `FileStatus` type with a
  single canonical shape, regardless of how the engine parsed it.
- As a developer with non-ASCII and spaced file names, every path renders
  correctly because the contract is NUL-delimited end to end.
- As a developer running a long `fetch`, I see live progress and can cancel it;
  the UI receives structured `ProgressEvent`s and a final result or a typed
  `GitError`.
- As a UI developer, I can rely on cache invalidation: after a commit succeeds,
  the views that depend on status, log, and refs refresh without a manual reload.

## Functional requirements

Each requirement has a stable identifier (`DM-###` for domain types,
`RPC-###` for the RPC contract, `ENC-###` for encoding, `CACHE-###` for
caching). All are observable/testable at the contract boundary.

### Core identity & primitives

- **DM-001** An object id (`Oid`) is represented as a branded `string` holding
  the full hexadecimal object name (40 hex chars for SHA-1 repositories, 64 hex
  chars for SHA-256 repositories). The contract MUST NOT assume a fixed length;
  it MUST accept both.
- **DM-002** A `Signature` type MUST capture `name: string`, `email: string`,
  and `when: { epochSeconds: number; tzOffsetMinutes: number }`. The raw author
  date string is preserved as `epochSeconds` plus the committed timezone offset,
  not converted to the host's local time.
- **DM-003** Every domain object that originates from a Git ref or object MUST be
  serializable to JSON with no `undefined`-only distinctions: optional fields are
  either present with a value or absent. (Enables stable equality and caching.)

### Commit

- **DM-010** A `Commit` MUST include: `oid: Oid`; `parents: Oid[]` (ordered,
  empty for a root commit, length ≥ 2 for a merge); `tree: Oid`;
  `author: Signature`; `committer: Signature`; `summary: string` (first line of
  the message); `body: string` (remainder, may be empty); `encoding?: string`
  (the commit's declared encoding header if any).
- **DM-011** A `Commit` MUST expose `messageRaw: string`: the full, unmodified
  commit message bytes decoded per **ENC-002**.
- **DM-012** The log/graph result MUST provide, per commit, the data needed to
  render an ancestry graph: each commit's `oid` and ordered `parents`. The
  contract specifies only this ancestry data as the required OUTCOME; the lane/
  column layout for drawing edges is computed by the implementer (any algorithm
  or permissive layout library) and is NOT part of the domain type.
- **DM-013** A `CommitRef` decoration list MAY be attached to a `Commit` in log
  results: an array of `{ ref: Ref; isHead: boolean }` describing which refs
  point at that commit (tips, tags, HEAD).

### Ref, Branch, Tag

- **DM-020** A discriminated union `Ref` MUST cover at least:
  `{ kind: 'localBranch' }`, `{ kind: 'remoteBranch' }`, `{ kind: 'tag' }`,
  `{ kind: 'head' }` (detached or symbolic), `{ kind: 'note' }`,
  `{ kind: 'other' }`. Each variant carries `fullName` (the complete refname,
  e.g. `refs/heads/main`), `shortName` (the human display name), and
  `target: Oid` (the resolved commit/object id).
- **DM-021** A `Branch` (local) MUST include: `name: string` (short),
  `fullName: string`, `tip: Oid`, `isCurrent: boolean`, and an optional
  `upstream?: UpstreamInfo`.
- **DM-022** `UpstreamInfo` MUST include `remote: string`,
  `remoteRef: string` (the tracked remote-tracking ref short name),
  `ahead: number`, and `behind: number`. When no upstream is configured,
  `upstream` is absent.
- **DM-023** A `RemoteTrackingBranch` MUST include `name: string` (e.g.
  `origin/main`), `fullName: string`, `remote: string`, and `tip: Oid`.
- **DM-024** A `Tag` MUST distinguish lightweight vs annotated via
  `kind: 'lightweight' | 'annotated'`. For annotated tags it MUST include
  `tagger?: Signature`, `message?: string`, and `targetType`
  (`'commit' | 'tree' | 'blob' | 'tag'`); `target: Oid` is the object the tag
  refers to, and `peeledOid?: Oid` is the underlying commit when the tag points
  through to one.
- **DM-025** Ahead/behind counts MUST be reported as non-negative integers; if
  they cannot be computed (e.g. no merge base), the field value MUST be the
  sentinel `null` rather than a guessed `0`.

### Stash

- **DM-030** A `Stash` MUST include: `index: number` (the stash stack position,
  0 = most recent), `oid: Oid` (the stash commit), `message: string`,
  `branch?: string` (branch recorded at stash time), and
  `createdAt: Signature['when']`.

### Worktree

- **DM-040** A `Worktree` MUST include: `path: string` (absolute path on the
  host), `head: Oid`, `branch?: string` (short branch name, absent if detached),
  `isDetached: boolean`, `isBare: boolean`, `isMain: boolean`, and
  `locked?: { reason: string }`, `prunable?: { reason: string }`.

### File status (index vs worktree)

- **DM-050** `FileStatus` MUST model the two independent state axes Git tracks: a
  staged (index-vs-HEAD) state and an unstaged (worktree-vs-index) state, plus
  rename/copy metadata. Required fields: `path: string`;
  `origPath?: string` (source path for renames/copies);
  `indexStatus: ChangeCode`; `worktreeStatus: ChangeCode`;
  `isStaged: boolean` (derived: `indexStatus` is not unmodified);
  `isConflicted: boolean`; `isUntracked: boolean`; `isIgnored: boolean`;
  `submodule?: SubmoduleDirtyState`; `renameScore?: number` (0–100 similarity).
- **DM-051** `ChangeCode` MUST be an enum-like union covering at least:
  `'unmodified' | 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' |
  'typeChanged' | 'updatedButUnmerged' | 'untracked' | 'ignored'`.
- **DM-052** A conflicted entry MUST set `isConflicted: true` and carry
  `conflict: { ours: boolean; theirs: boolean; ancestor: boolean }` indicating
  which of the three stages are present (covering add/add, delete/modify, and
  both-modified cases).
- **DM-053** `SubmoduleDirtyState` MUST capture the three documented dirty
  signals: `commitChanged: boolean`, `hasModifiedContent: boolean`,
  `hasUntracked: boolean`.

### Diff & Hunk

- **DM-060** A `DiffFile` MUST include: `oldPath: string`, `newPath: string`,
  `status: ChangeCode`, `isBinary: boolean`, `oldMode?: string`,
  `newMode?: string`, `oldOid?: Oid`, `newOid?: Oid`,
  `additions: number`, `deletions: number`, and `hunks: Hunk[]`. For binary
  files `hunks` MUST be empty and `additions`/`deletions` MAY be reported as
  `null` when Git reports `-` in numstat.
- **DM-061** A `Hunk` MUST include: `header: string` (the `@@ ... @@` line),
  `oldStart: number`, `oldLines: number`, `newStart: number`,
  `newLines: number`, and `lines: DiffLine[]`.
- **DM-062** A `DiffLine` MUST include `kind: 'context' | 'add' | 'delete' |
  'noNewlineAtEof'`, `content: string` (without the leading +/-/space marker),
  and optional `oldLineNo?: number`, `newLineNo?: number`.
- **DM-063** The diff model MUST be sufficient to support hunk-level and
  line-level staging in the UI: every `add`/`delete` line is individually
  addressable by its position within `Hunk.lines`.

### Aggregate state & events

- **DM-070** `RepoState` is the snapshot the UI reads on open and after
  invalidation. It MUST include: `headOid?: Oid`; `currentBranch?: string`
  (absent when detached); `isDetached: boolean`;
  `operationInProgress?: 'merge' | 'rebase' | 'cherryPick' | 'revert' |
  'bisect' | 'am' | 'none'`; `isBare: boolean`; `isEmpty: boolean` (no commits
  yet); `repoRoot: string`; `gitDir: string`; `defaultBranch?: string`.
- **DM-071** A `ProgressEvent` MUST include: `opId: string` (correlates to the
  RPC call); `phase: string` (e.g. `'counting'`, `'compressing'`,
  `'receiving'`, `'resolving'`, `'writing'`); `percent?: number` (0–100 when
  determinate); `current?: number`; `total?: number`;
  `message?: string` (a human-readable line as emitted by the underlying
  operation); `timestamp: number` (epoch ms).
- **DM-072** `GitError` is the single canonical error union, defined
  authoritatively in **`14 §4`** (a `Schema.TaggedErrorClass` with
  `code: GitErrorCode`, `message`, and an optional typed `detail` carrying
  structured extras such as conflicting paths or the rejected ref). This document
  MUST NOT redefine the code set; consumers import it from
  `packages/rpc-contract`. The `message` MUST be safe to display and any stderr
  excerpt in `detail` MUST be scrubbed of credentials. (There is no separate
  `EngineError`.)

### Encoding

- **ENC-001** All path and ref-name transport MUST be NUL-delimited where Git
  offers a `-z` / NUL-terminated form; the contract MUST NOT rely on
  newline-delimited or quoted (`core.quotePath`) output for paths.
- **ENC-002** Text decoding default is UTF-8. When a commit declares an
  `encoding` header, the commit message MUST be decoded using that encoding for
  `messageRaw`/`summary`/`body`. File content/diff decoding MUST honor any
  repository-configured working-tree encoding for the path
  (`gitattributes working-tree-encoding`); otherwise UTF-8 is assumed and
  invalid sequences are replaced with U+FFFD rather than throwing.
- **ENC-003** Binary detection MUST set `DiffFile.isBinary` and the contract MUST
  carry binary content as base64 (or omit content) — never as a lossy decoded
  string.
- **ENC-004** Path strings crossing RPC MUST be raw bytes decoded as UTF-8 (with
  replacement) and the original bytes MUST be recoverable for round-tripping to
  the engine when the host filesystem is non-UTF-8. The transport MUST preserve
  exact bytes for any path used as an argument to a subsequent mutating call.

### RPC contract conventions

- **RPC-001** The authoritative method catalog (names, payload/success/error
  Schemas, which methods are mutating/streaming) is defined in **`14 §7`**; this
  document defers to it. The catalog uses `<domain>.<verb>` names (e.g.
  `repo.state`, `log.stream`, `branch.list`, `status.get`, `commit.create`,
  `fetch.run`).
- **RPC-002** Every method has exactly one typed payload and one typed success
  type, defined as Effect Schemas in `packages/rpc-contract` and imported
  unchanged by both server and UI (`14 §2`).
- **RPC-003** The contract is one `@effect/rpc` `RpcGroup`, transport-agnostic;
  the same catalog is bound to the multiplexed NDJSON WebSocket (web) and to
  `webview.postMessage` (extension). No method may assume a particular transport.
  (birpc is not used.)
- **RPC-004** Read methods MUST be idempotent and side-effect free. Mutating
  methods MUST be safe to serialize: the server takes a per-repository lock so
  concurrent mutations on one repo execute one at a time (see **CACHE-004**).
- **RPC-005** Every mutating method result MUST report the new relevant identity
  (e.g. `commit.create` returns the new `Oid`; `branch.create` returns the
  `Branch`) so the client can update optimistically and reconcile.
- **RPC-006** Long-running and incremental methods are modeled as **streaming
  RPCs** returning an Effect `Stream` (e.g. `log.stream`, `fetch.run`); progress
  and cancellation follow `14 §3.4` (ack-based backpressure; cancel = interrupt
  the consuming fiber). There is no client-generated `opId` / `op.cancel` protocol.
- **RPC-007** Large history is a **stream** (`log.stream`), not a discrete paged
  response: depth is pulled via an opaque server `cursor` plus a server-bounded
  `limit` (`14 §6`); liveness at the tips comes from the invalidation bus (`15`),
  not from re-paging. Bounded non-streaming lists (`reflog.list`) MAY use a simple
  `{ cursor?, limit }` shape.
- **RPC-008** Result payloads MUST be Effect-Schema-encodable data matching the
  domain types above (Schema `Class`/`Struct`/`Union`), serialized as NDJSON over
  the wire; no opaque functions, `Date`, `Map`, or `Set`.

#### Streaming progress & cancellation

- **RPC-020** Streaming progress and cancellation are defined authoritatively in
  **`14 §3.4`**: a streaming method returns an Effect `Stream`; the server emits a
  chunk and awaits the client `Ack` before the next (backpressure). Completion is
  the stream's normal end; there is no separate "done" event.
- **RPC-021** Cancellation = **fiber interruption**: unsubscribing/interrupting
  the consuming fiber sends `Interrupt{ requestId }`, the server interrupts the
  in-flight request fiber and kills any spawned `git` process (`acquireRelease`),
  and the call rejects with `GitError { code: 'cancelled' }`. A dropped connection
  interrupts all of that client's fibers.
- **RPC-022** Progress chunks are advisory: a client that ignores them MUST still
  receive a correct final result. Dropping one MUST never corrupt state.

#### Error shape

- **RPC-030** All rejections cross the wire as the canonical `GitError` union
  defined in **`14 §4`**; `GitErrorCode` is the closed string union enumerated
  there (e.g. `notARepository`, `repoLocked`, `lockTimeout`, `mergeConflict`,
  `nonFastForward`, `authFailed`, `hostGitMissing`, `cancelled`, …). This document
  MUST NOT maintain a second copy of the code set.
- **RPC-031** `message` MUST be safe to display to the user (no absolute secret
  paths). Any stderr excerpt MAY include diagnostic text but MUST be scrubbed of
  credential material (there is no app-level bearer token in v1).
- **RPC-032** Payloads are validated by Effect Schema at the service boundary; a
  decode failure MUST be rejected before any Git operation runs (surfaced as a
  schema/validation error, never a partial execution).

#### Caching & invalidation

- **CACHE-001** Client query keys are structured tuples `[repoId, domain,
  ...params]` (per `15 §2`) so an invalidation maps mechanically to the queries it
  affects. `params` are normalized (keys sorted; volatile fields removed).
- **CACHE-002** Read results are cached in the client query cache
  (`@tanstack/react-query`), which is the **sole feeder** for synced data (`15 §8`).
- **CACHE-003** Invalidation **domains** are the fixed set defined in `14 §5` /
  `15 §2`: `'refs'`, `'status'`, `'stash'`, `'worktrees'`, `'tags'`, `'commits'`,
  `'config'`, `'inProgress'`. Each query key's `domain` is drawn from this set.
- **CACHE-004** After any successful mutation the server (a) releases the per-repo
  `Effect.Semaphore(1)` lock, and (b) the on-disk change is detected by the host
  filesystem watcher, which pushes an `InvalidationEvent { repoId, domains }` over
  `repo.subscribe`; clients invalidate and refetch the matching keys (`15 §3`/`§6`).
  There is **no in-process engine cache** to invalidate (single host-`git` backend;
  object reads are content-addressed via the `cat-file --batch` pool).
- **CACHE-005** External changes not initiated through cbranch (e.g. the user runs
  `git` in a terminal) are detected by the same watcher and produce the same
  `InvalidationEvent`. On reconnect the client invalidates every query for the repo
  (full resnapshot — `15 §5`). Immutable content reads (commit detail/diff/blame at
  a fixed oid) are content-addressed and are never invalidated.

## Git operations

The contract specifies the **machine-readable** Git data sources and exactly
what each parses into. All reads come from the single host-`git` backend (object
reads via the per-repo `git cat-file --batch` pool; reads pass
`--no-optional-locks`).

- **Working-tree status** → `git status --porcelain=v2 -z --branch
  --untracked-files=all --ignored=matching` (ignored only when requested).
  Parsed into `FileStatus[]` (DM-050): `1`/`2` entries → staged+worktree change
  codes and rename score; `u` entries → `isConflicted` with the three stage
  flags; `?` → untracked; `!` → ignored. Branch header lines populate
  `RepoState.currentBranch`, `headOid`, and ahead/behind for the current branch.
  NUL termination (`-z`) is mandatory (ENC-001).
- **Commit log / graph** → `git log` (or `git rev-list`) with `--parents -z` and
  a custom `--format` emitting a record per commit: `oid`, full `parents`,
  author/committer name+email+`%at`/`%ct`+tz, encoding (`%e`), subject, and body,
  using a NUL/record-separator delimiting so messages with newlines parse
  unambiguously. Parsed into `Commit[]` (DM-010/011) plus ancestry for graph
  layout (DM-012). Decorations via `%D` or a separate ref scan → `CommitRef[]`
  (DM-013).
- **Refs (branches/tags/remotes)** → `git for-each-ref --format=...` selecting
  `%(refname)`, `%(objectname)`, `%(objecttype)`, `%(upstream:short)`,
  `%(upstream:track)`, `%(upstream:remotename)`, `%(*objectname)` (peeled),
  `%(taggername)`/`%(taggeremail)`/`%(taggerdate)`, and tag subject. Parsed into
  `Ref` / `Branch` / `RemoteTrackingBranch` / `Tag`. Ahead/behind from
  `%(upstream:track)` when present, else `git rev-list --left-right --count
  A...B`; uncomputable → `null` (DM-025).
- **Object content** → `git cat-file` (e.g. `--batch` / `--batch-check`) to
  resolve types, sizes, and raw bytes for `Tag` annotation bodies, blob content,
  and existence checks. Binary detection per ENC-003.
- **Diff (file/commit/index)** → `git diff` (and `git diff --cached` for staged)
  with `-z`, full hunk context, plus a parallel `git diff --numstat -z` to obtain
  `additions`/`deletions` and `-`/`-` binary markers. Parsed into `DiffFile`/
  `Hunk`/`DiffLine` (DM-060..062). Rename/copy detection (`-M`/`-C`) populates
  `oldPath`/`renameScore`.
- **Stash** → `git stash list -z --format=...` → `Stash[]` (DM-030).
- **Worktrees** → `git worktree list --porcelain -z` → `Worktree[]` (DM-040),
  including `locked`/`prunable`/`detached`/`bare` flags.
- **Network sync** (`fetch`/`pull`/`push`) → host `git` binary with `--progress`
  so its stderr progress lines map to `ProgressEvent`s (DM-071) on the streaming
  RPC. These are mutating and follow the lock + invalidation rules (CACHE-004).
  (`clone` is out of scope — repositories are opened by existing on-disk path.)
- **Repo state** → combination of the status `--branch` header, presence of
  in-progress operation markers, and `git rev-parse` (`--show-toplevel`,
  `--git-dir`, `--is-bare-repository`) → `RepoState` (DM-070).

In all cases: prefer `--porcelain` / explicit `--format` / `-z`; never parse
locale-sensitive or human-formatted output; treat paths as bytes (ENC-001/004).

## UI/UX requirements

These are functional expectations the domain/RPC layer must enable; visual
styling is out of scope.

- **UX-001** The repo view reads (via `@tanstack/react-query`) `repo.state`,
  `status.get`, `branch.list`, and `log.stream`, and holds one `repo.subscribe`
  stream; on an `InvalidationEvent` whose `domains` match a query's `domain`
  (CACHE-003), the affected queries refetch automatically (`15`).
- **UX-002** Large lists (log, status with thousands of entries) are rendered
  with `@tanstack/react-virtual`; the paginated list contract (RPC-007) supplies
  data incrementally so the first screen renders before the full set loads.
- **UX-003** A long-running operation (fetch/push) surfaces a determinate or
  indeterminate progress indicator fed by the streaming RPC's `ProgressEvent`s,
  with a Cancel action that interrupts the consuming fiber (RPC-021).
- **UX-004** Errors surface as a typed toast/dialog driven by `GitError.code`
  and `message`; conflict errors (`mergeConflict`) route the user to the
  conflict view using `details` (the conflicting paths).
- **UX-005** Status entries render their two-axis state (DM-050) so the user can
  see staged vs unstaged independently and act on each; conflicted entries are
  visually distinct and offer resolution actions.
- **UX-006** Branch rows show upstream tracking and ahead/behind (DM-022); a
  `null` ahead/behind renders as "—" (uncomputable), never as 0.
- **UX-007** Diff and merge editors (`react-diff-view`, CodeMirror 6 +
  `@codemirror/merge`) consume `DiffFile`/`Hunk`/`DiffLine` directly; line-level
  addressability (DM-063) enables hunk/line staging interactions.

## Acceptance criteria

- **AC-001** Given a repo containing a file with a space and non-ASCII bytes in
  its name, `status.get` returns a `FileStatus` whose `path` round-trips exactly
  when passed back to a staging call (ENC-001/004).
- **AC-002** Given a merge commit, `log.list` returns a `Commit` with
  `parents.length >= 2`, and the result contains enough ancestry data to render
  every edge in the graph (DM-012).
- **AC-003** Given a branch tracking `origin/main` that is 2 ahead and 1 behind,
  `refs.list` returns `UpstreamInfo { ahead: 2, behind: 1 }`; given an unrelated
  history with no merge base, ahead/behind is `null`, not `0` (DM-022/025).
- **AC-004** Given an annotated tag, `refs.list` returns
  `Tag { kind: 'annotated', tagger, message, peeledOid }`; a lightweight tag
  returns `kind: 'lightweight'` with no tagger.
- **AC-005** A `commit.create` followed by `op.cancel` of an unrelated `opId`
  succeeds; the same UI receives an `invalidate` for `['index','worktree',
  'commits','refs']` after the commit (CACHE-004).
- **AC-006** Cancelling an in-flight `remote.fetch` rejects the call with
  `GitError { code: 'cancelled' }` and the underlying process terminates
  (RPC-021).
- **AC-007** A binary file change yields `DiffFile { isBinary: true, hunks: [] }`
  and never a decoded string body (ENC-003).
- **AC-008** Two concurrent mutating calls on the same repo execute serially; the
  second observes the first's effect or its own consistent snapshot, never a
  torn state (RPC-004 / CACHE-004).
- **AC-009** Any rejection observed by the client is a `GitError` with a `code`
  drawn from the closed `GitErrorCode` union (RPC-030).
- **AC-010** A commit authored in a non-UTF-8 encoding declared in its header
  decodes to a correct `summary`/`body` (ENC-002).

## Edge cases & error handling

- **EC-001** Empty repository (no commits): `RepoState.isEmpty = true`,
  `headOid` absent; `log.list` returns `{ items: [], nextCursor: undefined }`
  without error.
- **EC-002** Detached HEAD: `RepoState.isDetached = true`, `currentBranch`
  absent; status/log still resolve.
- **EC-003** Bare repository: `RepoState.isBare = true`; worktree/status methods
  return empty rather than failing where a working tree is absent.
- **EC-004** Submodule entries: reported via `FileStatus.submodule` (DM-053);
  not recursed into by status itself.
- **EC-005** Rename vs delete+add: when detection is enabled, a `renamed`
  `FileStatus`/`DiffFile` with `origPath` and `renameScore` is reported; with
  detection off, separate `deleted`+`added` entries are acceptable but MUST be
  consistent within one response.
- **EC-006** Conflicted file with all three stages, or delete/modify, or add/add:
  modeled by `conflict` stage flags (DM-052); the UI MUST handle missing stages.
- **EC-007** Operation-in-progress (rebase/merge/cherry-pick/revert/bisect/am):
  `RepoState.operationInProgress` reflects it; mutations that would conflict MAY
  reject with an appropriate `GitErrorCode` (e.g. `dirtyWorkingTree`).
- **EC-008** Non-fast-forward push rejects with `code: 'nonFastForward'`;
  auth problems map to `authRequired`/`authFailed`; transient network issues to
  `networkError`.
- **EC-009** A hook that aborts a commit/push rejects with `code: 'hookRejected'`
  and a scrubbed `gitStderrExcerpt`.
- **EC-010** Lock timeout: if the per-repo lock cannot be acquired within the
  configured window, mutating calls reject with `code: 'lockTimeout'`.
- **EC-011** Invalid/abandoned `opId` to `op.cancel` resolves as a no-op
  (RPC-021).
- **EC-012** Extremely large diffs/blobs: the contract MAY omit content beyond a
  size threshold, setting a flag in `DiffFile` (e.g. `isBinary` or an explicit
  `truncated` marker) rather than streaming megabytes inline.
- **EC-013** Invalid UTF-8 in tracked text is decoded with U+FFFD replacement,
  never throwing (ENC-002).
- **EC-014** A method invoked against a path that is not a Git repository rejects
  with `code: 'notARepo'`.

## Out of scope

- The graph lane/column layout algorithm — only ancestry data is specified
  (DM-012); layout is an implementation choice.
- Transport wiring and the trust model (the multiplexed WS binding, `Origin`/`Host`
  checks; app-level auth is descoped for v1) — defined in `14 §2`/`§3.6`; here we
  only require that errors and excerpts are scrubbed of credentials.
- Persistence of UI state (selected commit, panel sizes) — that is Zustand UI
  state, not domain data.
- Multi-repository aggregation — cbranch operates on one repository at a time;
  `repoId` exists only to scope queries and the per-repo lock.
