# Sub-Epic 3: Phase 9 Trust Baseline

**Status:** Complete

**Parent:** [Stabilization and Next Platform](../README.md)

## Objective

Make the current trusted-command plugin baseline safe, explicit, and usable
without expanding into the separately deferred brokered-authority program. The
work must preserve the trust model and TUF requirements in
[`21-runtime-plugin-system.md`](../../../spec/21-runtime-plugin-system.md) while
updating the execution ledger in
[`22-phase9-implementation-plan.md`](../../../spec/22-phase9-implementation-plan.md).

## Goal Plan

```goal-plan
{
  "objective": "Close the current Phase 9 trusted-command plugin baseline without expanding into deferred brokered authority.",
  "authoredBy": "repository-review",
  "units": [
    {
      "id": "publisher-fingerprint",
      "title": "Require meaningful publisher fingerprint approval",
      "instructions": "Implement P9-TRUST-1 in this document. Display a copyable fetched root fingerprint with independent-comparison guidance, bind approval to the exact repository and root metadata, reject stale approval, and test that displayed and submitted values match.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "The operator sees and explicitly approves the exact publisher fingerprint",
        "A root change invalidates stale UI approval",
        "Browser and manager tests bind the displayed value to the mutation"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "compatibility-enforcement",
      "title": "Enforce plugin and host compatibility",
      "instructions": "Implement P9-TRUST-2 in this document. Define the canonical host version, enforce manifest.engines.cbranch and plugin-contract compatibility, require agreement with signed target metadata, reconcile hello-world ranges, and return pluginIncompatible before activation.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Incompatible plugins cannot install or activate",
        "Manifest, target metadata, contract, and host compatibility are checked consistently",
        "The first-party plugin and public author guidance use one tested range"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "typed-plugin-errors",
      "title": "Preserve actionable plugin errors",
      "instructions": "Implement P9-TRUST-3 in this document. Preserve policy, repository, credential, TUF, archive, compatibility, and lifecycle categories across typed RPC with redaction, reserving pluginWorkerFailed for unclassified trusted-runtime failures.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Expected failures retain actionable typed error codes",
        "Sensitive values remain redacted",
        "Expired metadata, bad signatures, authentication, archive, compatibility, and command failures are tested"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "byte-output-limit",
      "title": "Enforce byte-accurate plugin output limits",
      "instructions": "Implement P9-TRUST-4 in this document. Apply the command-result cap to encoded bytes for legacy text and structured results before durable audit or RPC serialization, with ASCII, multibyte, and boundary tests.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "The 1 MiB limit is byte-accurate for every supported result kind",
        "Oversize output is rejected before duplicated persistence or serialization",
        "Multibyte and exact-boundary behavior is covered"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "lifecycle-reachability",
      "title": "Make exposed plugin lifecycle operations reachable",
      "instructions": "Implement P9-TRUST-5 in this document. Make repository removal and paginated audit UI-reachable or remove their RPC exposure, show installed identity and contribution state, keep update and rollback absent, and satisfy the M1 lifecycle exit condition.",
      "dependencyIds": [
        "publisher-fingerprint",
        "compatibility-enforcement",
        "typed-plugin-errors",
        "byte-output-limit"
      ],
      "acceptanceCriteria": [
        "Every exposed baseline lifecycle operation is UI-reachable or intentionally absent",
        "Installed publisher, version, grant, contribution, and availability state are visible",
        "Update and rollback remain absent until retained-version semantics are approved"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "honest-tuf-boundary",
      "title": "Enforce and document the supported TUF boundary",
      "instructions": "Implement P9-TRUST-6 in this document. State and test the active top-level TUF role checks, persist version state required by any rollback claim or narrow that claim, add adversarial supported-path tests, and retain root rotation, delegations, Git/SSH, and update policy in M5.",
      "dependencyIds": ["typed-plugin-errors"],
      "acceptanceCriteria": [
        "TUF documentation makes no claim broader than the tested implementation",
        "Any claimed rollback protection has persisted monotonic role-version enforcement",
        "Expiry, replay, malformed metadata, threshold failure, and target mismatch are tested"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": [
    {
      "id": "phase9-focused-tests",
      "type": "command",
      "executable": "pnpm",
      "args": ["vitest", "run", "packages/plugin-contract", "packages/plugin-runtime", "apps/web-server/src/plugin-manager.test.ts", "apps/web-server/src/plugin-repository-transport.test.ts", "packages/ui/src/components/PluginsDialog.test.tsx"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "phase9-browser-tests",
      "type": "command",
      "executable": "pnpm",
      "args": ["test:browser"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "phase9-repository-gate",
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

## Scope

### P9-TRUST-1: Meaningful publisher fingerprint approval

- Display the fetched root fingerprint before the trust action is available.
- Provide a copyable value and explicit language that the operator must compare
  it through an independent publisher channel.
- Bind approval to the exact repository, root metadata, and displayed
  fingerprint.
- Reject stale UI approval if the root metadata changes before mutation.
- Add browser and manager tests proving the displayed and submitted values match.

### P9-TRUST-2: Compatibility enforcement

- Define the canonical cbranch host version used for plugin compatibility.
- Parse and enforce `manifest.engines.cbranch` during review and installation.
- Enforce agreement among manifest identity, signed target metadata, plugin
  contract version, and host compatibility.
- Reconcile the hello-world manifest, signed registry target, and public author
  documentation to one tested range.
- Return `pluginIncompatible` with an actionable explanation before activation.

### P9-TRUST-3: Actionable error preservation

- Preserve `PluginPolicyError`, repository transport, credential, TUF freshness,
  archive-validation, and lifecycle error categories across typed RPC.
- Keep sensitive details and credentials redacted.
- Reserve `pluginWorkerFailed` for genuinely unclassified trusted-runtime
  failures.
- Add contract tests for expired metadata, bad signatures, authentication
  failure, invalid archives, incompatible versions, and command failures.

### P9-TRUST-4: Byte-accurate bounded output

- Enforce the command-result cap over encoded bytes, not JavaScript string
  length.
- Apply the cap consistently to legacy text and structured results.
- Reject oversize output before durable audit or RPC serialization duplicates it.
- Test ASCII, multibyte Unicode, and structured-result boundary cases.

### P9-TRUST-5: Lifecycle management reachability

- Make repository removal and paginated audit history reachable from the Plugins
  settings surface, or intentionally remove their RPC exposure until a reviewed
  UI exists.
- Show installed publisher, version, grant summary, declared contributions, and
  availability state.
- Keep update and rollback absent until retained-version semantics are approved.
- Ensure every exposed lifecycle RPC meets the M1 exit condition: implemented,
  tested, and UI-reachable, or intentionally absent.

### P9-TRUST-6: Honest TUF boundary

- State precisely which top-level TUF roles, expiry checks, signatures, hashes,
  lengths, and version monotonicity are enforced by the active adapter.
- Persist and enforce the role-version state required for any claimed rollback
  protection, or narrow the claim until that behavior exists.
- Add adversarial tests for the supported top-level path, including expiry,
  replay, malformed metadata, insufficient threshold signatures, and target
  mismatch.
- Keep delegated targets, full root rotation, Git/SSH repositories, retained
  rollback, and security-only auto-update in the deferred M5 track unless
  separately approved.

## Acceptance Criteria

- An operator sees and explicitly approves the exact publisher fingerprint.
- Incompatible plugins cannot install or activate.
- Expected policy and transport failures retain actionable typed error codes.
- The 1 MiB command-result limit is byte-accurate for all supported result kinds.
- Every exposed M1 lifecycle operation is UI-reachable or intentionally absent.
- TUF documentation makes no claim broader than the tested implementation.
- A real HTTPS repository round-trip covers trust, review, install, enable,
  invoke, audit, disable, and uninstall.

## Verification

```sh
pnpm vitest run packages/plugin-contract packages/plugin-runtime
pnpm vitest run apps/web-server/src/plugin-manager.test.ts
pnpm vitest run apps/web-server/src/plugin-repository-transport.test.ts
pnpm vitest run packages/ui/src/components/PluginsDialog.test.tsx
pnpm test:browser
pnpm gate
```

## Out of Scope

- Scoped Git, workspace, network, or process brokers.
- Arbitrary plugin DOM, React, HTML, CSS, or browser networking.
- Git/SSH repository transport.
- Full delegated-target or root-rotation implementation unless separately
  approved as a prerequisite to an existing security claim.
- Update/rollback and automatic security updates.
