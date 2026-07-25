# Changelog

This package follows Semantic Versioning. Release artifacts are built from a
reviewed Git tag, checked with `pnpm pack:check`, and published with npm
provenance by the release operator.

## 0.1.0 - Unreleased

- Add the versioned goal, plan, work, evidence, verification, approval, command,
  and event contracts.
- Add migrated event-backed SQLite state, fenced leases, durable dispatch
  recovery, and dependency-aware plans.
- Add migration 3 for plan-scoped final verification, verifier runtime metadata,
  and cancellation diagnostics; legacy unscoped final results are preserved but
  cannot finalize a newer active plan.
- Add the bounded verifier, OpenCode adapter, Effect daemon, authenticated MCP
  and plugin controls, CLI operations, and systemd user-unit generation.
- Add the TUI-only `./tui` export with local `/goal`, `/goal-status`, and
  `/goal-daemon-stop` autocomplete commands, strict workspace-confined Markdown
  plan loading, and a local operator confirmation boundary.
- Keep the Bun-hosted TUI import graph free of native SQLite by delegating init,
  list, and confirmed launch to bounded one-shot Node children over a strict,
  token-free JSON protocol.
- Add idempotent atomic create/propose/approve/unattended-start from the confirmed
  TUI plan and per-workspace hardened systemd user-service bootstrap that
  survives OpenCode restarts and is retried independently of the durable goal;
  automatic persistence requires Linux/systemd and fails safely when unsupported.
- Reconcile executing goals with the current OpenCode URL when the TUI restarts,
  including hosts where Node is supplied through an absolute `PATH` entry.
- Publish token-bound daemon readiness only after startup reconciliation, verify
  systemd unit ownership by fragment path, serialize lifecycle changes, and
  avoid restarting an unchanged active service.
- Bind readiness to the exact generated service identity and serialize systemd
  changes across OpenCode processes so failed reload/restart rollouts retry
  safely.
- Keep model-facing approval tools request-only, inject MCP transport credentials
  outside model arguments, and persist OpenCode permission correlation across
  plugin restarts.
- Document that arbitrary shell/process execution is operator authority in the
  trusted-local model; TUI confirmation is not a cryptographic boundary against
  a model granted that authority.
- Enforce issue precedence before verifier execution, reject completion without
  evidence at the agent schema, sanitize approval command identifiers, and
  serialize stale daemon-lock recovery.
- Support Node.js 20 or newer and OpenCode plugin `1.17.x`; standalone Bun
  execution is unsupported.
