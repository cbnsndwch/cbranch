# Sub-Epic 4: Roadmap Reconciliation

**Status:** Proposed

**Parent:** [Stabilization and Next Platform](../README.md)

## Objective

Make the repository's specifications, implementation ledgers, compatibility
claims, package exports, and operating instructions describe the reviewed code
without weakening authoritative requirements. This sub-epic is documentation
and release-contract work; it does not complete missing runtime behavior by
relabeling it.

## Goal Plan

```goal-plan
{
  "objective": "Reconcile repository specifications, delivery ledgers, compatibility claims, package exports, and operating instructions with the reviewed implementation.",
  "authoredBy": "repository-review",
  "units": [
    {
      "id": "spec-index-roadmap",
      "title": "Update the specification index and roadmap",
      "instructions": "Implement DOC-REC-1 in this document. Accurately list current packages and applications, describe the implemented and deferred signed-repository boundary, identify VS Code/Remote-SSH as the next major track, and keep the supervisor independent from cbranch RPC phases.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "The specification index reflects the current workspace structure",
        "The roadmap distinguishes implemented signed-repository support from deferred work",
        "The supervisor remains documented as an independent package"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "phase9-spec-annotations",
      "title": "Reconcile Phase 9 authoritative annotations",
      "instructions": "Implement DOC-REC-2 in this document without deleting unimplemented end-state requirements. Mark lifecycle, TUF, credentials, contributions, brokers, update, rollback, Git/SSH, and root rotation as implemented, partial, deferred, or unsupported with evidence.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Phase 9 implementation annotations agree with reviewed code and tests",
        "The exact TUF subset and trust-root lifecycle are stated",
        "Command placement and panel claims agree with contract and UI"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "phase9-ledger",
      "title": "Replace stale Phase 9 delivery instructions",
      "instructions": "Implement DOC-REC-3 in this document. Update observed state and lifecycle evidence, remove obsolete M0/M1 start instructions, record actual M2/M3/M4 status, and retain M5 as a separately gated track.",
      "dependencyIds": ["phase9-spec-annotations"],
      "acceptanceCriteria": [
        "Completed work is no longer presented as the next sequence",
        "Lifecycle exit criteria match RPC exposure and UI reachability",
        "M5 remains explicitly separate and deferred"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "supervisor-release-contract",
      "title": "Align the goal-supervisor release contract",
      "instructions": "Implement DOC-REC-4 in this document. Reconcile compatibility wording, decide the tui-daemon export status, align manifest/spec/README/verifier, document corrected TUI ownership and qualification evidence, and keep 0.1.0 unreleased until its release criteria are met.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Supervisor compatibility claims and exact package ranges agree",
        "Every public export has an explicit semver status",
        "Release readiness is supported by evidence rather than assertion"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "runbooks-progress",
      "title": "Update runbooks and current progress",
      "instructions": "Implement DOC-REC-5 in this document. Add or link current plugin and supervisor evaluation instructions, update the current progress summary without rewriting history, reconcile desktop release claims, and ensure clean-clone commands include required build steps.",
      "dependencyIds": [
        "spec-index-roadmap",
        "phase9-ledger",
        "supervisor-release-contract"
      ],
      "acceptanceCriteria": [
        "Current runbooks cover the reviewed plugin and supervisor workflows",
        "Progress distinguishes historical records from current state",
        "Clean-clone and desktop release instructions match actual workflows"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "link-claim-audit",
      "title": "Audit documentation links and claims",
      "instructions": "Implement DOC-REC-6 in this document. Check changed links and commands, search stale delivery and compatibility claims, verify normative identifiers, remove contradictory duplication, and preserve authoritative source hierarchy.",
      "dependencyIds": [
        "spec-index-roadmap",
        "phase9-ledger",
        "supervisor-release-contract",
        "runbooks-progress"
      ],
      "acceptanceCriteria": [
        "No reviewed documentation contradiction remains for lifecycle, TUF, compatibility, exports, or readiness",
        "Changed relative links and command examples resolve",
        "Normative identifiers point to authoritative sources"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": [
    {
      "id": "roadmap-format-check",
      "type": "command",
      "executable": "pnpm",
      "args": ["format:check"],
      "timeoutMs": 300000,
      "outputCapBytes": 1048576,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "roadmap-pack-check",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/opencode-goal-supervisor", "pack:check"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "roadmap-repository-gate",
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

## Source Hierarchy

- `docs/spec/14-rpc-contract.md` and `docs/spec/15-sync-protocol.md` remain
  authoritative for cbranch transport behavior.
- `docs/spec/21-runtime-plugin-system.md` remains authoritative for Phase 9.
- `docs/spec/22-phase9-implementation-plan.md` is a descriptive execution ledger.
- `docs/spec/24-opencode-goal-supervisor.md` remains authoritative for the
  independent supervisor package.
- `PROGRESS.md`, `RUNNING.md`, package READMEs, and release guides must reconcile
  to those sources.

## Scope

### DOC-REC-1: Specification index and roadmap

- Update `docs/spec/00-README.md` to list the current workspace applications and
  packages accurately.
- Replace the stale statement that all signed repository support is deferred
  with the reviewed implemented/partial/deferred boundary.
- Record the VS Code/Remote-SSH walking skeleton as the next major product track
  after stabilization.
- Keep the goal supervisor identified as an independent package rather than a
  cbranch RPC phase.

### DOC-REC-2: Phase 9 authoritative requirement annotations

- Reconcile contradictory implementation-status prose in
  `21-runtime-plugin-system.md` without deleting unimplemented end-state
  requirements.
- Mark HTTPS/TUF installation, private HTTPS credentials, declarative commands,
  panels, broker APIs, update/rollback, Git/SSH, and root rotation as
  implemented, partial, deferred, or unsupported with linked evidence.
- State the exact supported TUF subset and trust-root lifecycle.
- Reconcile command placement and panel claims with the public contract and UI.

### DOC-REC-3: Phase 9 execution ledger

- Replace the stale observed-state table in
  `22-phase9-implementation-plan.md` with evidence from the accepted trust
  baseline.
- Remove the obsolete instruction to begin again at M0/M1.
- Record current M2/M3/M4 delivery state and keep M5 separately gated.
- Verify that lifecycle exit criteria match RPC exposure and UI reachability.

### DOC-REC-4: Goal-supervisor release contract

- Reconcile the changelog compatibility wording with the exact OpenCode peer
  range and SDK pin.
- Decide whether `./tui-daemon` is a supported public semver-governed export or
  an internal implementation entry, then align the manifest, spec, README, and
  package verifier.
- Document the exact corrected TUI ownership behavior and host qualification
  evidence.
- Keep `0.1.0` marked unreleased until the release criteria and reviewed tag are
  complete.

### DOC-REC-5: Runbooks and progress record

- Add current plugin canary and goal-supervisor source-evaluation instructions
  to the appropriate runbook or link to their package documentation.
- Update the current summary in `PROGRESS.md` without rewriting its historical
  entries as if they were current status.
- Reconcile desktop release/update claims with the actual workflows and target
  platforms.
- Ensure commands are runnable from a clean clone and call out required build
  steps for ignored `dist` artifacts.

### DOC-REC-6: Link and claim audit

- Check all changed relative links and command examples.
- Search for stale `deferred`, `not implemented`, `M0`, `M1`, compatibility, and
  release-readiness claims across documentation.
- Verify that normative identifiers still resolve to the authoritative source.
- Do not duplicate large normative sections into descriptive documents.

## Acceptance Criteria

- No reviewed document contradicts the implementation about Phase 9 lifecycle,
  TUF scope, private credentials, contribution placement, or deferred brokers.
- Goal-supervisor README, changelog, spec, exports, and package verifier agree on
  compatibility and public API.
- The Phase 9 ledger has a current next sequence rather than completed work
  written as pending.
- The roadmap identifies the bounded P7/VS Code track after stabilization.
- Clean-clone run and release instructions are complete and internally linked.
- Documentation changes pass formatting and link/command checks used by the
  repository.

## Verification

```sh
pnpm format:check
pnpm lint
pnpm --filter @cbranch/opencode-goal-supervisor pack:check
pnpm gate
```

## Out of Scope

- Changing authoritative product requirements merely to match missing code.
- Implementing Phase 9 M5 or goal-supervisor lifecycle features.
- Rewriting historical release notes.
- Claiming host qualification without evidence from sub-epic 2.
