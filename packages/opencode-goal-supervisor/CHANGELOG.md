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
- Keep model-facing approval tools request-only, inject MCP transport credentials
  outside model arguments, and persist OpenCode permission correlation across
  plugin restarts.
- Enforce issue precedence before verifier execution, reject completion without
  evidence at the agent schema, sanitize approval command identifiers, and
  serialize stale daemon-lock recovery.
- Support Node.js 20 or newer and OpenCode plugin `1.17.x`; Bun is unsupported.
