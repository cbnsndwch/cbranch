# Workspace Intelligence

## Purpose

Workspace Intelligence is a native, on-demand architecture analysis capability
for a cbranch workspace. It analyzes the current working trees of explicitly
selected workspace members on the host and records a durable, inspectable
architecture graph and report. It complements Git workflows; it does not modify
repositories or replace `GitEngine`.

The persisted `Engagement` and `engagementId` names remain compatibility
identifiers. Product UI calls an Engagement a **workspace**, consistent with
[Phase 8](19-phase8-multi-repo-engagements.md).

## Architecture and boundaries

- **REQ-WI-ARCH-001** `packages/workspace-intelligence` MUST be a
  transport-neutral package above `core` in the dependency graph. It owns the
  analysis domain, run lifecycle, artifact integrity, analyzers, graph/report
  construction, and read/query services. It MUST NOT open a listener, import UI
  code, mutate a Git repository, or import `core` implementation maps.
- **REQ-WI-ARCH-002** The package MUST consume narrow injected ports for
  workspace membership/repository resolution, filesystem access, clock/ID
  generation, and later analysis tools. `apps/web-server` composes those ports
  with `GitEngine` and Node filesystem implementations; it remains the only
  listener-owning package.
- **REQ-WI-ARCH-003** `packages/core` remains authoritative for workspace
  membership and repository identity/state. A browser-supplied path MUST never
  select an analysis root.
- **REQ-WI-ARCH-004** Public request/response/event schemas and RPC methods
  belong in `packages/rpc-contract`; the UI consumes them through React Query
  and its existing RPC client. Immutable reports and run state MUST NOT be
  duplicated into Zustand.

## Scope, snapshots, and safety

- **REQ-WI-SCOPE-001** Every operation MUST carry an explicit `engagementId`.
  The default run scope is all members of that workspace; an optional `repoIds`
  subset MUST be non-empty, unique, and server-validated against the membership
  snapshot. Open tabs, focus, paths, remotes, and package-manager workspaces
  MUST NOT infer scope.
- **REQ-WI-SCOPE-002** A run records its exact workspace membership and selected
  subset, each member's `RepoId`, resolved root, working-tree provenance, and
  analysis settings. `RepoId` plus validated member root is the repository
  identity for a run; remote URLs do not migrate identity or curation.
- **REQ-WI-SCOPE-003** Source include/exclude globs and collection/graph budgets
  are mutable workspace-local defaults. They are validated as bounded relative
  patterns and positive bounded integers, persist outside immutable runs, and
  may be supplied as an explicit one-run override. Every new run MUST snapshot
  the normalized effective policy; policy changes MUST prevent incremental
  reuse of an analysis made under different settings.
- **REQ-WI-SAFE-001** Deterministic analysis MUST be offline and read-only. It
  MUST NOT install dependencies, execute package/build scripts, invoke Terraform
  providers/state/plan, download tools, or write to a repository.
- **REQ-WI-SAFE-002** An analyzer MUST not traverse a symlink outside a selected
  member root. Escaping paths, sibling repositories, and submodules are
  boundary observations; a target is deeply analyzed only when it is another
  selected member of the same run snapshot.
- **REQ-WI-SAFE-003** Input changes during a run MUST be surfaced as retry,
  degradation, or partial coverage. A report MUST never silently claim that a
  working-tree snapshot was stable when it was not.
- **REQ-WI-SAFE-004** Collection MUST enforce the effective per-file,
  per-repository, duration, and graph node/edge budgets. A budgeted omission or
  a user source-scope exclusion MUST remain explicit in coverage/unknown
  observations; a budget-truncated graph or source inventory is partial.

## Domain and artifact model

All persisted artifacts use a versioned envelope. The core model includes a
`RunManifest`, workspace and repository snapshots, analyzer manifests and
capabilities, capability gaps, unknown observations, graph nodes/edges,
components, contracts, channels, evidence, findings, coverage, and truncation.
Stable semantic identities are separate from occurrence hash and source span.
Every relationship carries analyzer provenance and bounded evidence. Exported
artifacts MUST NOT contain absolute repository paths.

- **REQ-WI-ART-001** Artifact storage MUST resolve below the host platform data
  directory at `workspace-intelligence/`, not inside a repository, the release
  bundle, browser storage, or cbranch's host config file.
- **REQ-WI-ART-002** A workspace has opaque-ID directories for settings,
  `current.json`, curation, presentation state, and `runs/<runId>/`. Each run
  directory contains an atomic manifest, event log, canonical graph/report
  material, coverage, integrity data, and repository subtrees as they become
  available. The initial empty report may contain empty JSONL graph files.
- Workspace-local `presentation/<runId>.json` records only bounded graph
  coordinates, expansion/selection, and visibility/filter preferences. It is
  mutable, excluded from archives, removed with its run, and can never alter
  canonical graph records, report content, evidence, or run integrity.
- **REQ-WI-ART-003** Completed/partial/cancelled runs are immutable. Readers
  migrate older artifacts in memory; external mutation is detected by integrity
  verification and marked degraded/tampered. Only a valid aggregate artifact
  may advance `current.json`.
- **REQ-WI-ART-003A** The initial v0→v1 read migration reconstructs the v0
  manifest's missing workspace membership from its recorded selected repository
  IDs. It accepts only an otherwise hash-valid v0 integrity document and never
  rewrites the legacy artifact while reading it.
- **REQ-WI-ART-004** Runs reused incrementally in later milestones MUST remain
  logically self-contained. No run may depend on an older run directory that
  manual cleanup can remove.

## Run lifecycle

- **REQ-WI-RUN-001** The host owns a background job manager in the web-server
  Effect runtime. There is one active run per workspace, host-wide concurrency
  is bounded, and identical pending requests are deduplicated.
- The web-server defaults to two concurrent Workspace Intelligence runs. An
  operator may set `CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS` to a positive
  integer before starting the host; invalid values fail startup rather than
  silently weakening the bound.
- **REQ-WI-RUN-002** A start operation persists a queued run plan before it
  returns a server-generated `runId`. States are `queued`, `preparing`,
  `running`, `cancelling`, `completed`, `partial`, `failed`, `cancelled`, and
  `interrupted`/`recovering` as applicable.
- **REQ-WI-RUN-003** State transitions and ordered progress events are persisted
  atomically. A client reconnects by reading the run/status then subscribing
  after its last observed event sequence. Cancellation prevents new scheduling,
  retains a finalized cancelled run, and never exposes an invalid aggregate as
  current.
- **REQ-WI-RUN-004** On startup, the service MUST reconcile persisted queued or
  in-progress runs. It may resume only at repository boundaries and must never
  claim to resurrect a process that was running before restart.

### Identity, replay, and presentation decisions

Canonical graph IDs are opaque strings. A deterministic analyzer constructs
them from the authoritative 64-character lowercase-hex `RepoId`, a
first-party-controlled kind namespace, and the canonical semantic identifier
(normally a normalized repository-relative path, protocol identity, or named
resource). The aggregate layer compares the complete opaque ID and never
parses it back into segments. This makes the fixed repository prefix and
first-party kind namespace the collision boundary: a repeated observation
merges only when it has the same complete ID, while source span and occurrence
details stay in evidence. Runtime analyzer plugins cannot introduce a
conflicting namespace.

`events.jsonl` is an ordered, append-only record of aggregate lifecycle and
repository-boundary progress events; no event is emitted per source file or
graph record. Version 1 retains the complete small per-run event log rather
than compacting it. Reconnect replay reads only events whose sequence is
strictly greater than the client's `afterSequence`; terminal runs emit no
further events. Any future compaction must introduce a versioned replay
checkpoint and update immutable-run integrity coverage rather than silently
rewriting an existing event history.

The durable Intelligence route is
`/w/:workspaceSlug/intelligence/runs/:runId`. A selected node is represented
by the URL-encoded `node` search parameter. The saved per-run presentation is
used on ordinary route restoration, while a valid `node` parameter is a
temporary deep-link override; it does not overwrite the saved selection merely
by being viewed. The user can then explicitly select or expand a node, which
persists the resulting bounded presentation state outside the immutable run.

## Milestone 1 contract

Milestone 1 establishes the durable run foundation; it does not implement
language analyzers or inference. It produces a truthful empty/minimal fixture
report with explicit coverage stating that no language analysis has occurred.

- **REQ-WI-M1-001** The package exposes versioned domain contracts, a run state
  machine, a filesystem artifact store, a host-port interface, and a manager
  capable of a synthetic run against a validated workspace snapshot.
- **REQ-WI-M1-002** The public RPC catalog exposes `WorkspaceIntelligenceStart`,
  `WorkspaceIntelligenceRunGet`, `WorkspaceIntelligenceRunList`,
  `WorkspaceIntelligenceRunCancel`, and streaming
  `WorkspaceIntelligenceRunSubscribe`. The status/list/get responses include
  run ID, workspace ID, selected repository IDs, state, event sequence,
  timestamps, current/validity flags, and an explicit coverage summary.
- **REQ-WI-M1-003** `EngagementOverview` exposes an Intelligence subview with a
  one-click **Analyze workspace** control and persistent/current run status.
  Before analyzers ship, it clearly describes the report as a foundation rather
  than implying architecture coverage.
- **REQ-WI-M1-004** Hermetic tests MUST cover snapshot subset validation,
  lifecycle transitions, atomic persistence, integrity validation, event replay,
  cancellation, and restart reconciliation. Tests must prove that the synthetic
  run does not write selected repositories.

## Later deterministic release

Subsequent milestones add source inventory/fingerprints; TypeScript, Rust, Go,
Terraform, XML, and recognized config analyzers; components; contract/channel
linking; deterministic Markdown and bounded Mermaid; graph/search/query/diff;
staleness, incremental reuse, curation, protected cleanup, and archive export.
They preserve this artifact and provenance model. Optional inference is a
separate package and cannot be required for deterministic value.

## Milestone 2 — cbranch TypeScript/Rust pilot

- **REQ-WI-M2-001** Source inventory MUST operate only on the validated member
  roots recorded in the run. It includes relevant working-tree source and
  configuration files while excluding `.git`, dependency/vendor trees, ordinary
  build outputs, binaries, and symlinks that escape the root. Every exclusion,
  unreadable path, byte limit, and unsupported construct contributes explicit
  coverage or an unknown observation. Configured include/exclude globs may only
  narrow this fixed supported-source allowlist; they never expand traversal to
  unsupported files or outside a member root.
- **REQ-WI-M2-002** The TypeScript/JavaScript baseline MUST identify package
  manifests, workspace packages, `tsconfig` projects, source modules, imports,
  exports, and package dependencies using compiler-backed resolution when the
  host already provides it, with a deterministic syntax/manifest fallback.
- **REQ-WI-M2-003** The Rust baseline MUST identify Cargo workspaces/packages,
  targets, dependencies, Rust modules, and `use` relationships from manifests
  and source. It MUST surface cfg, macro, build-script, and unavailable-tool
  limitations instead of claiming a complete semantic model.
- **REQ-WI-M2-004** M2 reports components derived from package/Cargo manifests,
  package and crate/module nodes, evidence-backed dependency edges, analyzer
  capabilities/gaps/unknowns, and a bounded deterministic Markdown report. It
  specifically identifies cbranch package, Effect/RPC, and Tauri boundaries.

## Milestone 3 — interactive pilot exploration

- **REQ-WI-M3-001** The Intelligence view MUST offer durable run history,
  current/partial coverage, repository-subset selection, report inspection, and
  a route that can be restored directly for the workspace Intelligence view.
- **REQ-WI-M3-002** Graph search MUST remain host-side. Search responses are
  bounded to matching nodes and their evidence; the browser MUST NOT receive the
  complete graph merely to perform a lexical search.
- **REQ-WI-M3-003** Evidence shown for a graph match MUST use repository-relative
  paths only and retain analyzer provenance. It MUST NOT disclose a host root.

## Milestone 4 — deterministic language expansion

- **REQ-WI-M4-GO-001** The Go baseline MUST identify `go.work`/`go.mod`
  workspaces and modules, Go packages, and static import relationships using
  read-only manifest/syntax fallback analysis. Build constraints, reflection,
  generated code, and unavailable semantic tooling MUST remain explicit gaps.
- **REQ-WI-M4-TF-001** The Terraform baseline MUST identify static modules,
  resources, data sources, variables, outputs, and provider declarations from
  `.tf`/`.tf.json` files without invoking Terraform, reading state, downloading
  providers, or evaluating dynamic expressions. Dynamic constructs and unresolved
  references MUST remain explicit gaps.
- **REQ-WI-M4-XML-001** The XML baseline MUST identify documents, root elements,
  declared namespaces, and static file-reference attributes. BrowserConfig tile
  image declarations MUST receive a dedicated namespaced node kind; unsupported
  XML dialect semantics remain explicit gaps.
- **REQ-WI-M4-OPENAPI-001** The OpenAPI baseline MUST identify JSON documents,
  operations, and referenced schemas as first-class contracts. YAML documents and
  framework-handler linking remain explicit capability gaps until a deterministic
  parser/linker is available.
- **REQ-WI-M4-CONFIG-001** Recognized supporting configuration MUST remain
  offline and evidence-backed. The baseline identifies Turborepo tasks, Wrangler
  workers and D1 bindings, Docker Compose service components, structural
  Kubernetes objects, AsyncAPI JSON channels, and JSON Schema contracts. YAML
  interpolation/template semantics, AsyncAPI YAML, and unrecognized config
  dialects remain explicit gaps.
- **REQ-WI-M4-REGISTRY-001** Deterministic analyzers MUST be selected from a
  compile-time first-party registry. Finalized artifacts record each selected
  analyzer's ID, version, capabilities, and limitations; runtime analyzer
  plugins are not supported.
- **REQ-WI-M4-CONTRACTS-001** The deterministic contract baseline MUST inventory
  recognized `.graphql`/`.gql` and `.proto` files. It MUST model named GraphQL
  operations and schema types plus protobuf documents, messages, gRPC services,
  and gRPC methods with repository-relative evidence. Anonymous GraphQL
  operations, resolver semantics, generated-client semantics, protobuf options,
  and schema-language features that the structural parser cannot establish MUST
  remain explicit capability gaps.
- **REQ-WI-M4-LINKERS-001** The deterministic linker baseline MUST attach
  evidence-backed HTTP routes/requests, named GraphQL operation use, gRPC
  client/server registration conventions, supported messaging observations, FFI
  boundaries, and static Terraform output/reference/module-source bindings. It
  MUST use protocol identities rather than direct inferred component edges.
  Literal/static observations are verified only at the source span recorded;
  dynamic targets, generated-stub semantics, and unrecognized frameworks MUST
  remain unknown rather than being guessed.
  Static HTTP coverage includes Express-style routers, Nest controller
  decorators, Next route modules, Cloudflare Worker fetch boundaries, Go
  conventional router method calls, Axum/Rocket route declarations, and
  literal Axios/net/http/reqwest-style requests. This is structural convention
  matching, not a claim of complete framework routing or call semantics.
- **REQ-WI-M4-FFI-001** The initial FFI baseline MUST identify C ABI/cgo,
  Node-API dependency/source boundaries, and WebAssembly boundary observations
  from static evidence. It MUST NOT claim symbol-, type-, memory-, or runtime
  compatibility beyond the source construct that was observed.
- **REQ-WI-M4-CANONICAL-001** Nodes and relationships with the same canonical
  identity MUST be materialized once in an aggregate graph, merging and sorting
  their verified evidence deterministically. A repeated observation from another
  language or repository member MUST enrich provenance rather than duplicate a
  graph entity.
- **REQ-WI-M4-QUERY-001** Graph search, neighborhood, and diff reads MUST use
  canonical JSONL as the durable authority while retaining only a bounded
  host-memory LRU of parsed active reports. Finalizing or deleting a run MUST
  invalidate its cached graph; the browser MUST continue to receive bounded
  query results rather than a complete graph payload.
- **REQ-WI-M4-DIFF-001** Run-to-run diff MUST compare stable identities for
  added, removed, and changed nodes and edges. It MUST separately summarize
  component, contract, channel, finding, repository-membership, and coverage
  changes without sending whole run artifacts to the browser.
- **REQ-WI-M4-RENDERER-001** The deterministic release MUST render only the
  bounded host-returned graph neighborhood, capped at 2,000 nodes and 1,999
  relationships. The selected React Flow renderer MUST disable graph mutation
  and omit edges whose endpoints are absent from the response. A future
  unbounded/WebGL renderer requires a separate transport and benchmark decision;
  it MUST NOT relax the canonical host-side graph boundary.

## Milestone 5 — deterministic release hardening

- **REQ-WI-M5-REUSE-001** Incremental reuse MUST read only a validated current
  artifact and require matching repository identity, fresh source fingerprint,
  and deterministic analyzer version. A reused repository analysis MUST be
  materialized into the new immutable run; no run may depend on a predecessor
  directory that later cleanup can remove.
- **REQ-WI-M5-CURATION-001** Component overrides are workspace-level
  presentation data, separate from immutable run artifacts. They apply by stable
  component ID to graph queries across compatible runs, including display
  metadata and suppression, and a user MUST be able to restore a suppressed
  component. A shared workspace-local merge-group ID MAY collapse two or more
  resolved components into one bounded graph-query presentation node; clearing a
  component's group MUST split it back out. Neither operation changes canonical
  node IDs, graph JSONL, reports, or analyzer evidence.
- **REQ-WI-M5-CURATION-001A** When a component override's stable ID does not
  resolve in the validated current graph, the host MUST return it as an
  orphaned read-time status without deleting or persisting that status. The UI
  MUST make the retained curation visible so a later compatible run can reapply
  it intentionally.
- **REQ-WI-M5-CURATION-002** Curation application MUST not alter canonical
  graph JSONL, reports, evidence, integrity records, or run validity. A corrupt
  or unavailable curation record may disable its presentation effect but MUST
  not prevent access to a validated run.
- **REQ-WI-M5-CURATION-003** Workspace curation MUST retain a versioned,
  append-only JSONL action history plus an atomically refreshed compact current
  projection. Actions record time, local actor, action kind, stable target, and
  optional evidence/metadata. Component override updates append component
  actions; a rejected stable edge is suppressed from compatible bounded graph
  queries until an explicit clear, while confirm/annotate actions retain their
  audit metadata for inferred-edge presentation. Clearing curation is explicit
  and removes only mutable workspace curation, never a run artifact.
- **REQ-WI-M5-CLEANUP-001** Cleanup MUST be explicit and protected. The host
  MUST reject deletion of active or current runs, and the client MUST require a
  confirmation step before asking the host to delete historical run artifacts.
- **REQ-WI-M5-CLEANUP-002** A user MAY explicitly select any validated finalized
  run as current or clear the mutable current pointer. Clearing all history MUST
  require a separate confirmation, reject while a run is active, remove only
  run artifacts and their derived enrichment/index children, and retain
  workspace curation.
- **REQ-WI-M5-STALE-001** The host MUST evaluate the current run's recorded
  repository fingerprints against fresh root-bounded inputs when freshness is
  requested. A mismatch marks the run stale as ephemeral presentation state and
  offers an explicit rerun; it MUST NOT mutate the historical artifact or
  automatically start a run.
- **REQ-WI-M5-ARCHIVE-001** Archive export MUST use a short-lived, one-time
  HTTP side-channel token. Its payload includes the selected validated immutable
  run, integrity material, schema metadata, and a point-in-time component
  override snapshot; it excludes source trees, absolute host paths, workspace
  settings, and curation history.
- **REQ-WI-FINDINGS-001** Finalized deterministic artifacts MUST materialize
  architecture-integrity findings separately from unknown observations. The
  initial finding set includes verified dependency cycles, unresolved graph
  references, cross-repository relationships, high-coupling graph nodes, and
  grouped capability gaps; it MUST NOT report security or general code-quality
  findings.

## Milestone 6 — optional inference foundation

- **REQ-WI-M6-FOUNDATION-001** `packages/inference` MUST remain
  transport-neutral and have no filesystem, shell, repository-root, network, or
  secret capability. It owns the provider-neutral normalized enrichment schema
  and one-repair validation flow that future TanStack AI adapters call.
- **REQ-WI-M6-FOUNDATION-002** An inferred relationship MUST include stable
  endpoint IDs, kind, bounded rationale, confidence in `[0, 1]`, and at least
  one selected evidence ID. Invalid output receives one repair attempt using
  validation diagnostics; after that, the entire enrichment attempt fails and
  no partial inferred edges are persisted.
- **REQ-WI-M6-PROFILE-001** A reusable inference provider profile MUST declare
  a stable ID, enabled state, provider kind, generation/embedding capabilities,
  and either a discovered local executable or an explicitly configured
  OpenAI-compatible endpoint. It MAY retain only a typed host secret reference
  (environment or secret-store name); it MUST have no raw credential field and
  MUST reject endpoint URLs containing embedded credentials, queries, or
  fragments. Workspace defaults refer to enabled provider profiles only by
  stable ID and keep generation and embedding selection independent.
- Profile metadata and workspace defaults live in the host's versioned
  `config.json`, never in a repository or immutable run artifact. Replacing or
  disabling a profile MUST clear only defaults that no longer resolve to an
  enabled profile with the matching capability, preserving any independent
  valid selection.
- A disabled profile MAY be incomplete while an operator discovers a model or
  configures a named credential reference. An enabled profile MUST be ready for
  its declared host runner: it has an explicit model ID; generation profiles
  and OpenAI-compatible embedding profiles have a named credential reference;
  constrained local generation profiles declare generation only; and local
  Ollama embedding profiles declare embeddings only. Invalid enabled metadata
  is rejected before it can become a workspace default or a run override.
- **REQ-WI-M6-PROFILE-002** A saved OpenAI-compatible profile MAY perform a
  bounded endpoint-restricted `GET /models` check before it is enabled. It uses
  only its named secret reference and returns bounded model IDs; it MUST NOT
  send workspace paths, graph/evidence content, source data, prompts, or raw
  provider response/error bodies. A manually selected model ID remains the
  durable capability override.
- Local agent-harness adapters MUST NOT be used merely because they expose a
  provider CLI. A local inference invocation requires a demonstrably non-agent,
  one-shot structured-output mode with no repository cwd, file/tool access, or
  autonomous shell execution. The constrained Claude Code adapter uses a
  no-tool, single-turn print/JSON mode; the constrained Codex adapter uses an
  ephemeral schema-output run with a read-only/no-approval sandbox and disabled
  web search; and the constrained OpenCode adapter runs an isolated
  `--pure` one-shot with every global and selected-agent tool permission denied.
  See ADR 0003.
- **REQ-WI-M6-LIFECYCLE-001** Optional enrichment attempts are immutable,
  separate children of one valid deterministic run. They retain only profile/model
  IDs, selected evidence IDs, normalized inferred output, timing/usage, and a
  failure summary. Raw prompts, provider responses, source trees, secrets, and
  endpoint configuration are never persisted. A workspace-local preferred attempt
  may be selected or cleared without mutating deterministic artifacts. Archive
  export MAY include a separately labeled Markdown rendering of that normalized
  preferred child; it MUST state that the deterministic report/graph remain
  authoritative.
- **REQ-WI-M6-LIFECYCLE-002** An explicit enrichment cancellation request MUST
  abort only the host-owned in-flight provider operation for that run. If
  profile selection and selected evidence have been established, the host MUST
  retain a separate immutable `cancelled` attempt with no inferred edges; it
  MUST NOT rewrite the deterministic run or make the attempt preferred.
- **REQ-WI-M6-CURATION-001** A user MAY confirm, reject, or annotate an
  inferred relationship after explicitly revealing it. Each action targets the
  stable `from/kind/to` identity and retains selected-evidence IDs plus
  attempt/profile/model provenance as mutable workspace curation. It carries
  forward across compatible runs/providers without altering an immutable
  enrichment attempt or deterministic graph artifact.
- **REQ-WI-M6-SEMANTIC-001** Semantic retrieval MUST be user-invoked and
  host-bounded. It may use only an enabled selected embedding profile and at
  most 200 cbranch-selected deterministic graph chunks. It MUST NOT expose a
  repository path, source tree, agent runtime, tool declaration, or raw provider
  payload to the embedding provider.
- **REQ-WI-M6-SEMANTIC-002** A semantic cache is rebuildable, run-scoped, and
  keyed by profile ID, model ID, and a digest of the selected chunks. It stores
  only schema/version metadata, chunk IDs/digest, dimensions, and a compact
  binary vector matrix—not chunk text, prompts, endpoint configuration,
  credentials, or raw responses. Deleting a run removes its semantic cache, and
  archives exclude it.
- **REQ-WI-M6-SEMANTIC-003** Semantic search MUST preserve the existing bounded
  graph-query and curation boundary. If no suitable profile is selected, remote
  inference is busy/unavailable, or an embedding/index operation fails, it MUST
  return bounded lexical graph results with a safe fallback status rather than
  failing deterministic Workspace Intelligence.
- **REQ-WI-M6-LOCAL-EMBEDDINGS-001** A `local-embeddings` profile MAY use a
  discovered Ollama executable as provenance plus a manual model ID. The host
  MUST NOT spawn that executable for a query; it may call only the fixed
  loopback Ollama embedding endpoint with bounded selected chunks. It MUST
  reject generation capability for that profile, expose no repository cwd,
  shell, tools, or user-configured network endpoint, and fall back to lexical
  results when the local daemon/model is unavailable. See ADR 0004.
