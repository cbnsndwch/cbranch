# Sub-Epic 1: Goal Supervisor Correctness

**Status:** Complete

**Parent:** [Stabilization and Next Platform](../README.md)

## Objective

Remove the known TUI and daemon lifecycle correctness risks before treating the
goal-supervisor `0.1.0` workflow as release-ready. The implementation must match
the operator confirmation, persistent service, ownership, readiness, and retry
requirements in
[`24-opencode-goal-supervisor.md`](../../../spec/24-opencode-goal-supervisor.md),
especially GS-TUI-5 through GS-TUI-9 and GS-DAEMON-1 through GS-DAEMON-8.

## Goal Plan

```goal-plan
{
  "objective": "Remove the known goal-supervisor TUI and daemon lifecycle correctness risks before release qualification.",
  "authoredBy": "repository-review",
  "units": [
    {
      "id": "process-identity",
      "title": "Fence daemon ownership against PID reuse",
      "instructions": "Implement GS-COR-1 in this document. Add and validate robust process identity in daemon lock and readiness evidence, fail closed for unverifiable managed ownership, define conservative legacy handling, and cover a live unrelated process reusing the recorded PID.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "PID reuse cannot make a stale lock or readiness marker appear live",
        "Managed ownership fails closed when process identity cannot be established",
        "Legacy or incomplete records are handled without deleting a potentially live owner"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "managed-persistence",
      "title": "Require verified managed persistence for TUI success",
      "instructions": "Implement GS-COR-2 in this document. A confirmed TUI launch may report persistent success only when the expected per-workspace systemd unit owns the ready daemon. Preserve committed goals on bootstrap failure and never signal an independent owner through the TUI path.",
      "dependencyIds": ["process-identity"],
      "acceptanceCriteria": [
        "Independent daemon ownership is never reported as successful managed persistence",
        "An independent owner receives an actionable safe result and is not killed",
        "Bootstrap failure preserves the durable goal for idempotent retry"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "bridge-size-invariants",
      "title": "Align plan and bridge size limits",
      "instructions": "Implement GS-COR-3 in this document. Guarantee that every plan accepted before confirmation fits the bounded encoded bridge request, or reject it before confirmation. Cover worst-case JSON escaping, multibyte input, and exact boundaries.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Every plan accepted before confirmation can be encoded within the bridge request cap",
        "The bridge remains strictly bounded",
        "Boundary tests include high-expansion and multibyte content"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "retryable-discovery",
      "title": "Make verified program discovery retryable",
      "instructions": "Implement GS-COR-4 in this document. Do not retain rejected systemctl or verified-program discovery promises, allow same-session recovery, and cache successful verification only while executable identity remains valid.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "A transient systemctl discovery failure can recover in the same TUI session",
        "Successful cache entries cannot conceal changed executable identity"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "complete-confirmation",
      "title": "Show the complete canonical approval summary",
      "instructions": "Implement GS-COR-5 in this document. Show the full validated objective, canonical confined path, unit count, and raw-file SHA-256 digest in a bounded local confirmation surface while preserving safe terminal rendering.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "The confirmation displays every GS-TUI-5 approval field",
        "Long objectives remain fully reviewable without silent truncation",
        "Canonical paths and non-printable input are covered by tests"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "correctness-regression-suite",
      "title": "Complete lifecycle and recovery regression coverage",
      "instructions": "Implement GS-COR-6 and reconcile the authoritative spec, README, and changelog with the accepted behavior. Cover crash, restart, PID reuse, stale readiness, identity mismatch, independent ownership, service replacement, OpenCode URL reconciliation, and idempotent bootstrap retry.",
      "dependencyIds": [
        "process-identity",
        "managed-persistence",
        "bridge-size-invariants",
        "retryable-discovery",
        "complete-confirmation"
      ],
      "acceptanceCriteria": [
        "Recovery-focused regression tests cover every corrected boundary",
        "Replay retries bootstrap without creating a second goal or authorization",
        "Specification and implementation ownership semantics agree"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": [
    {
      "id": "gs-correctness-tests",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/opencode-goal-supervisor", "test"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "gs-correctness-typecheck",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/opencode-goal-supervisor", "typecheck:test"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "gs-correctness-pack",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/opencode-goal-supervisor", "pack:check"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "gs-correctness-gate",
      "type": "command",
      "executable": "pnpm",
      "args": ["gate"],
      "timeoutMs": 1800000,
      "outputCapBytes": 8388608,
      "expectedExitCode": 0,
      "required": true
    }
  ]
}
```

## Why Now

The current package has broad unit coverage and passes package verification, but
PID-only liveness can mistake a reused PID for the original daemon. The TUI can
also report successful persistent bootstrap when an independently managed daemon
owns the workspace lock. Both paths can leave an executing goal without the
managed service promised by GS-TUI-6.

Additional boundary mismatches allow a valid plan to outgrow the encoded bridge
request, cache a transient `systemctl` discovery failure for the process
lifetime, and show less confirmation detail than GS-TUI-5 requires.

## Scope

### GS-COR-1: Process identity and stale ownership

- Extend daemon ownership and readiness evidence with a process identity that
  distinguishes PID reuse, such as the Linux boot identity plus process start
  time where the automatic TUI workflow is supported.
- Validate the identity before classifying a lock or readiness marker as live.
- Fail closed when identity cannot be established for a supposedly managed
  service.
- Define conservative handling for legacy or incomplete lock records without
  deleting a lock that may still represent a live owner.
- Add regression coverage for a live unrelated process reusing the recorded PID.

### GS-COR-2: Managed persistence contract

- Make a confirmed TUI launch successful only when the dedicated, verified
  per-workspace systemd unit owns a ready daemon matching the expected service
  identity.
- Do not treat a foreground or independently managed daemon as proof of
  persistent bootstrap.
- Never signal or kill an independent lock holder through the TUI path.
- Return an actionable operator error when an independent daemon blocks managed
  startup, and preserve the already committed durable goal for idempotent retry.
- Keep `/goal-daemon-stop` restricted to the exact verified TUI-managed unit.

### GS-COR-3: Bridge size invariants

- Make the accepted plan-file limit and encoded bridge request limit consistent
  for worst-case JSON escaping and UTF-8 content.
- Reject an unencodable plan before confirmation, or change the bounded protocol
  so every plan accepted before confirmation is guaranteed to fit.
- Preserve strict request and response caps and avoid an unbounded transport.
- Test high-expansion control characters, multibyte content, and exact boundary
  sizes.

### GS-COR-4: Retryable program discovery

- Do not permanently cache a rejected `systemctl` or verified-program discovery
  promise.
- Permit a later confirmed retry to recover after a transient timeout, repaired
  installation, or restored user manager.
- Keep successful verification cacheable only while the verified executable
  identity remains valid.

### GS-COR-5: Complete local confirmation

- Display the full validated objective in a bounded, scrollable confirmation
  surface without silently truncating approval content.
- Display the canonical workspace-confined file path, unit count, and raw-file
  SHA-256 digest.
- Preserve terminal/control-character sanitization without changing the approved
  semantic value.
- Add tests for long objectives, nested workspace paths, and non-printable input.

### GS-COR-6: Recovery-focused regression coverage

- Cover crash, restart, PID reuse, stale readiness, identity mismatch, independent
  ownership, service replacement, and OpenCode URL reconciliation.
- Verify that a service-bootstrap failure never rolls back the committed goal.
- Verify that replaying the same confirmed launch retries bootstrap without
  creating a second goal or start authorization.

## Acceptance Criteria

- PID reuse cannot make a stale lock or readiness marker appear live.
- A TUI launch cannot report persistent success unless the expected verified
  systemd service owns the ready workspace daemon.
- Independent ownership produces a safe, actionable result and is never killed
  by the TUI.
- Every plan accepted before confirmation can be sent through the bounded bridge.
- A transient discovery failure can recover during the same OpenCode session.
- The confirmation displays all GS-TUI-5 approval data.
- The authoritative specification, README, and implementation describe the same
  ownership and retry behavior.

## Verification

```sh
pnpm --filter @cbranch/opencode-goal-supervisor test
pnpm --filter @cbranch/opencode-goal-supervisor typecheck
pnpm --filter @cbranch/opencode-goal-supervisor typecheck:test
pnpm --filter @cbranch/opencode-goal-supervisor pack:check
pnpm gate
```

## Out of Scope

- Multi-host ownership or distributed consensus.
- A hostile same-user security boundary.
- Replacing systemd with another unattended service manager.
- Token metering, final-verification reset, or new goal lifecycle states.
