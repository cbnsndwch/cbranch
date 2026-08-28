# Sub-Epic 2: Goal Supervisor Host Qualification

**Status:** Ready; sub-epic 1 complete

**Parent:** [Stabilization and Next Platform](../README.md)

## Objective

Produce reproducible evidence that the corrected goal-supervisor package works
on its declared real host stack, not only through unit fakes and Node imports.
Qualification must cover the minimum supported Node runtime, the exact OpenCode
target, the actual Bun-hosted TUI plugin boundary, native SQLite, and a real
systemd user service lifecycle.

The release and readiness requirements remain governed by
[`24-opencode-goal-supervisor.md`](../../../spec/24-opencode-goal-supervisor.md).

## Goal Plan

```goal-plan
{
  "objective": "Produce fail-closed real-host qualification evidence for the corrected goal-supervisor package and its declared runtime stack.",
  "authoredBy": "repository-review",
  "units": [
    {
      "id": "qualification-runner",
      "title": "Create a fail-closed release qualification entrypoint",
      "instructions": "Implement GS-QUAL-1 in this document. Compose package checks, repository gate, and required host integrations; require exact external binary versions in release mode; fail rather than skip unavailable required checks; emit a concise machine-readable summary.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "One documented command drives all required qualification for the host",
        "Release mode cannot silently skip OpenCode, Bun-hosted TUI, or systemd qualification",
        "The summary records commit, package, runtime, platform, and outcomes without secrets"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "real-opencode-scenario",
      "title": "Exercise the real OpenCode control plane",
      "instructions": "Implement GS-QUAL-2 in this document against the exact OpenCode binary. Cover approved start, daemon claim, dispatch, structured outcome, verifier execution, finalization, restart reconciliation, cancellation, and unknown-outcome handling in bounded temporary state.",
      "dependencyIds": ["qualification-runner"],
      "acceptanceCriteria": [
        "The packed package completes a supervised goal against the exact target OpenCode binary",
        "Restart reconciliation and ambiguous-effect handling are exercised at a real adapter boundary",
        "Temporary state is removed on success and failure"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "real-tui-host",
      "title": "Qualify the TUI in the supported Bun host",
      "instructions": "Implement GS-QUAL-3 in this document. Load the packed TUI export through the supported OpenCode/Bun host, verify exact command registration and absence of model tools, exercise local confirmation and token-free bridge output, and prove the import closure excludes SQLite and Node-only control modules.",
      "dependencyIds": ["qualification-runner"],
      "acceptanceCriteria": [
        "The packed TUI export loads in the actual supported Bun host",
        "Only the three specified TUI commands are registered and no model tool or prompt is added",
        "A bootstrap failure can be resolved by idempotent retry"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "real-systemd-lifecycle",
      "title": "Qualify a real systemd user-service lifecycle",
      "instructions": "Implement GS-QUAL-4 in this document in a safely isolated user-manager environment. Cover verified unit install, enable, start, readiness, crash restart, OpenCode URL reconciliation, stop, disable, cleanup, and lock/readiness identity across PID churn.",
      "dependencyIds": ["qualification-runner"],
      "acceptanceCriteria": [
        "A real managed service survives daemon failure and reconciles durable work",
        "Process identity remains valid across restart and PID churn",
        "The qualification leaves no unit or workspace residue"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "native-runtime-matrix",
      "title": "Qualify Node 20 and native SQLite installation",
      "instructions": "Implement GS-QUAL-5 in this document. Install the packed artifact from empty consumers under Node 20 and the current development Node, exercise normal better-sqlite3 installation, then run initialization, migration, integrity, backup, restore, and reopen verification.",
      "dependencyIds": ["qualification-runner"],
      "acceptanceCriteria": [
        "Node 20 and the current development Node pass isolated package smoke tests",
        "Native SQLite installs through the normal package-manager path",
        "Database migration, backup, restore, and integrity checks pass"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "qualification-evidence",
      "title": "Record qualification evidence and release decision",
      "instructions": "Implement GS-QUAL-6 in this document. Record exact commands and versions without secrets, distinguish pass from waiver or unsupported status, and link evidence to the reviewed commit and release decision.",
      "dependencyIds": [
        "real-opencode-scenario",
        "real-tui-host",
        "real-systemd-lifecycle",
        "native-runtime-matrix"
      ],
      "acceptanceCriteria": [
        "Evidence identifies the reviewed commit and exact relevant versions",
        "No secret, control token, transcript body, or artifact body is retained",
        "Waived or unsupported checks are not represented as passing"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": [
    {
      "id": "gs-qualification-pack",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/opencode-goal-supervisor", "pack:check"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "gs-qualification-gate",
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

## Qualification Matrix

| Surface | Minimum evidence |
| --- | --- |
| Node | Node 20 plus the repository's current development Node version |
| OpenCode SDK | Exact package pin declared by the release candidate |
| OpenCode binary | Exact deployment binary, with version captured in evidence |
| TUI host | Plugin loaded by the supported OpenCode/Bun TUI host, not imported only under Node |
| SQLite | Fresh native `better-sqlite3` install and database lifecycle on the target platform |
| systemd | Real user-unit install, enable, start, readiness, restart, stop, disable, and cleanup |
| Packaging | Packed tarball installed into an isolated consumer, not workspace-link resolution |

## Scope

### GS-QUAL-1: Fail-closed qualification command

- Add one documented release-qualification entrypoint that composes package
  tests, production/test typechecks, `pack:check`, the repository gate, and
  required host integration checks.
- Require explicit paths or versions for external binaries in release mode.
- Fail rather than skip when OpenCode, Bun-hosted TUI, or systemd qualification
  was requested but unavailable.
- Emit a concise machine-readable summary containing commit, package version,
  Node version, OpenCode version, platform, and check outcomes.

### GS-QUAL-2: Real OpenCode control-plane scenario

- Start the exact OpenCode server binary in a temporary workspace.
- Exercise goal creation, approved plan start, daemon claim, dispatch, structured
  outcome, verifier execution, finalization, and status inspection.
- Restart the supervisor during active work and verify durable reconciliation.
- Exercise abort/cancellation and unknown-outcome handling at a real adapter
  boundary.
- Ensure the test uses bounded temporary state and removes it on success or
  failure.

### GS-QUAL-3: Real TUI host smoke test

- Load the packed `./tui` export through the supported OpenCode/Bun plugin host.
- Verify exact command registration for `/goal`, `/goal-status`, and
  `/goal-daemon-stop`.
- Verify that no model tool or prompt is registered by the TUI export.
- Exercise local plan selection, confirmation, token-free bridge output, and an
  idempotent retry after a simulated bootstrap failure.
- Confirm that the TUI import closure does not load SQLite or Node-only control
  modules in the Bun host.

### GS-QUAL-4: Real systemd user-service lifecycle

- Use a dedicated temporary workspace and per-workspace unit identity.
- Install and verify the generated hardened unit.
- Exercise enable/start/readiness, daemon crash and automatic restart, OpenCode
  URL reconciliation, stop/disable, and complete cleanup.
- Verify lock/readiness process identity across restart and PID churn.
- Refuse to run when a safe isolated user-manager test environment is not
  available.

### GS-QUAL-5: Native dependency and supported-runtime matrix

- Install the packed artifact from an empty consumer under Node 20.
- Build or download `better-sqlite3` through the normal package-manager path.
- Run initialization, migration, integrity check, online backup, restore, and
  reopened database verification.
- Repeat the package smoke test on the current development Node version.

### GS-QUAL-6: Evidence and release decision

- Store no secrets, control tokens, full transcripts, or artifact bodies in test
  output.
- Record exact commands and versions in the release-candidate evidence.
- Distinguish required pass, approved environmental waiver, and unsupported
  configuration. A waiver must not be represented as a pass.
- Link the final evidence from the release notes or review record without
  committing volatile host data into the package.

## Acceptance Criteria

- One command can reproduce all release qualification appropriate to the host.
- Release mode cannot silently skip the real OpenCode or systemd checks.
- The packed package completes a real end-to-end supervised goal on the exact
  target OpenCode binary.
- The TUI export loads and operates in the actual supported Bun host.
- A real managed service survives daemon failure and reconciles durable work.
- Node 20 and native SQLite installation are demonstrated from an isolated
  package consumer.
- Evidence identifies the exact reviewed commit and all relevant versions.

## Verification

The sub-epic must introduce and document the final qualification command. Until
then, the minimum component checks are:

```sh
pnpm --filter @cbranch/opencode-goal-supervisor test
pnpm --filter @cbranch/opencode-goal-supervisor pack:check
CBRANCH_OPENCODE_E2E=1 pnpm --filter @cbranch/opencode-goal-supervisor test
pnpm gate
```

## Out of Scope

- Claiming support for every Node, Linux distribution, init system, or OpenCode
  version.
- Automated npm publication.
- Multi-host failover or remote supervisor control.
- Treating a mocked systemd or Node import as real-host evidence.
