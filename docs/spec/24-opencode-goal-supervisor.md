# OpenCode Goal Supervisor

## Status and normative language

This document is the authoritative specification for
`@cbranch/opencode-goal-supervisor`. It describes the implemented `0.1.0`
contract. `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative.

The package is an independent local control plane for approved OpenCode work. It
does not change cbranch's Git RPC contract, host service, browser UI, or Git
engine architecture.

## Scope and boundaries

GS-ARCH-1: The package MUST operate on one canonical workspace per daemon. One
daemon MUST own scheduling for that workspace, enforced by an owner-token lock.
SQLite MAY have concurrent CLI, MCP, and plugin clients under its WAL and busy
timeout behavior.

GS-ARCH-2: The package MUST open no listening socket. `serve` means run the
workspace daemon; it MUST NOT create an HTTP, WebSocket, RPC, or MCP listener.
MCP MUST use stdio.

GS-ARCH-3: Package-owned network communication MUST be an outbound OpenCode
HTTP or HTTPS client and optional OpenCode SSE subscription. Agent work and
approved verifier executables are external workloads and MAY perform their own
network operations.

GS-ARCH-4: The supervisor MUST contain no Git orchestration and MUST NOT invoke
Git as part of its own control-plane behavior. An explicitly approved verifier
executable or an external OpenCode agent MAY invoke Git; that is arbitrary
workload execution, not a package Git backend.

GS-ARCH-5: The package MUST NOT import cbranch's `GitEngine`, open a cbranch host
socket, or add methods to `rpc-contract`. It MAY coexist in the monorepo as a
separate package.

GS-ARCH-6: Durable state MUST be workspace-local SQLite. The daemon is the sole
execution owner; CLI, MCP, and plugin are authenticated control surfaces that
open the same workspace state rather than contacting a daemon control socket.

## Components

| Component | Implemented responsibility | Forbidden responsibility |
|---|---|---|
| `domain.ts` | Versioned Zod contracts, states, transition policy, plan validation. | I/O and external dispatch. |
| `store.ts` | SQLite migrations, transactions, events, projections, plans, leases, inboxes, outbox, evidence, verification records, approvals, budgets, backup. | OpenCode calls and daemon loops. |
| `control.ts` | Workspace authentication, request validation, idempotent policy operations, public redaction. | Scheduling and network listeners. |
| `supervisor.ts` | Outbox delivery, probe policy, outcome reconciliation, verifier orchestration, cancellation, finalization. | Direct persistence outside `GoalStore`. |
| `verification.ts` | Bounded direct process spawn, controlled environment, output cap, redaction, digest, cancellation. | Shell interpretation and sandbox claims. |
| `daemon.ts` | Effect-scoped ownership, startup reconciliation, polling loops, concurrency, signals, finalization. | Multi-workspace or multi-host ownership. |
| `opencode-adapter.ts` | OpenCode session create, prompt, probe, outcome read, abort, health, and event normalization. | Goal policy decisions. |
| `opencode.ts` | Trusted plugin tools and relevant event/permission audit bridge. | Work scheduling or permission answers. |
| `mcp.ts` | Authenticated stdio MCP tools over `GoalControlService`. | Network MCP transport. |
| `cli.ts` | Operator command parsing, output, process lifecycle, daemon and MCP entrypoints. | Direct transition bypass. |
| `systemd.ts` | Safe user-unit generation, atomic write, lifecycle command rendering, lock inspection. | Running `systemctl`. |

## Versioned domain

GS-DOM-1: Serialized domain objects MUST carry `schemaVersion: 1` where their
schema requires it. Database migrations MUST be tracked separately; the current
latest database migration is 3.

GS-DOM-2: IDs MUST be 1 through 128 characters, start alphanumeric, and contain
only alphanumerics plus `.`, `_`, `:`, or `-`. Compact references MUST be 1
through 512 whitespace-free characters accepted by `CompactReferenceSchema`.

GS-DOM-3: SHA-256 digests MUST be lowercase 64-character hexadecimal strings
prefixed by `sha256:`.

GS-DOM-4: Goal and plan objectives and unit instructions MUST be nonempty and at
most 20,000 characters. Outcome and verification summaries MUST be printable,
single-line, nonempty, and at most 500 characters where the domain schema
applies.

## Goal lifecycle

The states are `draft`, `ready`, `executing`, `paused`, `needs-replan`,
`awaiting-decision`, `blocked`, `unknown-outcome`, `achieved`, and `cancelled`.

| Current state | Legal policy actions and target | Required guard |
|---|---|---|
| `draft` | `plan-ready` to `ready`; `cancel` to `cancelled`; `replan`, `decision`, or `block` to the named nonterminal state. | `plan-ready` requires an approved plan. |
| `ready` | `start` to `executing`; `pause`, `cancel`, `replan`, `decision`, `block`/`fail`, or `unknown-outcome` to the named state. | `start` requires an active approved plan and consumed unattended-start approval. |
| `executing` | `pause`, `cancel`, `replan`, `decision`, `block`/`fail`, `unknown-outcome`, or `achieve`. | `achieve` requires all required active-plan units accepted and all required final verification passed. |
| `paused` | `resume` to `ready` or `executing`; `cancel`, `replan`, `decision`, `block`/`fail`, or `unknown-outcome`. | `resume` requires a resume approval. The implemented control resumes to `executing`. |
| `needs-replan` | `plan-ready` to `ready`; `cancel`, `decision`, `block`/`fail`, or `unknown-outcome`. | `plan-ready` requires an approved revision of the active plan. |
| `awaiting-decision` | `resume` to `ready` or `executing`; `pause`, `cancel`, `replan`, `block`/`fail`, or `unknown-outcome`. | `resume` requires an approved decision. The implemented control consumes a resume token and resumes to `executing`. |
| `blocked` | `resume` to `ready` or `executing`; `cancel`, `replan`, `decision`, or `unknown-outcome`. | `resume` requires a blocked-resume approval. The implemented control resumes to `executing`. |
| `unknown-outcome` | `recover` to an explicitly selected nonterminal state or `cancelled`. | Recovery requires a recover-unknown-outcome token, explicit decision text, and target. No other action is legal. |
| `achieved` | None. | Terminal and fenced. |
| `cancelled` | None. | Terminal and fenced. |

GS-LIFE-1: Public control MUST disable arbitrary direct state transitions. It
MUST use plan approval, start, pause, resume, cancel, outcome policy, recovery,
and finalization operations.

GS-LIFE-2: Every goal mutation MUST increment the optimistic goal version and
fail if its projected version changed concurrently.

GS-LIFE-3: Pause and cancel MUST fence dispatch transactionally. They MUST
retire pending or leased outbox work, cancel active attempts, clear active unit
leases, and create durable cancellation requests for attempts that may have
crossed the external dispatch boundary. Pause MUST return unfinished units to
`queued`; cancel MUST set unfinished units to `cancelled`.

GS-LIFE-4: Achievement MUST be supervisor-derived, never accepted from agent
prose. Only `achieved` and `cancelled` are terminal.

## Plans, dependencies, and approvals

GS-PLAN-1: Plans MUST contain 1 through 1,024 units. Unit IDs MUST be unique.
Dependencies MUST refer to units in the same plan, MUST NOT be self-edges, and
MUST form an acyclic graph.

GS-PLAN-2: Each unit MUST have 1 through 256 nonempty acceptance criteria. The
validator MUST reject a normalized pair `must X` and `must not X`. This simple
text check is not a general semantic contradiction solver.

GS-PLAN-3: Verification requirement IDs MUST be unique across unit and final
requirements in a plan. A requirement MUST name a direct executable, argument
array, timeout, combined output cap, expected exit code, and whether it is
required after schema defaults are applied.

GS-PLAN-4: A plan MAY be proposed only while its goal is `draft` or
`needs-replan`. Revisions MUST be immutable, monotonically numbered per goal,
and content-addressed with canonical JSON SHA-256. A revised plan MUST parent
the active plan.

GS-PLAN-5: Only the latest proposed revision MAY be approved. Approval MUST
supersede the previous approved plan, materialize new work units and dependency
edges, set the active plan, and move the goal to `ready`. Only active-plan units
MAY be claimed.

GS-PLAN-6: A dependency is satisfied only when the prerequisite work unit is
`accepted`. Optional units do not block final achievement, but required units do.

GS-APP-1: Plan approval MUST be an explicit authenticated operator operation.
It does not issue or consume an action token and MUST NOT start execution.

GS-APP-2: Unattended start, normal resume, blocked resume, unknown-outcome
recovery, budget raise, and destructive-unit approval MUST use separate scoped
action tokens.

GS-APP-3: An action token MUST have 256 bits of generated entropy in the normal
implementation, MUST be stored only as a SHA-256 hash, MUST be bound to one goal
and exact scope, MUST expire, and MUST be consumed atomically at most once. The
TTL MUST be positive and no greater than 365 days.

GS-APP-4: A newly issued action token MUST be returned only by the first
successful issuance execution. Idempotent replay MAY return the approval record
but MUST NOT recover the plaintext token.

GS-APP-5: A destructive plan unit MUST remain unclaimable until a work-unit
token for its materialized ID is consumed. Plan or start approval MUST NOT imply
destructive approval.

GS-APP-6: Permission approvals observed from OpenCode are audit records. They
MUST NOT implicitly satisfy start, resume, destructive, recovery, or budget
approval scopes.

## Work, outcomes, and viability

Work unit states are `queued`, `running`, `verifying`, `accepted`, `failed`,
`cancelled`, and `unknown-outcome`. Attempt states are `leased`, `dispatched`,
`running`, `verifying`, `succeeded`, `failed`, `expired`, `cancelled`, and
`unknown-outcome`.

GS-WORK-1: A claim MUST atomically select one queued active-plan unit of an
executing goal whose dependencies, destructive approval, budgets, and
concurrency are satisfied. It MUST set the unit running, create a numbered
attempt lease, increment attempt usage, and create its outbox command.

GS-WORK-2: Attempts MUST be settled or renewed only by their exact unexpired
lease token and owner where owner is required. A stale attempt MUST NOT report an
outcome.

GS-WORK-3: `AgentOutcome` MUST be strict structured JSON with schema version,
attempt ID, lease token, allowed status, concise summary, evidence references,
and verification references. Optional transcript, artifact, failure fingerprint,
material-change digest, and issue classification fields MUST obey their schemas.

GS-WORK-4: A completed outcome MUST include at least one evidence reference.
Every required unit verifier MUST have a passed result for that same attempt and
the outcome MUST reference each such result ID.

GS-WORK-5: Successful settlement MUST mark the attempt `succeeded` and the unit
`accepted`. The supervisor MUST run required final verification only after every
required active-plan unit is accepted.

GS-VIABLE-1: A failed outcome with no escalation condition MUST return its unit
to `queued`, subject to subsequent budget checks.

GS-VIABLE-2: Status `blocked`, issue `dependency`, issue `budget`, or exhausted
budget MUST move the goal to `blocked`, subject to GS-VIABLE-8 precedence.

GS-VIABLE-3: Issue `credentials` or `permission` MUST move the goal to
`awaiting-decision`, subject to GS-VIABLE-8 precedence.

GS-VIABLE-4: Status `needs-replan`, issue `contradictory-criteria`, three
attempts with one failure fingerprint, or two attempts with one material-change
digest and no positive verification improvement MUST move the goal to
`needs-replan`, subject to GS-VIABLE-8 precedence.

GS-VIABLE-5: Status `unknown-outcome` or issue `external-ambiguity` MUST move the
unit, attempt, and goal to `unknown-outcome` and MUST stop claims for that goal.

GS-VIABLE-6: The default budget MUST be 20 attempts, 86,400,000 wall-clock ms,
3,600,000 verification ms, and 1,000,000 tokens. Claims MUST stop when any usage
is at or above its limit. Raising a budget MUST NOT reduce any limit.

GS-VIABLE-7: Attempt claims, settled-attempt elapsed time, and recorded verifier
durations MUST update their implemented counters. The OpenCode adapter currently
does not meter tokens; readiness claims MUST disclose that `maxTokens` remains
zero unless an integrating library records usage.

GS-VIABLE-8: Escalation precedence MUST be external ambiguity, then credentials
or permission, then dependency, budget, blocked status, or exhausted budget,
then replan conditions. Conflicting agent status and issue classification MUST
resolve in that order.

## Verification and evidence

GS-VER-1: Plan verification MUST spawn the executable directly with
`shell: false`, ignored stdin, piped stdout/stderr, and a controlled environment.
It MUST NOT parse a shell command string.

GS-VER-2: Generic verifier `cwd` MUST resolve within the canonical workspace,
including after resolving available symlinks. Plan-materialized unit and final
requirements currently run at the workspace root.

GS-VER-3: Effective runtime timeout MUST be between 10 ms and 30 minutes. The
effective combined stdout/stderr cap MUST be between 1 byte and 8 MiB. The
runtime MUST kill and reap the direct child on timeout, abort, or output overflow.
It MUST NOT claim to kill detached descendants or provide a sandbox.

GS-VER-4: The default inherited environment MUST be limited to `PATH`, `HOME`,
`SystemRoot`, `TEMP`, `TMP`, and `TMPDIR` when present. Fixed settings MUST
disable interactive Git prompts, pagers, and color. The generic API MAY
explicitly allow or override additional valid environment names.

GS-VER-5: Captured output MUST apply caller-supplied exact redactions and common
credential-pattern redaction. The output digest MUST be SHA-256 over the capped,
redacted stdout/stderr object. Redaction MUST be documented as best effort.

GS-VER-6: Durable verifier storage MUST retain status, timestamps, summary,
declared requirement ID, evidence pointer and digest, output digest, and no more
than 4,096 characters of compact output. The package MUST NOT claim to store a
full verifier log.

GS-VER-7: Passed process status MUST require the declared expected exit code.
Timeout and output overflow map to `inconclusive`; cancellation and spawn error
map to `error`; a nonmatching exit code maps to `failed`. Any required status
other than `passed` MUST convert agent completion into a verification failure.

GS-VER-8: Finalization MUST require every required final verifier's latest
applicable result to pass. No required final requirements means this guard is
true once all required units are accepted.

GS-EVID-1: Evidence references MUST pair a compact durable pointer with a
SHA-256 digest. The store MAY persist placeholder metadata for such references,
but MUST NOT claim that it fetched or independently validated referenced bytes.

GS-EVID-2: `artifactRefs` MUST be pointers only. The supervisor MUST NOT embed
artifact bodies in outcomes or durable events.

GS-EVID-3: The OpenCode adapter MUST return an encoded
`opencode-transcript:<session-id>` pointer for a completed session. The
supervisor MUST NOT store the transcript body. OpenCode remains the transcript
system of record.

GS-CTX-1: A dispatch prompt MUST contain only the current attempt and lease,
current unit title and instructions, acceptance criteria, and compact outcome
contract. It MUST omit prior transcripts and unrelated goal context.

GS-CTX-2: Outcome summary is capped at 500 characters; evidence,
verification, and artifact arrays are capped at 64; compact references are
capped at 512 characters. Durable state MUST replace conversational context as
the scheduling authority.

## Events, source records, and projection recovery

GS-EVT-1: Every durable goal mutation MUST append a goal event with a unique ID,
workspace-local monotonic sequence, type, timestamp, current goal snapshot, and
available command/causation/correlation IDs in the same transaction.

GS-EVT-2: `goal_events` MUST reject update and delete. Sequence is a local
SQLite ordering aid and MUST NOT be represented as distributed or global
consensus.

GS-EVT-3: Mutable lifecycle and scheduling tables are operational projections
of transactions recorded by the append-only event stream. The implemented
`rebuildProjections()` scope is intentionally narrower: it reconstructs only the
`goals` lifecycle projection from the latest schema-valid goal snapshots in
event order.

GS-EVT-4: Plans, work units, dependencies, attempts, approvals, command inbox,
observation inbox and records, outbox and delivery attempts, evidence,
verification results and baselines, budgets and usage, cancellation requests,
and external session references remain durable source records. Projection
rebuild MUST NOT claim to recreate them from events.

GS-EVT-5: A rebuild MAY remove a goal projection with no corresponding valid
event and its associated records to preserve foreign-key consistency. Operators
MUST back up before rebuilding and MUST use rebuild only for a diagnosed goal
lifecycle projection mismatch.

GS-EVT-6: Plan document content, digest, revision, and goal ownership MUST be
immutable after insertion. Status and approval metadata MAY change.

## Command idempotency and durable dispatch

GS-IDEM-1: Every mutating control request MUST have a compact `commandId` at the
control boundary. CLI, plugin, and MCP edges MAY generate it when their public
input omits it.

GS-IDEM-2: The command inbox MUST bind `commandId` to canonical request digest
and workspace. Exact replay MUST return the persisted result or persisted
redacted error without rerunning the handler. Reuse with different input MUST
fail.

GS-DISP-1: Work claim MUST create one outbox `dispatch-attempt` command with
stable key `attempt:<attempt-id>`. Retries and dispatcher lease reclamation MUST
retain that key.

GS-DISP-2: The dispatcher MUST durably mark the external-call boundary before
calling the adapter. A `BeforeExternalSideEffectError` MAY retry without a
probe. Any other failure after the boundary MUST be treated as ambiguous and
MUST require a probe before another dispatch.

GS-DISP-3: Nonambiguous delivery failures MUST use bounded exponential backoff,
starting at one second and capped at 60 seconds. Ambiguous failure MUST become
immediately probeable, not blindly redispatched.

GS-DISP-4: Probe `absent` MUST clear ambiguity and release the same command for
dispatch. Probe `active` or `completed` MUST mark delivery and persist the
external reference. Probe `unknown`, invalid response, or probe failure MUST
retire the command and enter `unknown-outcome`.

GS-DISP-5: Expired dispatcher leases that had crossed `dispatch.started` MUST
return to pending only with `needsProbe`. Delivery MUST reject a stale dispatcher
lease and MUST reject marking a probe-required command delivered directly.

GS-DISP-6: An attempt lease that expires with no external dispatch evidence MAY
be marked expired and its unit requeued only if the goal is executing and all
budgets remain viable.

GS-DISP-7: A stale external dispatch after attempt lease expiry MUST be
`unknown-outcome` and MUST NEVER be automatically requeued. This applies when
dispatch started, delivery was recorded, or an external reference exists.

GS-DISP-8: Pause, cancel, and achievement MUST retire residual outbox commands.
External abort MUST be represented by durable cancellation requests and
acknowledgements; an abort call MUST NOT be assumed successful without adapter
confirmation.

## OpenCode adapter

GS-OC-1: The implemented adapter MUST use the configured OpenCode base URL and
workspace directory with the pinned SDK contract. It MUST list, create, inspect,
prompt, abort, and observe sessions only through that client.

GS-OC-2: A dispatched attempt MUST use exact session title
`Goal Supervisor | <idempotency-key>`. The adapter MUST select the earliest
matching session deterministically, create one only if absent, and send the work
prompt only if no user message exists. Prompt requests MUST use deterministic
message ID `msg_goal_<first-32-hex-of-sha256(idempotency-key)>`.

GS-OC-3: Probe MUST inspect both session messages and status. A valid structured
outcome means completed; busy or retry means active; no matching session or a
matching session with no user prompt means absent; an ended assistant response
without a valid outcome means unknown.

GS-OC-4: Outcome read MUST accept only the latest assistant message whose whole
text parses as `AgentOutcome`. It MUST return active or unknown otherwise. The
supervisor MUST additionally verify attempt and lease equality.

GS-OC-5: Event observation MAY normalize session status, idle, error, message
updates, and permission changes for linked sessions. It MUST assign stable
deduplication keys. It MUST set `schedulerAction: false` for idle/status
observations and MUST NOT schedule from `session.idle`.

## Effect daemon, concurrency, and shutdown

GS-DAEMON-1: The daemon MUST acquire
`.opencode/goal-supervisor/daemon.lock` atomically before opening execution
ownership. The record MUST contain PID, random owner token, canonical workspace,
and creation time. The lock path MUST be published from a fully written candidate
inode. Release MUST delete only the unchanged matching owner token.

GS-DAEMON-2: A live owner PID MUST reject another daemon. A stale or invalid
owner MAY be replaced only through the implemented compare-before-delete path;
status inspection MUST NOT delete a lock. Stale replacement MUST be serialized
by `daemon.lock.recovery`. An interrupted recovery guard MUST fail closed and be
reported as invalid for operator inspection; it MUST NOT be reclaimed
automatically.

GS-DAEMON-3: Startup MUST reconcile expired attempt and outbox leases, process
durable cancellation, and reconcile linked active sessions before normal claim
and dispatch loops.

GS-DAEMON-4: The daemon MUST use Effect scopes for dispatch, reconciliation,
cancellation, and optional observation loops. Tick failure MUST be reported and
MUST NOT terminate all loops unless startup or ownership fails.

GS-DAEMON-5: Defaults MUST be dispatch every 1,000 ms, reconciliation every
1,000 ms, cancellation every 500 ms, observation restart every 1,000 ms,
dispatcher lease 60 seconds, attempt lease 5 minutes, dispatch batch 10,
reconciliation and cancellation batch 100, daemon global active limit 4, and
workspace active limit 2. Adapter dispatch and reconciliation concurrency
default to 1.

GS-DAEMON-6: Workspace concurrency MUST NOT exceed global concurrency. Numeric
configuration MUST be positive, bounded integers. Claiming MUST account for
currently active attempts before creating more.

GS-DAEMON-7: `SIGINT`, `SIGTERM`, or caller abort MUST close the Effect scope.
Shutdown MUST stop loops, abort observation, attempt pending cancellation within
the configured 30-second default bound, recover expired outbox leases,
checkpoint SQLite in passive mode, close the store, and release the owner lock.

GS-DAEMON-8: Daemon shutdown MUST NOT claim that every external session was
aborted. Active sessions and durable references MUST be reconciled by the next
owner; stale externally dispatched attempts remain subject to unknown-outcome
policy.

## Control surfaces

| Surface | Authentication and behavior |
|---|---|
| CLI | Opens canonical workspace control, loads the owner-only token internally, generates mutation IDs, validates argv before state where possible, supports human or JSON output. |
| MCP | Local stdio only; the launching process loads and validates the workspace token out of band, injects it at the control edge, and never exposes it as a model-authored tool field; mutation IDs are preserved or generated at the MCP edge. |
| Plugin | Trusted OpenCode process loads the token and injects it into tools; records linked session and permission observations; closes its control on dispose. |
| Library | Exposes domain, store, supervisor, verifier, control, adapter, daemon, and systemd APIs from the package root. |
| systemd | Writes a user unit only; lifecycle remains an explicit operator action. |

GS-CTRL-1: Initialization MUST canonicalize an existing workspace with
`realpath`, reject a symlinked control directory, require exact owner-only POSIX
mode and ownership where supported, and atomically create a 256-bit control
token when absent.

GS-CTRL-2: Every control method MUST schema-validate input, authenticate using a
hash-before-constant-time comparison, and fence goal IDs to the canonical
workspace. Public inspection MUST omit approval token hashes.

GS-CTRL-3: The CLI MUST implement only `init`, `serve`, `status`, `plan`,
`start`, `pause`, `resume`, `cancel`, `approve`, `recover`, `doctor`, and `mcp`.
Legacy direct `create`, `list`, and `transition` CLI commands MUST remain absent.

GS-CTRL-4: `init --systemd` MUST write the unit and print lifecycle commands. It
MUST NOT run `systemctl`, enable the unit, start it, or enable login lingering.

GS-CTRL-5: `doctor` MUST check database/token permissions, daemon lock status,
SQLite integrity and migration version, lifecycle projection agreement, and
OpenCode health. Its CLI exit status MUST be nonzero when any check is unhealthy.

GS-CTRL-6: `doctor --recover` MUST perform only startup lease reconciliation in
addition to normal checks. It MUST NOT imply unknown-effect resolution,
projection rebuild, corruption repair, or stale-lock deletion.

GS-CTRL-7: Model-facing plugin and MCP `goal_approve` tools MUST be request-only.
They MUST render an operator CLI instruction and MUST NOT approve plans, issue
action tokens, consume destructive approvals, or accept an actor field. Approval
mutation authority belongs to the operator CLI. OpenCode's tool rendering and
permission prompts are the host-owned status and approval-request UI primitives.
Any identifier rendered into an operator command MUST first pass the domain ID
schema, and incomplete requests MUST NOT render shell-active placeholders.

## systemd adapter

GS-SD-1: The default unit path MUST be
`~/.config/systemd/user/cbranch-goal-supervisor.service`. The user unit
directory MUST be real, owner-only, and resolve within the configured unit
directory. The unit MUST be written through an owner-only temporary file and
atomic rename. The CLI MUST use this fixed unit name, so generating it for a
second workspace replaces the first definition rather than creating a second
service.

GS-SD-2: Generated arguments MUST use systemd quoting that escapes backslash,
double quote, dollar, and percent. Inputs MUST be absolute and free of control
characters; the OpenCode URL MUST be credential-free HTTP or HTTPS.

GS-SD-3: The implemented unit MUST include `Type=simple`, absolute Node and CLI
paths, workspace `WorkingDirectory`, `Restart=on-failure`, `RestartSec=5s`,
`UMask=0077`, `NoNewPrivileges=true`, private temporary/device settings,
strict system protection, kernel/control-group/namespace/SUID/personality and
capability restrictions, address families `AF_UNIX AF_INET AF_INET6`, and the
workspace as `ReadWritePaths`.

## Security and data layout

GS-SEC-1: The supported trust model is one trusted local user. It MUST NOT claim
safety against the same user, same-user processes, workspace writers, ptrace or
process inspection, a compromised OpenCode process, filesystem administrators,
or root.

GS-SEC-2: The control directory MUST be `0700` and its token MUST be an
owner-owned regular `0600` file on POSIX. SQLite database, WAL, SHM, daemon lock,
backup, and systemd unit permissions MUST be hardened to `0600` where supported.

GS-SEC-3: The control token authenticates local transports but does not authorize
sensitive goal actions by itself. Scoped action tokens MUST enforce plan-start,
resume, recovery, budget, and destructive policy as specified.

GS-SEC-8: The local MCP process MUST validate its out-of-band workspace token
before registering handlers. MCP tool schemas MUST omit that transport token so
model-authored arguments cannot replace or disclose it. The stdio child process,
its launcher, and same-user process access remain within the trusted-local threat
boundary; this is not remote-client authentication.

GS-SEC-4: The OpenCode plugin is trusted code executing in the OpenCode process.
Operators MUST review and pin it. Plugin event recording MUST NOT modify a host
permission decision.

GS-SEC-5: Approved agent and verifier execution is arbitrary user-authority
execution. Direct spawn, environment reduction, output redaction, workspace cwd
fencing, action tokens, and systemd hardening reduce risk but MUST NOT be
described as a complete sandbox.

GS-SEC-6: The package MUST NOT store transcript or artifact bodies. It MAY store
objectives, plans, compact outcomes, compact redacted verifier output, digests,
evidence/artifact/transcript/session pointers, observations, permission audit,
and errors. These records and backups MUST be treated as sensitive.

GS-SEC-7: The default OpenCode endpoint SHOULD be loopback. A non-loopback HTTP
endpoint is operator-selected and outside transport confidentiality guarantees;
operators SHOULD require HTTPS. The implemented adapter passes only `baseUrl`
and does not configure HTTP credentials or custom headers.

GS-DATA-1: Workspace state MUST live in
`.opencode/goal-supervisor/goal.db`, with normal SQLite `-wal` and `-shm` files.
The transport token MUST be `control.token`; the owner lock MUST be
`daemon.lock`; `daemon.lock.recovery` MAY exist only while serializing stale-lock
replacement. Transcript and artifact bodies MUST NOT be added to this layout.

GS-DATA-2: Store opening MUST enable foreign keys, WAL journal mode,
`synchronous=FULL`, and a 5,000 ms busy timeout before normal operation.

GS-DATA-3: Migrations MUST be transactional and monotonic in
`schema_migrations`. The implemented upgrader MUST infer the original prototype
tables as migration 1, apply durable schema migration 2, and apply migration 3.
Migration 3 MUST add `plan_id`, `runtime_status`, and `exit_code` verifier fields
and `last_error` and `observed_at` cancellation fields. A migration-2 final
verification row without `plan_id` MUST NOT satisfy active-plan finalization.

GS-DATA-4: Online backup MUST use SQLite's backup API, MUST reject the live
database as destination, and SHOULD checkpoint first. A plain copy of an active
WAL database MUST NOT be recommended.

GS-DATA-5: Integrity reporting MUST include `quick_check`, foreign-key check,
migration version, journal mode, synchronous setting, and passive WAL checkpoint
result. Corrupt stores SHOULD be preserved for diagnosis and restored from an
opened, integrity-checked backup.

## Test matrix

| Area | Required implementation coverage |
|---|---|
| Domain | Exhaustive state/action classification, terminal fencing, plan/start/resume/recovery/finalization guards, DAG and outcome schemas. |
| Store | Fresh, prototype, and migration-2 upgrades, append order, goal projection verify/rebuild, backup, command idempotency including reopen replay, immutable plans, dependency gating, approvals, evidence, finalization. |
| Recovery | Cross-connection exclusive claims, lease renewal fencing, outbox retries, probe outcomes across database reopen, stale delivery rejection, no post-dispatch requeue, pause/cancel fencing, and every budget threshold. |
| Verification | Exit policy, timeout, abort, output overflow, cwd escape, spawn error, credential redaction, deterministic digest, baseline comparison. |
| Supervisor | Dispatch boundary, ambiguous failure, all probe statuses, concurrency, active renewal, structured outcome, unit/final verification, cancellation, observation deduplication. |
| Daemon | Owner lock, stale replacement, token-safe release, startup reconciliation, scoped shutdown, checkpoint/close, active limits. |
| OpenCode adapter | Exact create/prompt shapes, restart idempotency, probe state, whole-text JSON, transcript pointer, abort, event filtering, client construction. |
| Control | Token modes and ownership, canonical workspace, bad auth, workspace fence, command replay, all scoped actions, public redaction, doctor and recovery. |
| CLI | Strict argv, no legacy transitions, validation before open, plan parse, full operator workflow, JSON redaction, systemd no-exec behavior, doctor exit, serve and MCP cleanup. |
| MCP/plugin | Exact tool catalog, out-of-band MCP auth, request-only model approvals, command replay, workspace fence, plugin restart, durable permission correlation, linked event audit, unchanged host permission decision. |
| systemd | Injection-safe quoting, absolute paths, hardening, atomic owner-only install, exact lifecycle commands, safe status inspection and symlink rejection. |
| Packaging | Packed required files, executable bin, bin mapping, root exports, plugin default export, MCP entry export. |

GS-TEST-1: Package changes MUST run package tests, production and test
typechecking, lint, and formatting checks. Changes to persistence, domain, or
recovery SHOULD include focused regression tests for restart and stale-lease
behavior.

GS-TEST-2: Release candidates MUST run
`pnpm --filter @cbranch/opencode-goal-supervisor pack:check` and the repository
quality gate on the reviewed commit.

## Packaging, release, and provenance

GS-REL-1: The package MUST follow Semantic Versioning. User-visible behavior,
compatibility changes, migration changes, and security-relevant changes MUST be
recorded in package `CHANGELOG.md`.

GS-REL-2: `package.json` version and `GOAL_SUPERVISOR_VERSION` exposed by MCP
MUST match. The pack verifier's expected artifact version MUST be updated in the
same release change.

GS-REL-3: Published files MUST be limited by the package manifest to `dist`,
`README.md`, `LICENSE`, and `CHANGELOG.md`. `prepack` MUST build the package. The
CLI bin and root, `opencode`, `mcp`, `daemon`, and `opencode-adapter` exports MUST
remain importable as declared.

GS-REL-4: `pack:check` MUST build and pack into temporary storage, verify
required runtime/declaration/document files, verify executable CLI and bin
mapping, import required root symbols, validate plugin and MCP exports, and
remove temporary files.

GS-REL-5: A release MUST originate from a reviewed Git tag and SHOULD be
published by the release operator with npm provenance. No claim of an automatic
publication workflow, package signature, SBOM, or auto-update mechanism may be
made unless separately implemented and verified.

GS-REL-6: Operators MUST pin exact versions, back up before upgrade, read the
changelog, stop daemon and state clients, let store opening apply migrations,
run doctor, and only then restore unattended service.

GS-REL-7: Node 20 and newer is the supported runtime declaration. Bun is not a
supported runtime. The OpenCode SDK MUST remain pinned to `1.17.18` for `0.1.0`,
and the plugin peer range MUST remain within `>=1.17.18 <1.18.0`. The real-server
fixture MUST be rerun with the exact target OpenCode binary before unattended
deployment; the repository fixture has passed against OpenCode `1.17.20`.

## Readiness and limitations

The implemented `0.1.0` changelog is unreleased. It is ready for controlled
evaluation and trusted-local supervised operation. It MUST NOT be represented as
a general production autonomy, distributed scheduling, or hostile multi-tenant
platform.

Unattended operation requires all of the following preconditions:

- Exact package and compatible OpenCode versions are tested on the target host.
- One trusted user owns the local workspace, daemon, control clients, and
  OpenCode process.
- The filesystem provides reliable SQLite WAL, process/file locking, ownership,
  atomic rename, and permission semantics.
- OpenCode is independently authenticated, secured, reachable, and configured
  with reviewed agent permissions.
- The operator reviews every plan, dependency, destructive flag, action token,
  verifier executable, argument, timeout, output cap, budget, and external side
  effect.
- Verified backups and restore practice exist, doctor is healthy, logs are
  monitored, and an operator can resolve non-happy-path states.
- Token limits are not treated as effective until adapter token accounting is
  integrated.
- Final verification is deterministic. The current daemon records a final
  requirement once per active plan and does not automatically rerun a recorded
  failed result.

Known limitations that MUST remain explicit:

- No multi-host ownership, distributed consensus, remote control API, or
  automatic failover.
- No hostile multi-user isolation and no defense against root, the same user,
  same-user processes, writable workspace compromise, or a compromised plugin or
  OpenCode server.
- No exactly-once guarantee for arbitrary external effects; ambiguity stops at
  `unknown-outcome` for operator reconciliation.
- No full process-tree sandbox, complete output secret detection, transcript
  retention, artifact storage, or referenced-evidence byte validation.
- No automatic token usage metering in the OpenCode adapter.
- No automatic rerun/reset control for a recorded failed final verification in
  `0.1.0`.
- No systemd enable/start/linger action during initialization.
