# Supervised Clerk Workspace Intelligence Walkthrough

This is a runbook for a user-supervised, read-only Clerk VM walkthrough. It is
not an authorization to connect to the VM or analyze any Clerk checkout without
the user present and explicitly directing the next step.

## Preconditions

- Confirm the exact VM workspace roots and selected repository subset with the
  user. The locally visible
  `/home/serge/clerk/.clk/features/transactional-email-dashboard/clerk_go/`
  checkout is only a related locator; do not assume it is the VM workspace.
- Confirm the VM is available and the user wants an analysis now. Do not retry
  connection, start a tunnel, or run an analysis unattended.
- Capture `git status --short` and the current branch for each selected root as
  read-only provenance. Do not clean, stage, reset, fetch, install, build, or
  generate files.
- Confirm the intended host resource budget and that the selected repository
  roots are authoritative workspace members.

## Walkthrough

1. In the Intelligence workspace view, verify the selected members and choose
   **Analyze workspace**. Do not select an inferred path or an open editor tab
   as scope.
2. Observe queued, preparing, and per-repository progress. If a root becomes
   unavailable, source changes during inventory, or the user requests a stop,
   cancel from the run manager and retain the final cancelled/partial record.
3. Inspect the completed or valid partial report. Check coverage, analyzer
   limitations, capability gaps, architecture-integrity findings, and the
   bounded graph/evidence views before drawing conclusions.
4. Exercise a small graph search, a neighborhood expansion, and a historical
   diff only after confirming the run is valid. Record any unexpected false
   component, contract, or channel as curation feedback; do not alter immutable
   artifacts.
5. If the user wants an export, request the one-time archive only while they
   are present. Confirm that it contains report artifacts and curation snapshot,
   not source files or absolute host paths.

## Stop conditions and report

Stop immediately for an unclear workspace boundary, unapproved external
connection, repository mutation prompt, resource exhaustion, or a user request
to pause. Report the run ID, selected members, current/partial state, coverage,
and explicit limitations. Do not treat a successful walkthrough as a claim of
complete semantic coverage.
