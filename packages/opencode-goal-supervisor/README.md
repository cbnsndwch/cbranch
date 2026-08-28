# OpenCode Goal Supervisor

`@cbranch/opencode-goal-supervisor` supervises approved OpenCode work from a
durable, workspace-local SQLite control plane. It validates plans, gates
operator actions with scoped tokens, dispatches lease-bound work to OpenCode,
runs declared verification commands, and recovers conservatively after process
or transport failure.

The supervisor is for one trusted local user on one host. It opens no listening
socket and is not a multi-host scheduler or a hostile multi-tenant security
boundary. See [Readiness](#readiness) before enabling unattended operation.

## Compatibility and installation

- Node.js 20 or newer is required.
- Standalone CLI, MCP, daemon, and package processes require Node. The TUI export
  is Bun-import-safe inside the pinned OpenCode host, but delegates every SQLite
  control operation to a verified Node child.
- The package version is currently `0.1.0`; its changelog still marks that
  version as unreleased.
- The OpenCode SDK is pinned to `1.17.18`.
- The OpenCode plugin peer range is `>=1.17.18 <1.18.0`.
- The real-server fixture has passed with the `1.17.18` SDK against OpenCode
  `1.17.20`. Release operators must rerun it against the exact target binary.
- Treat OpenCode versions outside that peer range as unsupported and test any
  OpenCode upgrade before unattended use.
- `better-sqlite3` is a native dependency and must install successfully for the
  target Node version and platform.
- Automatic daemon persistence from the operator TUI requires Linux, a working
  systemd user manager, and `systemctl --user`. On unsupported hosts the TUI
  workflow fails safely instead of falling back to an OpenCode-owned daemon.

For a published release, pin the exact package version. A project-local install
keeps the CLI, MCP server, and TUI plugin tied to the workspace lockfile:

```sh
pnpm add --save-dev --save-exact @cbranch/opencode-goal-supervisor@0.1.0
pnpm exec cbranch-goal-supervisor init
```

Until `0.1.0` is published, build it from this reviewed source tree:

```sh
pnpm install
pnpm --filter @cbranch/opencode-goal-supervisor build
node packages/opencode-goal-supervisor/dist/cli.js init
```

All examples below use `cbranch-goal-supervisor`. Prefix it with `pnpm exec` for
a project-local installation, or invoke the built `dist/cli.js` with Node in a
source checkout. Commands operate on the current directory unless the global
option `--workspace <path>` is supplied. The global `--json` option produces
machine-readable output.

## OpenCode setup

Manual `serve` talks to an existing OpenCode HTTP server. Its default URL is
`http://127.0.0.1:4096/`; that server must already be running, authenticated to
its model provider, and permitted to perform the approved work.

The TUI workflow is self-contained. OpenCode's TUI SDK exposes only the
in-process `http://opencode.internal/` client, which a persistent systemd daemon
cannot reach. After local `/goal` confirmation, the generated workspace service
therefore verifies the installed OpenCode `1.17.x` executable, starts a private
loopback headless OpenCode child on an OS-selected port, and connects the goal
daemon to it. The service supervises both processes and stops the child when the
daemon exits. If the TUI is explicitly configured with a reachable HTTP or HTTPS
URL, the service uses that server instead and does not start another OpenCode
process.

The managed unit supplies a bounded executable path and grants write access only
to the workspace plus the user's resolved OpenCode data and cache directories.
This is required for sessions, credential refresh, logs, package cache, and the
configured Node MCP process under `ProtectSystem=strict`.

### Model-facing tools

OpenCode 1.17 runs server plugins under Bun, which cannot load this package's
native `better-sqlite3` control plane. Configure the Node stdio MCP process
described below instead of adding the `./opencode` export to `opencode.json`.
The source checkout uses this configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "goal-supervisor": {
      "type": "local",
      "command": [
        "node",
        "packages/opencode-goal-supervisor/dist/cli.js",
        "--workspace",
        ".",
        "mcp"
      ],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

The MCP process exposes these model-facing tools:

`goal_create`, `goal_list`, `goal_plan`, `goal_status`, `goal_start`,
`goal_pause`, `goal_resume`, `goal_cancel`, `goal_approve`, `goal_inspect`,
`goal_recover`, `goal_raise_budget`, and `goal_doctor`.

The Node child injects the workspace control credential internally. OpenCode
renders the MCP tools with its host-owned tool UI and retains ownership of
permission prompts. `goal_status` provides the durable status view.
`goal_approve` is intentionally an approval-request view: it prints the exact
operator CLI command but cannot approve a plan, issue an action token, or consume
a destructive approval. This prevents self-approval through model-facing tool
arguments. Model-facing approval mutations remain unavailable; operators use
the CLI or the separate local TUI confirmation flow described below.

### Operator TUI plugin

Declare the TUI target separately in project `.opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@cbranch/opencode-goal-supervisor/tui"]
}
```

The TUI-only package export is
`@cbranch/opencode-goal-supervisor/tui`. It registers these OpenCode
autocomplete commands and does not register model tools:

- `/goal` opens the local operator launch dialog.
- `/goal-status` opens a read-only workspace and daemon status view.
- `/goal-daemon-stop` stops only this workspace's TUI-managed systemd user unit.

`/goal` takes no inline arguments. It prompts locally for a path and reads
exactly one canonical workspace-confined file. The file must be a regular,
non-symlink UTF-8 Markdown file no larger than 1 MiB; the path must not escape
through a symlink. The document must contain exactly one fenced code block whose
info string is exactly `goal-plan`; its body is a JSON plan in the shape shown
below. The block is parsed with the strict plan schema; unknown fields, malformed
JSON, duplicate object keys, invalid dependencies, and cyclic graphs are
rejected. Before launch, a local `DialogConfirm` shows the objective, unit count,
canonical file path, and SHA-256 digest of the raw file bytes.

Only that local confirmation launches the goal through the supported TUI flow.
It is the operator approval boundary for one atomic create, propose,
plan-approve, and unattended-start transaction. This is the narrow exception to
the otherwise separate approval and start workflows below. It never approves a
destructive work unit; each such materialized unit still requires its own scoped
approval.

An HTTP-dispatched `/goal` command may open the dialog, but HTTP input cannot
supply the path or confirmation and dispatch payload fields are ignored. The
path and approval come only from local dialog callbacks, and invoking the
command sends no model prompt.

The launch idempotency key derives from the canonical workspace, canonical file
path, normalized validated plan, and actor. Retrying the same confirmed launch,
including after formatting-only Markdown or JSON changes, replays the durable
result rather than creating another goal. To intentionally run the same semantic
plan as a new goal, review it under a new canonical plan-file path.

After either the atomic commit or its replay, the TUI ensures a persistent,
hardened systemd user service dedicated to that canonical workspace. A service
bootstrap failure does not roll back the durable executing goal; retrying the
same launch replays the goal transaction and retries daemon bootstrap. The
service survives OpenCode restarts. Disposing the TUI unregisters its commands
and does not stop the service. Persistent success is reported only when that
verified unit owns a ready daemon. Independently managed daemons are never killed;
they produce an actionable bootstrap error and leave the committed goal available
for the same idempotent retry.
When OpenCode starts with an executing durable goal, the TUI
reconciles the service with the current local OpenCode URL so work resumes after
the host restart. A token-bound readiness marker prevents launch success from
being reported before startup reconciliation finishes. The marker also binds the
running process to the exact generated service configuration, so a failed reload
or restart is retried rather than mistaken for a completed rollout.

The normal OpenCode TUI client URL is in-process-only. In that case the same
workspace service automatically starts and supervises a verified headless
OpenCode child on loopback, then starts the goal daemon against its selected
port. `/goal` does not require a separately started `opencode serve` process.
The child reads the normal OpenCode configuration and credentials for the user;
operators must still configure reviewed agent permissions appropriate to the
approved plan. The loopback listener remains inside the trusted-local threat
model and is not a remote control surface for the supervisor.

The Bun-hosted TUI never imports the SQLite store and never receives the control
token. Each init, list, or launch operation is one strict, bounded JSON request
to a short-lived verified Node 20+ child. The child loads the token internally,
closes SQLite before exiting, and returns a schema-validated token-free result.
If a launch child times out after mutation begins, the result is potentially
committed; confirming the same snapshot again resolves that outcome through the
same idempotency key.

This trusted-local design deliberately treats unrestricted shell/process
execution as operator authority. A model granted arbitrary shell access can call
the private bridge or the public approval CLI directly, so the dialog is not a
cryptographic human-presence proof against such a model. Do not grant arbitrary
shell execution unless that authority is intended. The enforced separation is
that MCP tool arguments and HTTP TUI command payloads cannot approve or confirm.

A typical handoff is:

1. Ask the planning agent to write `.local/plans/<name>.md` and include exactly
   one structured block among its review notes.
2. Select `/goal`, enter that relative path in the local dialog, and review the
   objective, unit count, path, and digest.
3. Confirm once to create, approve, and start that exact snapshot.

````markdown
# Reviewed implementation plan

Human-readable rationale may surround the structured plan.

```goal-plan
{
  "objective": "Implement and verify the reviewed change",
  "authoredBy": "planner",
  "units": [
    {
      "id": "implement",
      "title": "Implement the change",
      "instructions": "Follow the reviewed design and run its checks.",
      "dependencyIds": [],
      "acceptanceCriteria": ["The reviewed behavior is implemented"],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": []
}
```
````

### MCP

The package also provides a local stdio MCP server. For a project-local install:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "goal-supervisor": {
      "type": "local",
      "command": [
        "pnpm",
        "exec",
        "cbranch-goal-supervisor",
        "--workspace",
        ".",
        "mcp"
      ],
      "cwd": ".",
      "enabled": true
    }
  }
}
```

The MCP server exposes the same goal operations except event hooks and direct
approval authority. Its exact tool set is `goal_create`, `goal_list`, `goal_plan`, `goal_status`,
`goal_start`, `goal_pause`, `goal_resume`, `goal_cancel`, `goal_approve`,
`goal_inspect`, `goal_recover`, `goal_raise_budget`, and `goal_doctor`.

MCP uses stdio, not a network listener, and authenticates out of band. The CLI
loads `.opencode/goal-supervisor/control.token`, validates it while constructing
the MCP handlers, and injects it only at the internal control boundary. MCP tool
schemas do not contain `authToken`, so a model cannot replace it and normal tool
transcripts do not capture it. A library embedding `runGoalMcp` must similarly
supply the workspace token as the second function argument rather than as tool
input. Process ownership and permission to launch the local stdio command are
part of the trusted-single-user transport boundary. Mutating requests may supply
`commandId`; the MCP edge generates one when omitted.

MCP `goal_approve` only renders the operator-only CLI
instruction. It cannot mutate approval state or issue tokens.

Run a standalone MCP process with:

```sh
cbranch-goal-supervisor --workspace /absolute/workspace mcp
```

Keep stdout reserved for MCP framing. Diagnostics and process failures go to
stderr.

## Initialize a workspace

```sh
cbranch-goal-supervisor init
```

`init` canonicalizes the workspace path, creates
`.opencode/goal-supervisor/`, creates or validates the control token, opens the
database, and applies migrations. Re-running it preserves the existing token
and state.

On POSIX systems, the control directory must be a real owner-owned `0700`
directory and the token must be a regular owner-owned `0600` file. A redirected
control directory or token symlink is rejected.

## Write and approve a plan

A plan is immutable after creation. Unit IDs and verification IDs must be unique,
dependencies must name units in the same acyclic plan, and every unit needs at
least one acceptance criterion. The validator also rejects the simple
contradiction pair `must X` and `must not X`, case-insensitively.

Example `plan.json`:

```json
{
  "objective": "Prepare a verified release candidate",
  "authoredBy": "operator",
  "units": [
    {
      "id": "prepare-release",
      "title": "Prepare the release",
      "instructions": "Implement the approved release preparation changes.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Release metadata is internally consistent",
        "The package tests pass"
      ],
      "verificationRequirements": [
        {
          "id": "package-tests",
          "type": "command",
          "executable": "pnpm",
          "args": ["test"],
          "timeoutMs": 600000,
          "outputCapBytes": 1048576,
          "expectedExitCode": 0,
          "required": true
        }
      ],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": [
    {
      "id": "package-build",
      "type": "command",
      "executable": "pnpm",
      "args": ["build"],
      "timeoutMs": 600000,
      "outputCapBytes": 1048576,
      "expectedExitCode": 0,
      "required": true
    }
  ]
}
```

Create a goal and propose its first plan in one command:

```sh
cbranch-goal-supervisor --json plan \
  --objective "Prepare a verified release candidate" \
  --file plan.json
```

Goal creation and plan proposal are separate durable transactions inside this
CLI workflow. If schema or graph validation rejects the proposal, the new draft
goal remains and can receive a corrected plan. The confirmed operator TUI
workflow is the explicit exception: it atomically creates, proposes, approves,
and authorizes unattended start.

The JSON output contains `createdGoal.id` and `plan.id`. To propose a revision
for an existing `needs-replan` goal, use its ID instead of `--objective`:

```sh
cbranch-goal-supervisor plan <goal-id> --file revised-plan.json
```

Only the newest proposal can be approved. A revision must name the current
active plan as its parent, which the store assigns automatically.

```sh
cbranch-goal-supervisor approve <goal-id> approve-plan \
  --plan-id <plan-id> --actor operator
```

Approval materializes the plan units and moves `draft` or `needs-replan` to
`ready`. In this CLI workflow it does not start execution.

## Start approval workflow

For the standalone CLI workflow, starting is deliberately a separate, two-step
token operation. First issue a short-lived action token:

```sh
cbranch-goal-supervisor --json approve <goal-id> issue-start \
  --actor operator --reason "Run the reviewed plan" --ttl-ms 900000
```

Capture the `actionToken` from that command and consume it once:

```sh
cbranch-goal-supervisor start <goal-id> --approval-token <action-token>
```

The token is random, stored only as a SHA-256 hash, bound to the goal and
`unattended-start` action, expires at its declared TTL, and is single-use. It is
shown only when first issued. Replaying the same idempotent issuance command can
return the approval record but cannot reveal the token again. Protect terminal
scrollback and automation logs that receive action tokens. The default TTL is 15
minutes and the maximum is 365 days. Each CLI invocation generates a new command
ID, so rerunning the CLI issuance command creates a distinct approval rather than
replaying the prior one.

`start` changes `ready` to `executing`. A separate daemon must be running to
claim and dispatch work.

## Operate goals

List goals or show one goal with its active plan and budget usage:

```sh
cbranch-goal-supervisor status
cbranch-goal-supervisor status <goal-id>
cbranch-goal-supervisor --json status <goal-id>
```

Pause immediately fences new dispatch, retires pending delivery, marks active
attempts cancelled, queues unfinished units, and creates durable cancellation
requests for work that may have reached OpenCode:

```sh
cbranch-goal-supervisor pause <goal-id> --reason "Operator inspection"
```

Resume a paused goal with a fresh scoped token:

```sh
cbranch-goal-supervisor --json approve <goal-id> issue-resume \
  --reason "Inspection complete"
cbranch-goal-supervisor resume <goal-id> --approval-token <action-token>
```

Cancel terminally fences the goal and cancels queued and active units:

```sh
cbranch-goal-supervisor cancel <goal-id> --reason "Goal withdrawn"
```

Only `achieved` and `cancelled` are terminal. There is no direct transition
command; policy-specific operations are required.

## Destructive work

A unit with `"destructive": true` is not claimable after the plan starts until
that exact materialized work unit is approved. Retrieve the generated
`workUnit.id` with MCP `goal_inspect`, then issue and consume a
work-unit-scoped token:

```sh
cbranch-goal-supervisor --json approve <goal-id> issue-destructive \
  --work-unit-id <work-unit-id> \
  --reason "Reviewed destructive effects"
cbranch-goal-supervisor approve <goal-id> approve-destructive \
  --work-unit-id <work-unit-id> \
  --approval-token <action-token>
```

Plan approval is not destructive approval. Mark every unit that can delete,
publish, deploy, rotate credentials, mutate remote state, or otherwise create
irreversible effects as destructive.

## Budgets

The default budget for each goal is:

| Limit | Default | Automatic accounting |
|---|---:|---|
| Attempts | 20 | Incremented when a unit attempt is claimed. |
| Wall clock | 24 hours | Added when an attempt reports an outcome. |
| Verification | 1 hour | Added from recorded verifier durations. |
| Tokens | 1,000,000 | Persisted and enforced, but not metered by the current OpenCode adapter. |

The scheduler checks all limits before each claim. Exhaustion moves an executing
goal to `blocked`. Status reports usage and limits.

MCP `goal_create` accepts an optional complete `budget` object. Raising
an existing budget requires every new limit to be at least its current value and
uses a two-step token workflow:

```sh
cbranch-goal-supervisor --json approve <goal-id> issue-budget \
  --reason "Reviewed additional execution allowance"
```

Then call MCP `goal_raise_budget` with this payload. MCP transport
authentication is injected by the local MCP process and is not a tool field:

```json
{
  "goalId": "<goal-id>",
  "approvalToken": "<action-token>",
  "budget": {
    "maxAttempts": 30,
    "maxWallClockMs": 129600000,
    "maxVerificationMs": 7200000,
    "maxTokens": 1500000
  }
}
```

The CLI currently issues the budget token but has no standalone budget mutation
command. Do not rely on `maxTokens` as a safety control until the selected
adapter or an integrating library records token usage.

## Non-happy-path recovery

### Blocked

`blocked` is entered for an explicit blocked outcome, dependency or budget
classification, or exhausted budget after higher-priority external-ambiguity and
credential/permission classifications are considered. Correct the cause first.
Raise the budget if applicable, then use the blocked-specific token:

```sh
cbranch-goal-supervisor --json approve <goal-id> issue-blocked-resume \
  --reason "Dependency restored"
cbranch-goal-supervisor resume <goal-id> --approval-token <action-token>
```

Failed active-plan units are queued again on resume.

### Awaiting decision

Credential and permission classifications enter `awaiting-decision`. Resolve
the external credential or permission question, record the operator's decision
outside the supervisor as required by local policy, then issue `issue-resume`
and run `resume`. OpenCode permission event records are audit observations; they
do not authorize a supervisor resume by themselves.

### Needs replan

An explicit `needs-replan` outcome, contradictory criteria, three attempts with
the same failure fingerprint, or two unchanged material-change digests without
verification improvement enters `needs-replan` unless a higher-priority
unknown, decision, or blocked classification applies. Submit a revised plan for
the same goal, approve its newest revision, issue a new start token, and run
`start`. Only units belonging to the new active plan are scheduled.

### Unknown outcome

`unknown-outcome` means an external effect may have occurred and automatic retry
could duplicate it. Inspect the OpenCode session and all external systems before
choosing a target. Issue a recovery token, then record an explicit decision:

```sh
cbranch-goal-supervisor --json approve <goal-id> issue-recovery \
  --reason "External state reconciled"
cbranch-goal-supervisor recover <goal-id> \
  --target paused \
  --approval-token <action-token> \
  --decision "Operator confirmed that no publish completed"
```

Allowed targets are `ready`, `executing`, `paused`, `needs-replan`,
`awaiting-decision`, `blocked`, and `cancelled`. Recovery to `executing` can
queue the unknown unit for another attempt. Recovery to `ready` still requires
a new start token before scheduling. Never choose either target until duplicate
external effects are safe.

An attempt lease that expires before any external dispatch boundary may be
requeued if the goal remains viable. An attempt that expires after dispatch
started or an external reference was recorded becomes `unknown-outcome` and is
never automatically requeued.

## Run the daemon

For manually managed or non-TUI operation, run one execution owner per
workspace:

```sh
cbranch-goal-supervisor serve \
  --opencode-url http://127.0.0.1:4096/ \
  --global-concurrency 4 \
  --workspace-concurrency 2
```

Supported tuning options are `--dispatch-interval-ms`,
`--reconciliation-interval-ms`, `--cancellation-interval-ms`, and
`--observation-restart-interval-ms`. Defaults are 1000, 1000, 500, and 1000 ms.
The default active-attempt limits are four globally within this daemon and two
for its single workspace. Dispatch and reconciliation adapters default to one
concurrent call each.

Despite its name, `serve` opens no port. It owns a workspace lock, opens SQLite,
and makes outbound HTTP or HTTPS and SSE calls to the configured OpenCode URL.
A second daemon with a matching live Linux boot-and-start-time process identity is
rejected. A reused PID is stale. Legacy or incomplete records, and records whose
live identity cannot be read, fail closed without deleting a potentially live
owner. A stale lock can be replaced only after identity validation and unchanged
lock contents. Lock
publication uses a fully written candidate inode, and stale replacement is
serialized by a separate recovery guard so concurrent restarts cannot both
become owners. If a process dies during that narrow replacement section, doctor
reports the leftover `daemon.lock.recovery` guard as invalid. Inspect the lock,
guard, PID, and workspace before manually removing the guard; it is never
silently reclaimed.

At startup the daemon reconciles expired leases, processes durable cancellation,
and inspects linked sessions before normal scheduling. On `SIGINT` or `SIGTERM`,
Effect scopes interrupt loops, process pending cancellations within the shutdown
bound, checkpoint SQLite, close the store, and release the matching lock token.
Active external sessions are not blindly terminated at daemon shutdown; the
next owner reconciles their durable references and leases.

### TUI-managed systemd user service

After a confirmed `/goal` transaction commits or replays, the TUI installs,
reloads, enables, and starts a hardened persistent systemd user service with an
identity dedicated to the canonical workspace. `/goal-status` only reads its
state. `/goal-daemon-stop` acts through systemd and targets only that exact
TUI-managed unit; it does not signal a lock-holder or kill an independently
managed `serve` process. Closing or restarting OpenCode ends the TUI bridge
client but leaves the service running. On the next OpenCode start, any
executing durable goal causes the TUI to update and restart its managed service
with the current OpenCode URL.

Lifecycle mutations are serialized with a workspace-local interprocess lock.
The manager verifies the loaded systemd `FragmentPath`, disables only its own
verified unit when an independent daemon owns the workspace, and does not
rewrite or restart an unchanged ready service.

Automatic persistence requires Linux with a functioning systemd user manager
and `systemctl --user`. Unsupported hosts and unavailable user managers fail
safely and do not fall back to a process owned by the TUI. Because service
bootstrap happens after the durable goal transaction, a bootstrap error leaves
the goal intact and a retry retries the bootstrap. Persistence after logout
still depends on host policy and login lingering; the package does not enable
lingering.

### Manual CLI systemd user service

Generate a hardened user unit while initializing:

```sh
cbranch-goal-supervisor init --systemd \
  --opencode-url http://127.0.0.1:4096/
```

This writes `~/.config/systemd/user/cbranch-goal-supervisor.service` atomically
with mode `0600`. It records absolute Node, CLI, and workspace paths, uses
`UMask=0077`, `Restart=on-failure`, `NoNewPrivileges`, `ProtectSystem=strict`,
and a workspace `ReadWritePaths` allowance. The CLI always uses this fixed unit
name; generating it for another workspace replaces the existing definition.

`init --systemd` does not run `systemctl`, does not enable the service, and does
not start it. The operator chooses the lifecycle commands:

```sh
systemctl --user daemon-reload
systemctl --user enable cbranch-goal-supervisor.service
systemctl --user start cbranch-goal-supervisor.service
systemctl --user status cbranch-goal-supervisor.service
systemctl --user stop cbranch-goal-supervisor.service
systemctl --user disable cbranch-goal-supervisor.service
```

This fixed-name unit is the manual CLI path and is separate from per-workspace
TUI-managed units. User-manager persistence after logout depends on host policy
and login lingering; the package does not enable lingering.

## Doctor and integrity recovery

```sh
cbranch-goal-supervisor doctor
cbranch-goal-supervisor --json doctor --recover
```

`doctor` checks SQLite `quick_check`, foreign keys, migration version, WAL mode,
the goal lifecycle projection, database and token permissions, daemon lock
status, and OpenCode health. It exits zero only when all checks are healthy.

`doctor --recover` is mutating. It runs startup lease reconciliation for expired
attempt and outbox leases before reporting. It does not retry an unknown external
effect, rebuild projections, repair SQLite corruption, or delete a stale lock.
Prefer to stop the daemon before operator-directed recovery.

If only the goal projection is mismatched, the library exposes
`verifyProjections()` and `rebuildProjections()`:

```js
import { GoalStore } from "@cbranch/opencode-goal-supervisor";

const store = new GoalStore("/absolute/workspace/.opencode/goal-supervisor/goal.db");
try {
  if (!store.verifyProjections().ok) {
    store.rebuildProjections();
  }
} finally {
  store.close();
}
```

Back up first. Rebuild replays the latest valid goal snapshot from the monotonic,
append-only `goal_events` log into only the `goals` lifecycle projection. Plans,
work units, attempts, approvals, command and observation inboxes, outbox delivery
history, evidence, verification results, budgets, cancellation requests, and
session references remain durable source records and are not reconstructed. Stop
the daemon and close MCP and TUI state users before operator-directed rebuild.

## Data, migrations, and backup

Workspace data is under `.opencode/goal-supervisor/`:

| Path | Purpose |
|---|---|
| `goal.db` | SQLite state, event log, plans, attempts, approvals, evidence pointers, verification summaries, inboxes, and outbox. |
| `goal.db-wal`, `goal.db-shm` | SQLite WAL files while connections are open. |
| `control.token` | Internal transport credential used by control surfaces. |
| `daemon.lock` | Live execution-owner PID, Linux process identity, workspace, creation time, random owner token, and optional service identity. |
| `daemon.lock.ready` | Token- and process-identity-bound readiness marker published after startup reconciliation. |
| `daemon.lock.recovery` | Temporary stale-lock replacement guard; persistence means recovery was interrupted and requires operator inspection. |
| `daemon.lock.lifecycle` | Short-lived owner-token lock serializing TUI systemd lifecycle changes across OpenCode processes. |

The directory is `0700`; the token, database files, daemon lock, and readiness
marker are `0600` on POSIX filesystems. Database file hardening is best effort
where chmod semantics are unavailable. The generated systemd unit lives outside
this directory.

Opening the store applies transactional migrations recorded in
`schema_migrations`. The current database migration is version 3; the serialized
domain contract is independently version 1. The upgrader recognizes the earlier
prototype tables as migration 1 and upgrades them without requiring a manual
export. Migration 3 adds plan identity and process-runtime details to verifier
records plus cancellation reconciliation diagnostics. Existing migration-2
final-verification rows remain preserved but have no plan identity, so they are
conservatively ineligible to finalize an active plan and must be rerun.

For an upgrade:

1. Stop the workspace daemon and close MCP and OpenCode processes.
2. Create and verify a backup.
3. Install an exact reviewed package version and read `CHANGELOG.md`.
4. Run `init`, which opens the database and applies migrations.
5. Run `doctor` before restarting unattended service.

Do not copy a live WAL database with a plain file copy. Use the SQLite online
backup API exposed by `GoalStore`:

```js
import { GoalStore } from "@cbranch/opencode-goal-supervisor";

const store = new GoalStore("/absolute/workspace/.opencode/goal-supervisor/goal.db");
try {
  store.checkpoint("FULL");
  await store.backup("/secure/backups/workspace-goal.db");
} finally {
  store.close();
}
```

The backup destination is created owner-only where POSIX permissions apply. Open
the backup with `GoalStore`, run `integrityCheck()`, and confirm the expected
workspace and goals before accepting it. For corruption, stop all users of the
database, preserve the damaged database plus WAL and SHM files for diagnosis,
restore a verified backup as `goal.db`, enforce owner-only permissions, and run
`doctor` before service restart.

Backups are sensitive. They can contain objectives, instructions, approval audit
records, session references, evidence digests and locations, compact verifier
output, and external-system details. A database backup does not include
`control.token`; a whole-directory backup does.

## Agent outcome contract

The OpenCode adapter accepts an outcome only when the latest assistant message's
entire text is one JSON object accepted by `AgentOutcomeSchema`. Markdown fences,
leading prose, trailing prose, and partial JSON are rejected as inconclusive.

Example:

```json
{
  "schemaVersion": 1,
  "attemptId": "attempt-7f4c",
  "leaseToken": "lease-2a91",
  "status": "completed",
  "summary": "Release metadata was updated and the requested artifact was produced.",
  "evidenceRefs": [
    {
      "ref": "artifact:release-manifest-v1",
      "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ],
  "verificationRefs": [],
  "transcriptRef": "opencode-transcript:session-123",
  "artifactRefs": ["workspace:dist/release-manifest.json"],
  "materialChangeDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

Allowed statuses are `completed`, `failed`, `blocked`, `needs-replan`, and
`unknown-outcome`. `summary` is one printable line of at most 500 characters.
IDs and references are compact, whitespace-free strings. SHA-256 values use
lowercase hex and the literal `sha256:` prefix.

Rules for evidence and context:

- `attemptId` and `leaseToken` must match the current unexpired active lease.
- A completed outcome must have at least one `evidenceRefs` entry.
- Each evidence entry pairs a durable pointer with a digest of the referenced
  content; the supervisor stores the pair but does not fetch or validate the
  referenced bytes.
- `artifactRefs` are optional compact pointers, not embedded artifacts.
- The OpenCode adapter supplies `opencode-transcript:<encoded-session-id>` as the
  transcript pointer and replaces any model-supplied transcript value. The
  supervisor does not copy or store the transcript.
- Agents leave `verificationRefs` empty. The supervisor runs declared commands,
  stores their result IDs, and adds those IDs before accepting completion.
- A required verifier must pass for the same attempt and its result ID must be
  referenced by the final outcome.
- Arrays of evidence, verification, and artifact references are capped at 64;
  each compact reference is capped at 512 characters.
- The dispatch prompt contains only the attempt and lease IDs, the current unit
  title and instructions, its acceptance criteria, and the compact JSON
  contract. It deliberately omits prior transcripts and unrelated goal context.
- Durable state, not conversational memory or `session.idle`, determines what
  runs and whether work is accepted.

Failure reports should include a stable `failureFingerprint` when repeated root
causes should trigger replanning, a `materialChangeDigest` when progress can be
compared across attempts, and one of `credentials`, `permission`, `dependency`,
`budget`, `contradictory-criteria`, `external-ambiguity`, `verification`, or
`other` as `issueClassification` when applicable.

## Verification safety

Verification requirements are approved plan data, but they are still arbitrary
program execution under the daemon user's authority.

- Commands are spawned directly with `shell: false`; `executable` and each
  argument are separate fields, and arguments cannot contain NUL or newlines.
- Plan-derived verification runs at the workspace root. The generic verifier
  rejects a `cwd` that resolves outside that root, including symlink escapes.
- Runtime timeout is 10 ms through 30 minutes; runtime combined output cap is 1
  byte through 8 MiB. Author plans within these effective limits even though the
  document schema permits larger maxima.
- Timeout, cancellation, and output overflow send `SIGKILL` to the direct child
  and wait for close. This is not a process-tree sandbox; a program that detaches
  descendants can outlive the direct child.
- Stdin is ignored. The environment starts from a small allowlist including
  `PATH`, `HOME`, and temporary-directory variables, adds non-interactive Git,
  pager, color, npm, and GitHub settings, and does not inherit arbitrary parent
  environment variables.
- Captured output is capped, redacted for common credential forms and explicit
  redaction values, then hashed. Redaction is best effort, not a data-loss
  prevention boundary.
- The durable result keeps a SHA-256 output digest and at most 4096 characters of
  compact output. Full verifier logs are not stored by this package.
- A timeout or output limit is inconclusive; cancellation and spawn failure are
  errors. Any required result other than passed converts completion into a
  verification-class failure.
- Final verification runs after all required units are accepted. Achievement
  requires every required final check to pass; with no required final checks,
  that condition is vacuously satisfied.

Review executable paths, arguments, dependency behavior, network access, and
side effects before plan approval. Neither direct spawning nor systemd hardening
makes an approved command safe.

## Durable dispatch model

- Every mutating control request has a `commandId`. The durable command inbox
  returns the original result for the same ID and request and rejects reuse with
  different content.
- Each claimed work attempt has a unique lease token, owner, number, and expiry.
  Stale workers cannot renew or settle it.
- Claiming work atomically creates an outbox command with stable idempotency key
  `attempt:<attempt-id>`.
- Delivery records a durable `dispatch.started` boundary before calling
  OpenCode. A failure explicitly known to precede external side effects may
  retry with exponential backoff. Any other call failure requires a probe.
- A probe that proves absence releases the same outbox command for safe retry.
  Active or completed probes record the existing OpenCode session. An unknown
  or failed probe retires dispatch and enters `unknown-outcome`.
- OpenCode sessions are found by the exact title
  `Goal Supervisor | attempt:<attempt-id>`. Dispatch creates at most one prompt
  for the earliest matching session and persists an encoded external reference.
  The prompt message ID is deterministically derived as
  `msg_goal_<first-32-hex-of-sha256(idempotency-key)>`, allowing the OpenCode
  boundary to coalesce a repeated prompt request.
- Linked sessions are reconciled by polling structured outcomes and optionally
  by deduplicated SSE observations. `session.idle` is recorded only as status;
  it never claims work or advances a goal.
- `goal_events` is append-only and locally sequence-ordered. Delivery attempts,
  command and observation inboxes, cancellation requests, session references,
  and outbox state survive process restarts.

## Security model

The intended boundary is a trusted local single user operating one workspace on
one host and local filesystem.

- The package opens no listener. MCP is stdio. Network activity from the
  supervisor is outbound to the operator-selected OpenCode HTTP or HTTPS URL and
  its event stream.
- The default OpenCode URL is loopback, but the CLI accepts any credential-free
  HTTP or HTTPS URL. The adapter configures only `baseUrl`, not HTTP credentials
  or custom headers. Use a trusted endpoint and require TLS where traffic leaves
  the host.
- The `0700` control directory and `0600` token/database files protect against
  other OS users only when filesystem ownership and mode enforcement are
  trustworthy.
- Control authentication does not defend against the same OS user, a process
  that can read the workspace, ptrace or inspect the process, a compromised
  OpenCode process, or root. Such actors can read credentials, alter the
  database, impersonate control clients, replace package code, or mutate work
  directly.
- Arbitrary shell/process access is operator-equivalent in this trust model. It
  can invoke private or public Node control entrypoints without using the TUI;
  model-facing MCP and HTTP surfaces remain request-only, but they are not a
  sandbox around separately granted shell authority.
- Action tokens provide explicit, scoped, expiring, one-time authorization on
  top of transport authentication. They do not make an untrusted control client
  safe after the token is disclosed.
- The TUI plugin is trusted code inside OpenCode. Review and pin it like any
  other code-executing dependency. OpenCode permissions still govern agent
  tools; the TUI does not answer or override host permission decisions.
- Approved agent work and verification commands can read or modify workspace
  files, invoke arbitrary programs, access credentials available to the user,
  perform network requests, and create irreversible external effects. The
  supervisor is a control plane, not a sandbox.
- The package stores transcript and artifact pointers, not transcript or
  artifact bodies. OpenCode and external systems retain their own data under
  their own security and retention policies.
- Error and verifier-output redaction is bounded and pattern-based. Secrets can
  still appear in objectives, plans, evidence locations, external systems,
  detached child processes, or values that evade redaction.
- Database and whole-directory backups inherit the sensitivity of all durable
  records and, for directory backups, the control credential.

Do not deploy this package as an internet service, across mutually untrusted
users, on shared writable state, or as a distributed/multi-host scheduler.

## Minimal single-unit operation

With `plan.json` containing one non-destructive unit:

```sh
cbranch-goal-supervisor init
cbranch-goal-supervisor --json plan \
  --objective "Make one verified change" --file plan.json
cbranch-goal-supervisor approve <goal-id> approve-plan --plan-id <plan-id>
cbranch-goal-supervisor --json approve <goal-id> issue-start \
  --reason "Run the reviewed unit"
cbranch-goal-supervisor start <goal-id> --approval-token <action-token>
cbranch-goal-supervisor serve --opencode-url http://127.0.0.1:4096/
```

Run `serve` in a separate terminal before `start` if immediate dispatch is
desired. Follow progress with `status <goal-id>`.

## Manual unattended operation

Initialize and generate the unit, but leave lifecycle choice to the operator:

```sh
cbranch-goal-supervisor init --systemd \
  --opencode-url http://127.0.0.1:4096/
systemctl --user daemon-reload
systemctl --user enable cbranch-goal-supervisor.service
systemctl --user start cbranch-goal-supervisor.service
cbranch-goal-supervisor doctor
```

The daemon can run before goals exist. It schedules only goals that have an
approved plan, an explicitly authorized unattended start, viable budget,
satisfied dependencies, and any required destructive-unit approval. In this
manual workflow authorization is the consumed start token; in the TUI workflow
it is the local confirmation committed in the atomic launch transaction.

## Packaging and release policy

- The package follows Semantic Versioning and records user-visible behavior,
  compatibility, migrations, and security changes in `CHANGELOG.md`.
- `package.json`, the exported MCP server version, and release notes must carry
  the same version.
- Releases are built from a reviewed Git tag. No automatic updater is included;
  operators pin and deliberately upgrade the package.
- The release operator publishes the reviewed npm artifact with npm provenance.
  The repository currently contains no automatic publication workflow, package
  signature, or SBOM claim beyond npm provenance.
- `prepack` builds TypeScript. The package contains `dist`, `README.md`,
  `LICENSE`, and `CHANGELOG.md` and publishes the CLI plus root, Node-hosted
  plugin, MCP, daemon, TUI, and OpenCode adapter exports.

Before tagging or publishing, run:

```sh
CBRANCH_NODE20_BIN=/absolute/path/to/node-20 \
CBRANCH_OPENCODE_BIN=/absolute/path/to/opencode \
CBRANCH_BUN_BIN=/absolute/path/to/bun \
CBRANCH_SYSTEMD_QUALIFY=1 \
pnpm --filter @cbranch/opencode-goal-supervisor qualify:host
```

This release-only command is fail-closed: every required external runtime must
be explicitly selected, and its one-line JSON summary identifies the reviewed
commit, package, platform, runtime versions, and each outcome. It never reports
an unavailable Node 20, OpenCode, Bun, or systemd check as passing.

`pack:check` creates the tarball, installs it into an isolated temporary consumer,
verifies runtime and declaration files, version/compatibility metadata and the
executable CLI bin mapping, imports every public entry through package-name
resolution including `./tui`, validates its TUI-only default export, opens an
in-memory store, verifies that the TUI import closure cannot reach the native
store, executes the installed `.bin`, and removes its temporary files.
Also run the repository quality gate for the reviewed commit.

## Readiness

Version `0.1.0` is currently unreleased. Treat it as suitable for controlled
evaluation and trusted-local supervised operation, not as a general production
autonomy platform. Unattended use is recommended only when every precondition
below is true:

- The exact package and compatible OpenCode versions have been tested together
  on the target host.
- Automatic TUI persistence is used only on Linux with a tested systemd user
  manager and `systemctl --user`; unsupported hosts are expected to fail safely.
- The workspace is on a reliable local filesystem with trustworthy ownership,
  locking, WAL, and chmod behavior.
- One trusted OS user owns the workspace, control files, OpenCode process, and
  daemon; root and same-user process compromise are out of scope.
- OpenCode is independently secured, provider-authenticated, reachable, and
  configured with permissions appropriate for every approved unit.
- An operator has reviewed the plan DAG, acceptance criteria, destructive flags,
  verifier executables, arguments, timeouts, output limits, network effects, and
  budgets.
- Token limits are not relied on until adapter metering is integrated.
- Final verification commands are deterministic. A recorded failed final check
  is not automatically rerun in `0.1.0`; use library-level intervention or
  cancel the goal rather than assuming a daemon retry.
- Backups have been created, opened, and integrity-checked, and restore steps
  have been rehearsed.
- `doctor` is healthy, daemon and OpenCode logs are monitored, and an operator is
  available to resolve `blocked`, `awaiting-decision`, `needs-replan`, and
  `unknown-outcome` states.

The design makes no claim of distributed consensus, multi-host failover, hostile
multi-tenant isolation, complete secret redaction, arbitrary-command sandboxing,
or exactly-once external side effects.
