# Workspace Intelligence Pilot Results

## Read-only deterministic baseline — 2026-07-27

The opt-in integration test below inventories a selected Git working tree,
supplies its Git-ignored paths, and runs the deterministic source analyzer. It
does not create artifacts, start the host service, or write to the selected
repository.

```bash
CBRANCH_INTELLIGENCE_PILOT_ROOT=/path/to/repository \
  pnpm vitest run apps/web-server/src/workspace-intelligence-service.test.ts \
  -t 'analyzes an explicitly selected pilot root read-only'
```

| Root | Result |
| --- | --- |
| cbranch | Passed |
| EXT `agent-dashboard` | Passed after ignored-path lookup was made bounded |
| EXT `extendly-product` | Passed |
| EXT `Rocket.Chat` | Passed |

The `agent-dashboard` run initially exposed an O(files × ignored paths)
inventory check; its repository has more than 215,000 ignored paths. The
inventory now normalizes ignored paths once and uses ancestor lookup, and that
pilot passed in about 2.1 seconds.

## Read-only aggregate workspace pilot — 2026-07-27

The opt-in aggregate harness creates a temporary artifact directory, resolves
only the explicitly supplied roots as members of a transient workspace, and
runs the real `WorkspaceIntelligenceManager`. It verifies a valid aggregate
run, report, bounded graph search, and archive payload redaction before the
temporary directory is removed.

```bash
CBRANCH_INTELLIGENCE_PILOT_ROOTS='/path/to/repository-a:/path/to/repository-b' \
  pnpm vitest run apps/web-server/src/workspace-intelligence-service.test.ts \
  -t 'runs an explicit multi-root pilot through aggregate artifacts read-only'
```

| Members | Result |
| --- | --- |
| cbranch + EXT `agent-dashboard`, `extendly-product`, and `Rocket.Chat` | Passed in 17 seconds |

This is stronger than source inventory alone, but it is intentionally not a
substitute for user correctness acceptance. It does not compose a persisted
cbranch Engagement through the running web-server, benchmark the browser graph
renderer, or authorize the supervised Clerk walkthrough.

The aggregate harness was re-run from the Workspace Intelligence feature
worktree on 2026-07-27 after the deterministic analyzer v4 update, against
those same four locally present roots: 1 test passed in 16.79 seconds. The
single cbranch read-only inventory harness also passed in 2.17 seconds. These
checks create only a temporary artifact directory and never write to any
selected repository; they remain evidence of mechanical read-only behavior, not
user correctness acceptance.

The same checks were refreshed on 2026-07-28 from the feature worktree while
the cbranch root had 46 pre-existing dirty entries. The aggregate pilot passed
in 16.00 seconds and the single-root inventory passed in 2.22 seconds. The
pilot harness inspects Git status and source files read-only, writes artifacts
only below a newly created temporary directory, and removes that directory in
test cleanup; it did not change any selected repository.
