# Stabilization and Next Platform

**Status:** In progress; correctness and Phase 9 trust baseline complete

## Objective

Turn the current goal-supervisor and Phase 9 plugin work into an honestly
qualified baseline, reconcile the planning record with the implementation, and
then begin the next major cbranch delivery surface through a bounded Phase 7 and
VS Code/Remote-SSH vertical slice.

This epic groups the five directions selected after the repository review. It
does not replace the authoritative requirements in `docs/spec/`; each sub-epic
links back to the specifications that govern its behavior.

## Goal Plan

```goal-plan
{
  "objective": "Stabilize and qualify the goal supervisor and Phase 9 plugin baseline, reconcile the repository roadmap, and deliver a bounded Phase 7 and VS Code/Remote-SSH vertical slice.",
  "authoredBy": "repository-review",
  "units": [
    {
      "id": "goal-supervisor-correctness",
      "title": "Correct goal-supervisor TUI and daemon lifecycle behavior",
      "instructions": "Complete docs/epics/stabilization-and-next-platform/01-goal-supervisor-correctness/README.md. Resolve process identity, managed persistence, bridge sizing, retryable discovery, complete confirmation, and recovery regression coverage without expanding the supervisor architecture.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "The Goal Supervisor Correctness sub-epic acceptance criteria are satisfied",
        "The implementation and authoritative supervisor specification describe the same ownership and retry behavior"
      ],
      "verificationRequirements": [
        {
          "id": "parent-gs-correctness-tests",
          "type": "command",
          "executable": "pnpm",
          "args": ["--filter", "@cbranch/opencode-goal-supervisor", "test"],
          "timeoutMs": 600000,
          "outputCapBytes": 2097152,
          "expectedExitCode": 0,
          "required": true
        }
      ],
      "required": true,
      "destructive": false
    },
    {
      "id": "goal-supervisor-host-qualification",
      "title": "Qualify the goal supervisor on its real host stack",
      "instructions": "Complete docs/epics/stabilization-and-next-platform/02-goal-supervisor-host-qualification/README.md. Produce fail-closed evidence for Node 20, the exact OpenCode target, the Bun-hosted TUI boundary, native SQLite, packed installation, and a real systemd user service lifecycle.",
      "dependencyIds": ["goal-supervisor-correctness"],
      "acceptanceCriteria": [
        "The Goal Supervisor Host Qualification sub-epic acceptance criteria are satisfied",
        "Qualification evidence identifies the reviewed commit and exact runtime versions without silently skipped required checks"
      ],
      "verificationRequirements": [
        {
          "id": "parent-gs-pack-check",
          "type": "command",
          "executable": "pnpm",
          "args": ["--filter", "@cbranch/opencode-goal-supervisor", "pack:check"],
          "timeoutMs": 600000,
          "outputCapBytes": 2097152,
          "expectedExitCode": 0,
          "required": true
        }
      ],
      "required": true,
      "destructive": false
    },
    {
      "id": "phase9-trust-baseline",
      "title": "Close the Phase 9 plugin trust baseline",
      "instructions": "Complete docs/epics/stabilization-and-next-platform/03-phase9-trust-baseline/README.md. Make publisher trust, compatibility enforcement, typed errors, byte-accurate output bounds, lifecycle reachability, and the supported TUF boundary honest and tested while keeping M5 broker authority deferred.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "The Phase 9 Trust Baseline sub-epic acceptance criteria are satisfied",
        "Every exposed baseline lifecycle operation is UI-reachable or intentionally absent"
      ],
      "verificationRequirements": [
        {
          "id": "parent-phase9-tests",
          "type": "command",
          "executable": "pnpm",
          "args": ["vitest", "run", "packages/plugin-contract", "packages/plugin-runtime", "apps/web-server/src/plugin-manager.test.ts", "apps/web-server/src/plugin-repository-transport.test.ts", "packages/ui/src/components/PluginsDialog.test.tsx"],
          "timeoutMs": 600000,
          "outputCapBytes": 2097152,
          "expectedExitCode": 0,
          "required": true
        }
      ],
      "required": true,
      "destructive": false
    },
    {
      "id": "roadmap-reconciliation",
      "title": "Reconcile specifications, ledgers, and release claims",
      "instructions": "Complete docs/epics/stabilization-and-next-platform/04-roadmap-reconciliation/README.md after the corrected behavior and host evidence are known. Preserve authoritative requirements, remove stale delivery instructions, and align compatibility, exports, TUF scope, runbooks, and release claims.",
      "dependencyIds": [
        "goal-supervisor-correctness",
        "goal-supervisor-host-qualification",
        "phase9-trust-baseline"
      ],
      "acceptanceCriteria": [
        "The Roadmap Reconciliation sub-epic acceptance criteria are satisfied",
        "No reviewed document overstates implemented behavior, compatibility, qualification, or security guarantees"
      ],
      "verificationRequirements": [
        {
          "id": "parent-doc-format",
          "type": "command",
          "executable": "pnpm",
          "args": ["format:check"],
          "timeoutMs": 300000,
          "outputCapBytes": 1048576,
          "expectedExitCode": 0,
          "required": true
        }
      ],
      "required": true,
      "destructive": false
    },
    {
      "id": "p7-vscode-remote-ssh",
      "title": "Finish bounded Phase 7 cleanup and prove VS Code Remote-SSH",
      "instructions": "Complete docs/epics/stabilization-and-next-platform/05-p7-vscode-remote-ssh/README.md. Fix bounded shell wiring, then replace the VS Code placeholder with a CSP-safe shared-UI walking skeleton using the existing RPC group and core, including a real Remote-SSH proof.",
      "dependencyIds": [
        "goal-supervisor-host-qualification",
        "phase9-trust-baseline",
        "roadmap-reconciliation"
      ],
      "acceptanceCriteria": [
        "The Phase 7 Cleanup and VS Code/Remote-SSH sub-epic acceptance criteria are satisfied",
        "The extension opens no listening socket and introduces no extension-specific Git implementation"
      ],
      "verificationRequirements": [
        {
          "id": "parent-vscode-build",
          "type": "command",
          "executable": "pnpm",
          "args": ["--filter", "@cbranch/vscode-ext", "build"],
          "timeoutMs": 600000,
          "outputCapBytes": 2097152,
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
      "id": "parent-repository-gate",
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

## Sub-Epics

| Order | Sub-epic | Outcome | Dependency |
| --- | --- | --- | --- |
| 1 | [Goal Supervisor Correctness](01-goal-supervisor-correctness/README.md) | TUI launch, daemon ownership, readiness, and confirmation behavior are safe and match the authoritative contract. | None |
| 2 | [Goal Supervisor Host Qualification](02-goal-supervisor-host-qualification/README.md) | The package is exercised on its declared Node, OpenCode, Bun, SQLite, and systemd environment with reproducible evidence. | Sub-epic 1 |
| 3 | [Phase 9 Trust Baseline](03-phase9-trust-baseline/README.md) | Plugin trust, compatibility, errors, output limits, and management reachability are honest and enforceable. | May run beside sub-epic 1 |
| 4 | [Roadmap Reconciliation](04-roadmap-reconciliation/README.md) | Specifications, ledgers, compatibility claims, and release instructions agree with the reviewed implementation. | Contract decisions from sub-epics 1 and 3 |
| 5 | [Phase 7 Cleanup and VS Code/Remote-SSH](05-p7-vscode-remote-ssh/README.md) | Existing shell gaps are closed and the VS Code extension proves the shared UI/core/RPC architecture over Remote-SSH. | Sub-epics 1 through 4, or an explicit decision to proceed with known gaps |

## Sequence

### Wave 1: Correctness and trust

Run sub-epics 1 and 3 as separate workstreams. Both stop for review after their
focused tests and before expanding scope.

### Wave 2: Qualification and documentation

Run sub-epic 2 against the corrected supervisor implementation. Complete
sub-epic 4 after the accepted behavior and compatibility boundaries are known.

### Wave 3: Product expansion

Run sub-epic 5 only after the current products have an honest, reviewed
baseline. Phase 7 cleanup is the entry gate for the VS Code walking skeleton so
the new surface does not inherit known dead shell actions.

## Program Guardrails

- Keep the goal supervisor independent from cbranch Git orchestration, RPC, and
  browser UI as required by
  [`24-opencode-goal-supervisor.md`](../../spec/24-opencode-goal-supervisor.md).
- Keep brokered Git, filesystem, network, and process authority out of the Phase
  9 trust-baseline sub-epic. Those remain a separately approved M5 track.
- Do not weaken an authoritative requirement to make the current implementation
  appear complete. Mark behavior implemented, partial, deferred, or unsupported.
- Make every sub-epic independently reviewable and avoid unrelated refactors.
- Preserve the package boundaries in `AGENTS.md`: only `core` runs Git, only the
  web server listens, and shared transport behavior remains in `rpc-contract`.

## Program Definition of Done

- Every sub-epic meets its own acceptance criteria and verification section.
- The full repository gate passes on the final reviewed commit.
- Package/release checks fail closed instead of silently skipping required host
  qualification.
- Authoritative specifications and descriptive ledgers have no known
  contradictions about shipped behavior, compatibility, or security guarantees.
- Deferred work remains explicitly listed with no UI or release claim implying
  that it is implemented.

```sh
pnpm gate
```
