# ADR 0002: Workspace Intelligence Neighborhood Renderer

## Status

Accepted — 2026-07-27.

## Context

Workspace Intelligence stores canonical JSONL graph artifacts on the host and
returns only bounded search and neighborhood results to the browser. A
neighborhood request is capped at 1,999 relationships, and its node set is
capped at 2,000 records including the selected node. It must not become a
full-repository graph transfer.

The renderer spike compared React Flow and React Sigma/Sigma. React Flow is a
React-native, interactive node/edge editor with controls and explicit guidance
to memoize props and collapse large trees. React Sigma wraps a WebGL renderer
well suited to arbitrary large graphs, but requires `graphology` plus `sigma`
peer dependencies and requires an effectively immutable `SigmaContainer` to
avoid destroying and recreating the renderer when graph/settings props change.

The pinned React Sigma 5.0.6 / Graphology 0.26.0 comparison path cannot load
in Chromium 149. Graphology declares a class method named `import`, which the
browser rejects as a syntax error before Sigma can create a canvas. This is a
compatibility failure in the candidate dependency stack, not a rendering-time
result.

- [React Flow performance guidance](https://reactflow.dev/learn/advanced-use/performance)
- [React Sigma lifecycle guidance](https://sim51.github.io/react-sigma/docs/start-introduction/)
- [React Sigma installation prerequisites](https://sim51.github.io/react-sigma/docs/start-installation/)

## Decision

Use `@xyflow/react` 12.11.2 for the bounded neighborhood canvas.

The renderer receives only the host-returned neighborhood, turns stable graph
IDs into deterministic grid positions, and omits edges with a missing endpoint.
It provides pan, zoom, fit-to-view, background, and non-mutating controls. A
user may reposition a rendered node, but this writes only the bounded
workspace-local `presentation/<runId>.json` coordinate; it never connects,
edits, or otherwise mutates canonical architecture entities.

React Sigma or another WebGL renderer remains an escalation path if a future
user requirement needs an unbounded or thousands-of-nodes client
visualization. It needs a browser-compatible dependency stack, a separate
transport budget, layout strategy, and browser performance evidence; it must
not relax the current host-side graph-query boundary.

## Evidence and consequences

- `WorkspaceIntelligenceGraph.test.tsx` proves deterministic 2,000-node/
  1,999-edge bounded conversion, including removal of dangling edges.
- `WorkspaceIntelligenceGraph.browser.test.tsx` mounts that complete bounded
  shape in real Chromium and verifies the React Flow node and edge count.
- `WorkspaceIntelligenceGraph.renderer-benchmark.browser.test.tsx` mounts the
  same complete shape, then proves the current React Sigma peer-dependency path
  fails to parse in Chromium. It intentionally does not claim a timing winner:
  an unimportable renderer cannot supply a meaningful rendering measurement.
- `EngagementOverview.test.tsx` proves a search result can request a bounded
  neighborhood and mount the React Flow canvas.
- The comparison packages are dev-only and MIT-licensed. The selected product
  renderer adds one MIT-licensed React package and avoids a production
  Sigma/Graphology peer-dependency surface.
- This ADR intentionally does not claim a benchmark for full graph rendering:
  the deterministic release does not send full graphs to the browser.
