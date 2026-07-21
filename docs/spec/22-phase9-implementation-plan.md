# P9 — Runtime Plugins: Implementation State and Delivery Plan

**Status:** proposed for review

This is the execution ledger for [`21-runtime-plugin-system.md`](21-runtime-plugin-system.md).
The specification remains authoritative. This document records the codebase as
of the first successful canary installation of the first-party hello-world
plugin and turns remaining work into independently verifiable goal loops.

## Scope and Decisions

- Plugins are reviewed local ESM modules running with host-user authority.
  Capability grants constrain cbranch-provided APIs and UI behavior; they do
  not sandbox Node or the operating system.
- Plugin UI remains declarative and host-rendered. Plugins do not provide DOM,
  React, HTML, CSS, browser network access, or arbitrary event handlers.
- The near-term goal is a complete, usable plugin-management and declarative
  UI surface. Git/filesystem/network/process broker APIs are a separate later
  delivery track.

## Observed Implementation State

| Area | Status | Evidence and gap |
| --- | --- | --- |
| Contract and RPC catalog | partial | `packages/plugin-contract` and `packages/rpc-contract` define manifests, grants, installed records, repository lifecycle, and invocation schemas. `PluginUpdate` and `PluginRollback` are declared but have no manager implementation. |
| Trusted ESM lifecycle | done for v1 commands | `apps/web-server/src/plugin-manager.ts` validates, loads, enables, disables, disposes, invokes, contains entrypoints, caps output, and records audits. |
| HTTPS repository and signed artifacts | done for demonstrated path | TUF repository transport, root approval, catalog refresh, staging, archive validation, activation, and lock persistence exist in `apps/web-server/src/`. The hello-world artifact was browsed, installed, enabled, and invoked from a canary workspace. |
| Repository source support | partial | HTTPS works. Git-backed repositories are explicitly refused by `repositoryRefresh`; private-credential and SSH workflows are not wired through the product UI. |
| Install and uninstall | done for demonstrated path | The Plugins dialog supports add, refresh, root trust, catalog browse, install, enable/disable, and uninstall. Installation currently applies an empty grant without a review flow. |
| Update and rollback | not started | The RPC contract advertises both operations, but the manager and UI do not implement them. |
| Permission review and broker APIs | not started | Grants are persisted and descriptive, but there is no install/update review or cbranch broker for Git, workspace, network, or host automation. |
| Declarative command UI | partial | Command titles are rendered under `Plugins`; command output is shown in a host modal. The optional manifest `menu` field is ignored. |
| Declarative panels, forms, status items | not started | `PluginPanelContribution` is only `{ id, title }` and no UI consumes it. Forms and status items are described by the specification but absent from the v1 schema. |
| Result-dialog presentation | in flight | `packages/ui/src/components/PluginsDialog.tsx` has an uncommitted wrapping fix and regression test for long unbroken output. |
| P9 planning and progress tracking | not started | `PROGRESS.md` has no P9 status. The specification still labels parts of the now-working signed HTTPS flow as deferred. |

## Reconciliation Required

Before declaring P9 complete, update `docs/spec/21-runtime-plugin-system.md` to
separate implemented HTTPS/TUF installation from still-deferred features. In
particular, the deferred-distribution preface at lines 446-451 no longer
describes current behavior. Do not weaken its requirements while reconciling;
mark each one implemented, partial, or deferred with a linked test.

## Milestones

Each milestone is a separate goal loop: work only within its stated scope, run
its listed verification, update this ledger, and stop for review before the
next milestone.

### M0 — Publish the Result Dialog Fix

**Purpose:** make the current canary testable without coupling it to the larger
plugin UI program.

- Commit the pending result-dialog wrapping change and test.
- Tag and publish the next canary after explicit approval.
- Verify the canary installs/updates and the hello-world result wraps a long
  `repoId` at desktop and narrow viewport widths.

**Exit:** the user confirms the result modal has no horizontal overflow.

### M1 — Reconcile P9 Baseline and Management State

**Purpose:** make the shipped runtime and remaining contract honest and
testable before adding new UI contribution types.

- Reconcile the P9 spec's deferred HTTPS/TUF wording and add a concise P9
  progress section to `PROGRESS.md` linked to this ledger.
- Add a contract-to-implementation/test matrix for repository refresh, trust,
  install, enable, disable, uninstall, and invocation.
- Either implement `PluginUpdate` and `PluginRollback` end-to-end or remove
  their unimplemented RPCs until their dedicated milestone is approved. Prefer
  implementation only if retained artifact/version semantics are fully defined.
- Replace the empty-grant install shortcut with an explicit read-only install
  review that shows publisher, version, digest, requested capabilities, and
  declarative contributions. Grants remain empty until broker capabilities are
  delivered.

**Verification:** focused manager/RPC/UI tests plus a real HTTPS repository
round-trip. `pnpm gate` must pass.

**Exit:** every exposed lifecycle RPC is implemented and reachable from the UI,
or intentionally absent from the contract; no UI claims a security review that
does not exist.

### M2 — Define Declarative UI Contributions

**Purpose:** establish a small stable contract before rendering plugin UI in
multiple shell locations.

- Version the plugin contract when making a breaking manifest change.
- Replace the free-form optional command `menu` string with a closed,
  schema-validated placement model. Initial placements should be limited to
  `plugins`, `tools`, and named host context-menu surfaces that already exist.
- Expand `PluginPanelContribution` with a closed placement, title, and a
  declarative host-rendered content model. Do not add arbitrary markup or URLs.
- Define structured command results rather than treating every non-string
  return as JSON text. Start with `notice`, `dialog`, and `panel` result kinds;
  define their size limits, accessibility text, and dismissal behavior.
- Decide whether forms/status items belong in this first contribution version.
  If yes, define closed field/item schemas; if no, explicitly defer them.

**Verification:** schema encode/decode tests, invalid-placement rejection,
manifest validation tests, RPC round-trip tests, and compatibility tests for
the hello-world plugin artifact.

**Exit:** one reviewed manifest can declare each supported contribution without
the UI needing plugin code or unvalidated strings to choose layout behavior.

### M3 — Render Commands and Panels in the Host UI

**Purpose:** make M2's validated contributions visible and usable.

- Render commands at their approved placement while retaining the Plugins menu
  as the fallback/default placement.
- Render declarative panels only in named host-owned panel regions. Display the
  plugin and publisher identity, unavailable state, and error boundary.
- Preserve host ownership of focus management, keyboard navigation, responsive
  layout, localization, theme, and all destructive-action confirmations.
- Extend the Plugins settings surface to show installed version, publisher,
  grant summary, contributions, audit history entry point, and update/rollback
  availability.

**Verification:** browser tests for command placement, panel rendering,
enable/disable lifecycle, keyboard navigation, dialogs, desktop dimensions, and
a 390px viewport with no document overflow.

**Exit:** the first-party example demonstrates a command outside the default
submenu and a host-rendered panel, with no plugin-controlled DOM.

### M4 — Structured Results and Declarative Interaction

**Purpose:** replace the generic text result modal with useful but bounded
plugin interaction.

- Render M2 result kinds with existing cbranch primitives.
- Allow a declared form submission only to invoke an already-declared plugin
  command with schema-validated input; no arbitrary callback or URL action.
- Route panel state changes through typed host state and plugin invocation
  results, not direct browser access.
- Preserve text fallback for legacy command outputs and make large output
  readable, selectable, copyable, wrapped, and capped.

**Verification:** browser tests for long output, multiline output, focus return,
Esc/backdrop dismissal, form validation, result errors, and accessibility roles.

**Exit:** a plugin can provide a nontrivial host-rendered workflow without raw
HTML, React, or a browser-side plugin runtime.

### M5 — Brokered Authority and Distribution Completion

**Purpose:** deliver the still-deferred high-risk capabilities after the UI
model is stable.

- Add scoped Git, workspace, network, and process broker APIs one capability at
  a time, preserving cbranch locks, confirmations, cancellation, redaction, and
  audit requirements.
- Add private HTTPS credential storage, private Git/SSH repository handling,
  Git-backed TUF sources, trust-root rotation, update review, rollback, and the
  specified security-update policy.
- Add end-to-end adversarial coverage required by P9: TUF expiry/replay/root
  rotation, credential redaction, archive attacks, permission expansion, and
  destructive operation confirmation.

**Exit:** the applicable P9 requirements have implementation and test evidence;
remaining non-goals are explicitly retained as non-goals.

## Next Approved Sequence

1. Review and approve this document.
2. Commit and publish M0 only, including the pending result-dialog overflow fix.
3. Confirm M0 manually in the canary client.
4. Start a new dedicated session at M1, then stop for review before M2.

The dedicated plugin-UI implementation session must not begin from M2 until M1
has reconciled the currently exposed lifecycle contract and implementation
state.
