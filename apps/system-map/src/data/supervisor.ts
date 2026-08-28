import type { ArchitectureScene } from '../types';
import { citation } from './shared';

export const supervisorScene: ArchitectureScene = {
    id: 'supervisor',
    label: 'OpenCode goal supervisor',
    shortLabel: 'Supervisor',
    description:
        'An adjacent publishable package turns operator-approved plans into leased, idempotent OpenCode attempts, verifies evidence, and advances durable goal state.',
    scope: 'Independent tooling package at HEAD · not part of cbranch Git RPC',
    defaultNodeId: 'goal-daemon',
    nodes: [
        {
            id: 'operator',
            label: 'Operator / model',
            eyebrow: 'Human authority + tool caller',
            kind: 'external',
            group: 'Control ingress',
            position: { column: 0, row: 1 },
            height: 58,
            summary:
                'Creates goals and plans; sensitive approvals remain operator-only.',
            description:
                'Humans and model sessions can inspect and request control operations, but plan, destructive, recovery, and budget authority are fenced through scoped tokens or explicit external CLI steps.',
            responsibilities: [
                'Author goal and plan intent',
                'Confirm local plan launch',
                'Issue approvals outside model-facing tools',
            ],
            builtWith: ['CLI', 'OpenCode tool UI', 'MCP client'],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/mcp.ts',
                    119,
                    'Operator-only approval instruction',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'control-surfaces',
            label: 'CLI · TUI · MCP · host plugin',
            eyebrow: 'Four local control surfaces',
            kind: 'app',
            group: 'Control ingress',
            position: { column: 1, row: 1 },
            height: 86,
            width: 112,
            summary:
                'Four entry surfaces converge on one authenticated control service.',
            description:
                'The Node CLI handles lifecycle commands; the Bun-safe TUI confirms plans through a Node stdio bridge; the MCP server and OpenCode host plugin expose tools while injecting the internal auth token at trusted boundaries. The host plugin also records session observations and permission decisions.',
            responsibilities: [
                'Parse and validate user-facing requests',
                'Inject command IDs and transport credentials at trusted edges',
                'Keep storage and process operations out of the TUI runtime',
            ],
            builtWith: [
                'Node CLI',
                'OpenCode TUI plugin',
                'MCP stdio SDK',
                'OpenCode host plugin',
                'Zod',
            ],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/cli.ts',
                    55,
                    'CLI command catalog',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/tui.ts',
                    227,
                    'Confined plan launch',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/mcp.ts',
                    138,
                    'MCP transport edge',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/opencode.ts',
                    263,
                    'OpenCode host plugin',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'control-service',
            label: 'GoalControlService',
            eyebrow: 'Authenticated command boundary',
            kind: 'service',
            group: 'Control plane',
            position: { column: 2, row: 1 },
            height: 94,
            width: 116,
            summary:
                'Strictly validates and idempotently applies interactive state changes.',
            description:
                'All mutating control requests carry an auth token and commandId. The control layer validates Zod records and uses the store command inbox to replay identical retries without duplicating side effects.',
            responsibilities: [
                'Authenticate local transport requests',
                'Validate command payloads and approval scopes',
                'Apply idempotent store transactions',
            ],
            builtWith: [
                'Zod strict schemas',
                'Command inbox',
                'GoalStore transactions',
            ],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/control.ts',
                    580,
                    'Control boundary',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/store.ts',
                    1483,
                    'Idempotent command execution',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'goal-db',
            label: 'Goal SQLite database',
            eyebrow: 'WAL · synchronous FULL',
            kind: 'database',
            group: 'Durable state',
            position: { column: 3, row: 2 },
            height: 54,
            width: 114,
            summary:
                'The authoritative goal, plan, attempt, evidence, and approval store.',
            description:
                'A hardened better-sqlite3 database stores the complete durable state machine, with foreign keys, WAL, full synchronization, migrations, leases, append-only events, command replies, and recovery metadata.',
            responsibilities: [
                'Persist goals, plans, work units, attempts, and budgets',
                'Persist outbox delivery and external session references',
                'Persist evidence, verifications, approvals, and observations',
            ],
            builtWith: ['better-sqlite3', 'Foreign keys', 'WAL', '0600 files'],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/store.ts',
                    427,
                    'Database setup',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/store.ts',
                    596,
                    'Durable schema',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'systemd-service',
            label: 'systemd user service',
            eyebrow: 'Persistent process owner',
            kind: 'service',
            group: 'Execution plane',
            position: { column: 2, row: 3 },
            height: 66,
            summary: 'Starts and restarts a workspace-specific serve process.',
            description:
                'The package writes an owner-only, canonical user unit and controls it through direct systemctl --user argument vectors. ExecStart runs the packaged Node CLI serve command for one workspace and OpenCode URL.',
            responsibilities: [
                'Persist daemon lifecycle across terminal sessions',
                'Own one workspace-specific unit',
                'Keep unit files non-symlinked and owner-only',
            ],
            builtWith: ['systemd --user', 'Owner-only unit file'],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/systemd.ts',
                    255,
                    'Safe unit installation',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/systemd.ts',
                    202,
                    'Lifecycle operations',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'goal-daemon',
            label: 'GoalDaemon',
            eyebrow: 'Fenced persistent loop',
            kind: 'worker',
            group: 'Execution plane',
            position: { column: 4, row: 1 },
            height: 96,
            width: 108,
            summary:
                'Runs recovery, dispatch, reconciliation, cancellation, and observation loops.',
            description:
                'A workspace lock prevents duplicate daemons. After recovery, separate periodic loops use global and workspace semaphores to claim batches and call GoalSupervisor; shutdown is bounded and signal-aware.',
            responsibilities: [
                'Own the workspace execution lease',
                'Schedule independent durable loops',
                'Recover uncertain in-flight work after restart',
            ],
            builtWith: [
                'Effect Semaphore',
                'AbortSignal',
                'Filesystem owner lock',
            ],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/daemon.ts',
                    26,
                    'Daemon configuration',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/daemon.ts',
                    376,
                    'Workspace lock',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/daemon.ts',
                    883,
                    'Execution loops',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'durable-outbox',
            label: 'Durable outbox',
            eyebrow: 'SQLite-backed work queue',
            kind: 'queue',
            group: 'Durable state',
            position: { column: 4, row: 3 },
            height: 46,
            width: 108,
            summary:
                'Leased dispatch commands with probe-before-redelivery recovery.',
            description:
                'Eligible queued work materializes as a dispatch-attempt outbox row. Delivery records mark external-side-effect boundaries. Reclaimed uncertain rows probe deterministic session identity before any retry.',
            responsibilities: [
                'Decouple durable scheduling from external dispatch',
                'Lease work to one dispatcher',
                'Prevent blind duplicate OpenCode sessions after crashes',
            ],
            builtWith: ['SQLite rows', 'Lease tokens', 'Idempotency keys'],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/store.ts',
                    2958,
                    'Attempt + outbox creation',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/store.ts',
                    3526,
                    'Uncertain-delivery recovery',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'goal-supervisor-core',
            label: 'GoalSupervisor',
            eyebrow: 'Adapter-neutral coordinator',
            kind: 'service',
            group: 'Execution plane',
            position: { column: 5, row: 1 },
            height: 90,
            width: 112,
            summary:
                'Dispatches sessions, reconciles outcomes, runs verification, and finalizes goals.',
            description:
                'The coordinator leases durable work, probes or dispatches external sessions, validates returned attempt/lease identity, runs required verification commands, and reports normalized results back to the store.',
            responsibilities: [
                'Safely cross the external session side-effect boundary',
                'Reconcile active and completed session outcomes',
                'Run unit and final verifications before acceptance',
            ],
            builtWith: [
                'GoalSessionAdapter interface',
                'Bounded concurrency',
                'Store leases',
            ],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/supervisor.ts',
                    115,
                    'Session adapter boundary',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/supervisor.ts',
                    319,
                    'Supervisor construction',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'opencode-adapter',
            label: 'OpenCode adapter',
            eyebrow: 'Pinned SDK + SSE',
            kind: 'service',
            group: 'External adapter',
            position: { column: 6, row: 1 },
            height: 78,
            summary:
                'Maps idempotent attempts onto OpenCode sessions and messages.',
            description:
                'A deterministic session title and prompt message ID let probe locate earlier work. The adapter uses session list/create/status/messages/prompt/abort and consumes server-sent events for observations.',
            responsibilities: [
                'Probe session existence before uncertain retry',
                'Create and prompt exactly identified sessions',
                'Read outcomes and stream observations',
            ],
            builtWith: ['@opencode-ai/sdk', 'HTTP', 'SSE'],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/opencode-adapter.ts',
                    73,
                    'SDK boundary',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/opencode-adapter.ts',
                    561,
                    'Probe and dispatch',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'opencode-server',
            label: 'OpenCode server',
            eyebrow: 'External session system',
            kind: 'external',
            group: 'Outside process',
            position: { column: 7, row: 1 },
            height: 72,
            summary: 'Executes agent sessions and returns structured outcomes.',
            description:
                'At this HEAD the daemon connects to an explicitly supplied OpenCode URL. OpenCode owns model execution and transcripts; the supervisor owns durable intent, leases, evidence requirements, and acceptance policy.',
            responsibilities: [
                'Execute prompted work sessions',
                'Expose status, messages, abort, and event APIs',
                'Return the requested structured AgentOutcome',
            ],
            builtWith: ['OpenCode server API'],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/cli.ts',
                    1658,
                    'serve requires OpenCode URL at HEAD',
                ),
            ],
            status: 'adjacent',
        },
        {
            id: 'verification-runner',
            label: 'Verification runner',
            eyebrow: 'Bounded child process',
            kind: 'worker',
            group: 'Execution plane',
            position: { column: 6, row: 3 },
            height: 64,
            summary: 'Executes declared commands directly, without a shell.',
            description:
                'The runner applies timeout, output caps, a controlled environment, noninteractive stdin, redaction, and shell:false. Its structured results become evidence references used by acceptance policy.',
            responsibilities: [
                'Run required unit and final verification commands',
                'Bound time and output',
                'Return redacted, digestible results',
            ],
            builtWith: [
                'node:child_process',
                'shell:false',
                'Output redaction',
            ],
            citations: [
                citation(
                    'packages/opencode-goal-supervisor/src/verification.ts',
                    34,
                    'Verification boundary',
                ),
                citation(
                    'packages/opencode-goal-supervisor/src/verification.ts',
                    387,
                    'Bounded spawn',
                ),
            ],
            status: 'adjacent',
        },
    ],
    edges: [
        {
            id: 'operator-surfaces',
            from: 'operator',
            to: 'control-surfaces',
            label: 'commands / tools / confirmation',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'surfaces-control',
            from: 'control-surfaces',
            to: 'control-service',
            label: 'validated local calls',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'control-db',
            from: 'control-service',
            to: 'goal-db',
            label: 'idempotent transactions',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'surfaces-systemd',
            from: 'control-surfaces',
            to: 'systemd-service',
            label: 'ensure workspace service',
            kind: 'spawn',
        },
        {
            id: 'systemd-daemon',
            from: 'systemd-service',
            to: 'goal-daemon',
            label: 'node cli.js serve',
            kind: 'spawn',
        },
        {
            id: 'daemon-db',
            from: 'goal-daemon',
            to: 'goal-db',
            label: 'recovery + claims',
            kind: 'filesystem',
            bidirectional: true,
        },
        {
            id: 'db-outbox',
            from: 'goal-db',
            to: 'durable-outbox',
            label: 'durable rows',
            kind: 'dependency',
            bidirectional: true,
        },
        {
            id: 'daemon-supervisor',
            from: 'goal-daemon',
            to: 'goal-supervisor-core',
            label: 'dispatch / reconcile batches',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'outbox-supervisor',
            from: 'durable-outbox',
            to: 'goal-supervisor-core',
            label: 'leased dispatch command',
            kind: 'stream',
        },
        {
            id: 'supervisor-adapter',
            from: 'goal-supervisor-core',
            to: 'opencode-adapter',
            label: 'session adapter calls',
            kind: 'call',
            bidirectional: true,
        },
        {
            id: 'adapter-opencode',
            from: 'opencode-adapter',
            to: 'opencode-server',
            label: 'HTTP + SSE',
            kind: 'network',
            bidirectional: true,
        },
        {
            id: 'supervisor-verifier',
            from: 'goal-supervisor-core',
            to: 'verification-runner',
            label: 'declared command',
            kind: 'spawn',
            bidirectional: true,
        },
        {
            id: 'supervisor-db',
            from: 'goal-supervisor-core',
            to: 'goal-db',
            label: 'outcomes / evidence / state',
            kind: 'filesystem',
            bidirectional: true,
            bend: 46,
        },
    ],
    flows: [
        {
            id: 'goal-launch',
            label: 'Plan → durable attempt → verified outcome',
            shortLabel: 'Launch goal',
            summary:
                'A locally confirmed plan becomes durable queued work, a leased outbox command, an idempotently named OpenCode session, verified evidence, accepted work, and finally an achieved goal.',
            color: '#58d6c7',
            steps: [
                {
                    edgeId: 'operator-surfaces',
                    label: 'Confirm /goal plan',
                    detail: 'The TUI reads a workspace-confined Markdown plan, shows its digest and unit count, and requires local confirmation.',
                    payload:
                        '{\n  "objective": "Ship the release",\n  "units": [{\n    "id": "unit-1",\n    "title": "Run gate",\n    "instructions": "Run the repository quality gate.",\n    "dependencyIds": [],\n    "acceptanceCriteria": ["gate passes"],\n    "verificationRequirements": [{\n      "id": "gate",\n      "type": "command",\n      "executable": "pnpm",\n      "args": ["gate"],\n      "timeoutMs": 900000,\n      "outputCapBytes": 1048576,\n      "expectedExitCode": 0,\n      "required": true\n    }],\n    "required": true,\n    "destructive": false\n  }],\n  "finalVerificationRequirements": [],\n  "authoredBy": "operator"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/goal-plan.ts',
                            14,
                            'Plan document shape',
                        ),
                    ],
                },
                {
                    edgeId: 'surfaces-control',
                    label: 'Send stdio bridge launch',
                    detail: 'The Bun-safe TUI sends one strict JSON request to a verified Node bridge.',
                    payload:
                        '{\n  "protocol": "cbranch-goal-supervisor.tui/1",\n  "operation": "launch",\n  "workspace": "/work/repo",\n  "planPath": "/work/repo/goal.md",\n  "planMarkdown": "…",\n  "actor": "operator"\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/tui-protocol.ts',
                            75,
                            'Launch envelope',
                        ),
                    ],
                },
                {
                    edgeId: 'control-db',
                    label: 'Create idempotent execution state',
                    detail: 'One transaction creates the goal, plan, approvals, and executable work without duplicating retries.',
                    payload:
                        'commandId: "tui-launch:sha256:…"\ngoal.state: "executing"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/control.ts',
                            653,
                            'Launch control path',
                        ),
                    ],
                },
                {
                    edgeId: 'surfaces-systemd',
                    phaseBreak:
                        'After durable launch succeeds, the confirmed TUI starts the service-management phase.',
                    label: 'Ensure persistent service',
                    detail: 'An executing goal causes the TUI to ensure the workspace service is active.',
                    payload:
                        'systemctl --user enable --now cbranch-goal-supervisor-….service',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/tui.ts',
                            400,
                            'Daemon ensure',
                        ),
                    ],
                },
                {
                    edgeId: 'systemd-daemon',
                    label: 'Start serve process',
                    detail: 'systemd launches the Node CLI for this workspace and configured OpenCode endpoint.',
                    payload:
                        'node dist/cli.js serve --workspace /work/repo --opencode-url http://127.0.0.1:4096 --internal-service-identity sha256:…',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/systemd.ts',
                            146,
                            'Unit ExecStart',
                        ),
                    ],
                },
                {
                    edgeId: 'daemon-db',
                    label: 'Claim eligible unit',
                    detail: 'Dependencies, budget, destructive approval, and leases are checked atomically.',
                    payload:
                        'workUnit.state: "queued" → attempt.state: "leased"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/store.ts',
                            2958,
                            'Eligible attempt claim',
                        ),
                    ],
                },
                {
                    edgeId: 'db-outbox',
                    label: 'Materialize dispatch command',
                    detail: 'The external side effect is represented by a durable, leased outbox row.',
                    payload:
                        '{\n  "schemaVersion": 1,\n  "type": "dispatch-attempt",\n  "goalId": "goal-1",\n  "workUnitId": "unit-1",\n  "attemptId": "attempt-1",\n  "leaseToken": "lease-…",\n  "idempotencyKey": "attempt:attempt-1",\n  "payload": {\n    "kind": "agent",\n    "input": { "title": "Run gate", "instructions": "…" }\n  }\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/store.ts',
                            2958,
                            'Outbox creation',
                        ),
                    ],
                },
                {
                    edgeId: 'outbox-supervisor',
                    label: 'Lease delivery',
                    detail: 'The supervisor records dispatch-started before crossing the external side-effect boundary.',
                    payload:
                        '{ "deliveryState": "started", "needsProbe": false }',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/supervisor.ts',
                            397,
                            'Outbox delivery boundary',
                        ),
                    ],
                },
                {
                    edgeId: 'supervisor-adapter',
                    label: 'Dispatch idempotent session',
                    detail: 'The adapter receives workspace, command, and deterministic idempotency key.',
                    payload:
                        '{\n  "idempotencyKey": "attempt:attempt-1",\n  "workspace": "/work/repo",\n  "command": { "type": "dispatch-attempt", "attemptId": "attempt-1" }\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/supervisor.ts',
                            30,
                            'SessionDispatchInput',
                        ),
                    ],
                },
                {
                    edgeId: 'adapter-opencode',
                    label: 'Create or find session',
                    detail: 'A deterministic title and prompt message ID make probe-before-redelivery possible.',
                    payload:
                        'title: "Goal Supervisor | attempt:attempt-1"\nmessageId: sha256(idempotencyKey)',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/opencode-adapter.ts',
                            288,
                            'Deterministic session identity',
                        ),
                    ],
                },
                {
                    edgeId: 'adapter-opencode',
                    direction: 'reverse',
                    label: 'Read AgentOutcome',
                    detail: 'The returned attempt and lease must match the active durable record.',
                    payload:
                        '{\n  "schemaVersion": 1,\n  "attemptId": "attempt-1",\n  "leaseToken": "lease-…",\n  "status": "completed",\n  "summary": "Gate passed",\n  "evidenceRefs": [{ "ref": "artifact://gate.log", "digest": "sha256:…" }],\n  "verificationRefs": []\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/domain.ts',
                            609,
                            'AgentOutcome schema',
                        ),
                    ],
                },
                {
                    edgeId: 'supervisor-verifier',
                    phaseBreak:
                        'The external session outcome has returned to GoalSupervisor before verification begins.',
                    label: 'Run declared verification',
                    detail: 'The coordinator runs every required command with bounded direct spawn semantics.',
                    payload:
                        '{\n  "id": "gate",\n  "type": "command",\n  "executable": "pnpm",\n  "args": ["gate"],\n  "timeoutMs": 900000,\n  "outputCapBytes": 1048576,\n  "expectedExitCode": 0,\n  "required": true\n}',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/domain.ts',
                            190,
                            'VerificationRequirement',
                        ),
                    ],
                },
                {
                    edgeId: 'supervisor-db',
                    phaseBreak:
                        'The verifier has returned a bounded result; the coordinator now persists acceptance.',
                    label: 'Accept verified result',
                    detail: 'Only evidence plus all required verification references allow success and work-unit acceptance.',
                    payload:
                        'attempt.state: "succeeded"\nworkUnit.state: "accepted"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/store.ts',
                            4596,
                            'Outcome acceptance policy',
                        ),
                    ],
                },
                {
                    edgeId: 'supervisor-db',
                    phaseBreak:
                        'After all required units are accepted, the coordinator runs the separate final-verification and finalization phase.',
                    label: 'Finalize eligible goal',
                    detail: 'Only accepted required work plus every required final check passing permits the durable goal.achieved transition.',
                    payload:
                        'allRequiredUnitsAccepted: true\nallFinalRequiredPassed: true\ngoal.state: "achieved"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/supervisor.ts',
                            1090,
                            'Final verification coordinator',
                        ),
                        citation(
                            'packages/opencode-goal-supervisor/src/store.ts',
                            4922,
                            'Guarded goal finalization',
                        ),
                    ],
                },
            ],
        },
        {
            id: 'goal-crash-recovery',
            label: 'Crash window → probe before retry',
            shortLabel: 'Crash recovery',
            summary:
                'If the daemon dies after dispatch begins but before delivery is recorded, the recovered outbox row is probed by deterministic identity instead of blindly creating another session.',
            color: '#f3b95f',
            steps: [
                {
                    edgeId: 'db-outbox',
                    label: 'Recover expired delivery lease',
                    detail: 'A started-but-unconfirmed external delivery becomes needsProbe.',
                    payload:
                        '{ "deliveryState": "started", "needsProbe": true }',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/store.ts',
                            3526,
                            'Lease recovery',
                        ),
                    ],
                },
                {
                    edgeId: 'outbox-supervisor',
                    label: 'Claim uncertain command',
                    detail: 'The supervisor recognizes the probe requirement before any dispatch call.',
                    payload: 'idempotencyKey: "attempt:attempt-1"',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/supervisor.ts',
                            452,
                            'Probe-before-dispatch branch',
                        ),
                    ],
                },
                {
                    edgeId: 'supervisor-adapter',
                    label: 'Probe session identity',
                    detail: 'The adapter asks whether a session matching the deterministic key is absent, active, completed, or unknown.',
                    payload:
                        '{ "idempotencyKey": "attempt:attempt-1", "workspace": "/work/repo" }',
                    evidence: 'schema-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/supervisor.ts',
                            41,
                            'SessionProbeInput',
                        ),
                    ],
                },
                {
                    edgeId: 'adapter-opencode',
                    label: 'Find deterministic title',
                    detail: 'Existing external work is rediscovered without duplicate side effects.',
                    payload: 'Goal Supervisor | attempt:attempt-1',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/opencode-adapter.ts',
                            561,
                            'Session probe',
                        ),
                    ],
                },
                {
                    edgeId: 'supervisor-db',
                    phaseBreak:
                        'The probe found the external session; recovery resumes inside GoalSupervisor.',
                    label: 'Persist recovered delivery',
                    detail: 'Active or completed sessions are attached to the existing attempt; only a proven absence permits dispatch.',
                    payload:
                        '{ "externalRef": "session-42", "status": "active" }',
                    evidence: 'implementation-derived',
                    citations: [
                        citation(
                            'packages/opencode-goal-supervisor/src/supervisor.ts',
                            452,
                            'Recovered delivery handling',
                        ),
                    ],
                },
            ],
        },
    ],
};
