# Commit Graph Rendering (cross-cutting)

## Purpose

cbranch must present a repository's commit history as a vertically scrolling
graph: one row per commit, ordered top-to-bottom, with the connectivity between
commits and their parents drawn as a directed acyclic graph (DAG). The graph is
the primary navigation surface of the application and is reused by multiple
features (history browsing, branch and tag inspection, file history, blame
entry points, and selection of commits for operations such as diff, checkout,
cherry-pick, and reset). It must remain legible, responsive, and visually stable
for repositories ranging from a handful of commits to histories exceeding
100,000 commits.

This section specifies the **observable behavior and outcomes** of graph
rendering. It deliberately does **not** prescribe a lane-assignment or layout
algorithm. The implementer is free to design one directly from commit parent
data, or to adopt a permissively licensed library, provided all requirements
below are satisfied.

## User stories

- As a developer reviewing recent work, I want to scroll through commit history
  and immediately see which commits belong to which line of development, so I
  can follow a branch visually without reading every message.
- As a developer investigating a merge, I want to see where two lines of history
  diverged and where they were merged back together, so I can understand how a
  change entered a branch.
- As a developer on a very large repository, I want the history view to open
  quickly and scroll smoothly even with hundreds of thousands of commits, so the
  tool stays usable at scale.
- As a developer looking for a specific commit, I want branch, tag, and HEAD
  labels drawn on the rows they point at, so I can locate reference tips at a
  glance.
- As a developer working over a high-latency SSH tunnel, I want the graph to
  begin rendering as soon as the first commits are available and fill in as more
  arrive, rather than waiting for the entire history to load.

## Functional requirements

Each requirement is testable and observable. Identifiers are stable.

### Ordering and structure

- **REQ-GRAPH-001** — The graph MUST render exactly one row per commit included
  in the current history query.
- **REQ-GRAPH-002** — Rows MUST be ordered using a stable topological ordering in
  which every commit appears above (earlier than) all of its parents, with
  commit timestamp used as the tie-break ordering among commits not otherwise
  constrained by topology. The chosen ordering MUST be deterministic: the same
  repository state and query MUST always produce the same row order.
- **REQ-GRAPH-003** — Each commit MUST be assigned to a horizontal **lane** (an
  integer column index ≥ 0). A row's commit node is drawn at its lane's
  horizontal position.
- **REQ-GRAPH-004** — For every parent relationship between a commit and one of
  its parents that is present in the rendered set, an **edge** MUST be drawn
  connecting the child node to the parent node, routed through one or more lanes
  so that the connection is visually continuous from the child row down to the
  parent row.
- **REQ-GRAPH-005** — A commit with two or more parents (a merge) MUST render one
  edge to each parent, visibly converging at the merge commit's node.
- **REQ-GRAPH-006** — A commit with two or more children present in the rendered
  set (a branch point) MUST render one edge to each child, visibly diverging from
  the commit's node.
- **REQ-GRAPH-007** — When a parent of a rendered commit is **not** in the
  rendered set (e.g., history was truncated by a limit, or the parent is an
  ancestor beyond the loaded window), the edge toward that parent MUST be drawn
  as an outgoing connection that terminates at the boundary of the rendered
  range rather than connecting to an absent row. The graph MUST NOT draw an edge
  to a nonexistent row.
- **REQ-GRAPH-008** — Lane assignment MUST be stable with respect to scrolling:
  scrolling MUST NOT change the lane of any commit or reroute any edge. The same
  loaded history MUST always present the same lanes and edges regardless of which
  rows are currently in the viewport.

### Lanes and color

- **REQ-GRAPH-009** — Lanes MUST be visually distinguished by color. Adjacent
  lanes MUST use distinguishable colors so that two parallel lines of history are
  not confused.
- **REQ-GRAPH-010** — A given lane's color MUST remain constant while that lane
  exists during a session; color assignment MUST be deterministic for a given
  layout so that re-rendering the same history does not reshuffle colors.
- **REQ-GRAPH-011** — Lane colors MUST be drawn from the active theme palette and
  MUST respect light/dark theme selection. Color MUST NOT be the sole carrier of
  essential information required for correctness (the topology itself is conveyed
  by node and edge geometry); color is an aid to distinguishing lanes.

### Labels (refs)

- **REQ-GRAPH-012** — For each commit that is the tip of one or more refs (local
  branches, remote-tracking branches, tags, and `HEAD`), the corresponding
  label(s) MUST be overlaid on that commit's row.
- **REQ-GRAPH-013** — Label types MUST be visually distinguishable from one
  another (at minimum: local branch, remote-tracking branch, tag, and `HEAD`),
  and each label MUST display the ref's short name.
- **REQ-GRAPH-014** — When `HEAD` is detached, the `HEAD` indicator MUST be drawn
  on the commit currently checked out. When `HEAD` points at a branch, the
  `HEAD` indicator MUST be associated with that branch's label.
- **REQ-GRAPH-015** — When a single commit is the tip of many refs, labels MUST
  remain readable: the row MUST present them without overlapping illegibly,
  collapsing overflow into an expandable affordance (e.g., a "+N" control that
  reveals the full list) rather than truncating silently.
- **REQ-GRAPH-016** — Labels MUST update to reflect ref changes (branch
  created/deleted/renamed/moved, tag added/removed, checkout) after the relevant
  data is refreshed, without requiring a full reload of the graph.

### Scale, virtualization, and streaming

- **REQ-GRAPH-017** — The graph MUST use row virtualization: only rows within (or
  near) the visible viewport are materialized as drawable/DOM content at any
  time. Memory and per-frame work MUST NOT grow proportionally to total commit
  count for scrolling.
- **REQ-GRAPH-018** — The graph MUST support repositories with at least 100,000
  commits and remain interactive (scroll, select, hover) throughout.
- **REQ-GRAPH-019** — History MUST load incrementally/streamed: the first
  available rows MUST become visible and interactive before the full history has
  been read. The view MUST indicate that more history is still loading.
- **REQ-GRAPH-020** — Layout (ordering, lane assignment, edge routing) MUST be
  computed incrementally as commits arrive, so that already-rendered rows are not
  blocked on commits that have not yet loaded. Appending newly arrived commits
  MUST NOT change the lane of, or visibly reflow, commits that were already
  placed (append-only stability), except where additional commits legitimately
  reveal a parent that closes a previously open-ended edge (REQ-GRAPH-007).
- **REQ-GRAPH-021** — Scrolling interaction MUST stay within a smooth frame
  budget: under normal operation the view targets a 60 fps interaction budget
  (~16 ms/frame) for scroll and hover, and MUST NOT block the main UI thread for
  long enough to cause perceptible jank during layout of incoming commits.
- **REQ-GRAPH-022** — When the user scrolls toward the end of the currently
  loaded history, additional history MUST be requested and appended
  automatically (infinite scroll), subject to the streaming/loading model above.

### Selection and navigation

- **REQ-GRAPH-023** — A row MUST be selectable; the current selection MUST be
  visually indicated and exposed to the rest of the application (the selected
  commit drives dependent views such as diff and details).
- **REQ-GRAPH-024** — The graph MUST support keyboard navigation between rows (at
  minimum: move selection up/down, page up/down, jump to top) and MUST keep the
  selected row scrolled into view.
- **REQ-GRAPH-025** — The graph MUST support programmatic "scroll to commit":
  given a commit id, the view scrolls to and selects that commit's row, loading
  more history first if the commit is not yet in the loaded window.
- **REQ-GRAPH-026** — Hovering a node or edge MUST be supported as an interaction
  surface (e.g., to highlight a commit's connected edges); the specific
  highlight behavior is a UI detail, but hover hit-testing on nodes and edges
  MUST be possible.

## Git operations

The engine produces the data the graph consumes. The transport-agnostic
`GitEngine` interface returns commit records and ref records; the underlying
implementation obtains them by invoking the host `git` binary (the single
`GitEngine` backend). The required **inputs** to layout are: each commit's id,
its ordered parent ids, author/committer timestamps, and summary metadata; plus
the set of refs and which commit each points at. The following git invocations
and their documented outputs are the external facts cbranch relies on:

- **Commit/parent enumeration and order.** Run `git rev-list` to enumerate
  commit ids together with their parent ids in topological order, for example:

  ```
  git rev-list --parents --topo-order --date-order <revisions>
  ```

  `--parents` causes each output line to be the commit id followed by the ids of
  its parents (space-separated), which is the parent connectivity the layout
  consumes. `--topo-order` requests topological ordering (no parent shown before
  its children) and is combined with a date-based ordering for the tie-break.
  Equivalently, a formatted enumeration may be used:

  ```
  git rev-list --parents --format=<format> <revisions>
  ```

  to fetch parent ids alongside any per-commit fields (id, abbreviated id,
  author name/email, author and committer dates, subject) needed for the row.
  Output is parsed line by line / record by record; the parser MUST tolerate
  arbitrary characters in commit subjects (use a NUL or otherwise unambiguous
  record/field separator in the chosen format).

- **Streaming.** The enumeration MUST be consumed as a stream (reading process
  stdout incrementally) so rows can be appended to the layout as they arrive,
  satisfying REQ-GRAPH-019/020. A maximum count and/or a since/until window may
  be applied (e.g., `--max-count=<n>`, `--skip=<n>`) to fetch history in pages.

- **Scope of revisions.** The `<revisions>` argument selects what history is
  shown (e.g., `--all` for all refs, `--branches`, `--tags`, `HEAD`, or an
  explicit set of refs/commits). The selected scope determines which commits and
  therefore which edges are rendered; commits outside the scope are treated as
  absent parents per REQ-GRAPH-007.

- **Refs / labels.** Run `git for-each-ref` to enumerate refs and their target
  commit ids for label placement, for example:

  ```
  git for-each-ref --format='%(objectname) %(refname) %(refname:short) %(objecttype) %(*objectname)'
  ```

  This yields, per ref, the object id it points at, its full and short names, and
  (for annotated tags) the dereferenced commit id via `%(*objectname)` so that a
  tag's label is placed on the underlying commit. The current `HEAD` (and whether
  it is detached) is determined from the symbolic ref / `HEAD` resolution exposed
  by the engine.

- The engine MUST NOT assume a particular working-directory state for read-only
  graph queries; these are read operations and do not take the per-repository
  mutation lock. After any host-git mutation elsewhere, the affected
  invalidation domains (`commits`, `refs`) are emitted on the WebSocket
  invalidation bus (see `15-sync-protocol.md`) and the graph re-queries the
  affected data (its head window and ref labels).

## UI/UX requirements

Expressed in terms of the application's component model (React 19 + shadcn/ui
(`base-lyra` on Base UI) + Tailwind v4), virtualization via
`@tanstack/react-virtual`, and server-state via `@tanstack/react-query` driven by
the WebSocket invalidation bus (`15-sync-protocol.md`); the visual styling itself
is out of scope here.

- **REQ-GRAPH-UI-001** — The graph is presented as a single vertically scrolling,
  virtualized list of fixed-height rows. Each row composes: a graph cell (nodes,
  lane segments, and edges for that row), ref labels, and commit summary columns
  (abbreviated id, summary/subject, author, relative date). Column visibility may
  be configurable, but the graph cell and summary are always present.
- **REQ-GRAPH-UI-002** — Ref labels are rendered as shadcn/ui `Badge`-style
  elements, visually differentiated by type, with overflow handled by a
  `Popover`/`HoverCard` or equivalent "+N" disclosure (REQ-GRAPH-015).
- **REQ-GRAPH-UI-003** — A row exposes a context menu (shadcn/ui `ContextMenu`)
  for commit-scoped actions; the actions themselves are specified by other
  feature sections. The graph only guarantees the row is a valid action target
  carrying the commit id.
- **REQ-GRAPH-UI-004** — Loading and streaming state is communicated
  non-blockingly: a subtle progress indicator while more history is arriving, and
  skeleton/placeholder rows are acceptable only at the not-yet-loaded boundary.
  Already-rendered rows MUST NOT flicker or reflow as more history streams in.
- **REQ-GRAPH-UI-005** — Hover and selection states are reflected in the row and
  in the graph cell (e.g., emphasizing the selected commit's connected edges).
  Selection is a single commit by default; multi-select MAY be supported for
  features that require a commit range, but is not required by this section.
- **REQ-GRAPH-UI-006** — The view degrades gracefully at narrow widths: when the
  graph would consume excessive horizontal space (many concurrent lanes), it MUST
  remain horizontally scrollable or cap drawn lane width while still indicating
  that additional lanes exist, rather than clipping nodes without indication.

### Non-binding architecture suggestion

This is a suggestion only and is **not** a requirement. One workable structure is
a virtualized row list (DOM) for layout, hit-testing, labels, and accessibility,
layered over a `<canvas>` (or equivalent GPU-friendly surface) that draws lane
segments, nodes, and edges for the visible window, with the layout computation
(ordering, lane assignment, edge routing) performed off the main thread (e.g., in
a worker) and delivered incrementally. Labels remain DOM elements positioned per
row. Implementers MAY instead use a fully DOM/SVG approach or a permissively
licensed graph layout library, provided the functional requirements (especially
virtualization, stability, and frame budget) are met.

## Acceptance criteria

- Opening a repository renders the graph with rows in a stable topological +
  chronological order (REQ-GRAPH-002), one row per commit (REQ-GRAPH-001).
- For a known merge commit, both parent edges are visible and converge at the
  merge node; for a known branch point, child edges diverge (REQ-GRAPH-005/006).
- Scrolling up and down and returning to a row shows identical lanes, colors, and
  edges for that row as before (REQ-GRAPH-008/010).
- Branch, remote-tracking branch, tag, and `HEAD` labels appear on the correct
  rows and are visually distinct; a commit that is the tip of many refs shows an
  overflow disclosure rather than illegible overlap (REQ-GRAPH-012/013/015).
- A detached `HEAD` shows the `HEAD` indicator on the checked-out commit
  (REQ-GRAPH-014).
- On a repository with at least 100,000 commits, the first rows appear before the
  full history is loaded (REQ-GRAPH-019), scrolling reaches the end via automatic
  paging (REQ-GRAPH-022), and interaction stays within the frame budget without
  main-thread stalls that cause visible jank (REQ-GRAPH-021).
- As streamed commits arrive, previously placed rows do not change lane or reflow
  (REQ-GRAPH-020).
- Truncating history with a max count produces open-ended outgoing edges at the
  boundary instead of edges to missing rows (REQ-GRAPH-007).
- "Scroll to commit" for an id beyond the loaded window loads more history and
  then scrolls to and selects the target (REQ-GRAPH-025).
- Creating, deleting, renaming, or moving a ref updates the labels after refresh
  without reloading the whole graph (REQ-GRAPH-016).

## Edge cases & error handling

- **Empty repository / no commits.** The graph renders an empty state with a
  clear message; no rows, lanes, or labels are drawn and no error is shown.
- **Single commit / linear history.** Renders a single lane with no edges (single
  commit) or one straight lane (linear history).
- **Root commits and multiple roots.** A commit with no parents terminates its
  lane cleanly. A repository with multiple root commits (unrelated histories,
  e.g., merged-in unrelated history) renders each root terminating its own
  lane(s); their separate sub-DAGs are laid out without spurious connections.
- **Octopus merges.** A commit with three or more parents renders one edge per
  parent, all converging at the merge node, without dropping any parent edge.
- **Wide histories (many concurrent branches).** Large numbers of simultaneous
  lanes must not break virtualization or the frame budget; lane width is bounded
  and excess lanes are scrollable/indicated (REQ-GRAPH-UI-006).
- **Detached HEAD and `HEAD` on an unborn branch.** Detached `HEAD` is labeled on
  its commit. On a repository checked out to an unborn branch (no commits yet),
  the empty-state applies.
- **Annotated vs. lightweight tags.** Annotated tags are placed on the
  dereferenced commit via the tag's target (REQ Git operations); lightweight
  tags are placed on the commit they directly reference.
- **Refs pointing at non-commit objects.** A ref that resolves to a non-commit
  (e.g., a tag of a tree/blob) MUST NOT crash layout; such a ref is either
  omitted from the commit graph labels or placed on its nearest commit if one is
  derivable, but never attached to a nonexistent row.
- **Commits referenced by refs but outside the loaded/scope window.** Labels for
  such refs are not drawn until/unless their commit enters the rendered set;
  resolving them is handled by "scroll to commit" loading more history.
- **Concurrent repository mutation during streaming.** If refs or history change
  while loading, the engine cache invalidation triggers a re-query; the view must
  reconcile to the new data without leaving stale edges to removed commits.
- **git invocation failure.** If the underlying enumeration or ref query fails
  (process error, corrupt repository, permission error), the view surfaces a
  non-blocking error state with the failure reason and a retry affordance; it
  MUST NOT render a partial graph that implies a wrong topology.
- **Malformed/unusual commit metadata.** Commit subjects containing newlines,
  control characters, or extremely long text MUST NOT break row parsing or
  layout; the parser relies on unambiguous record/field separators and the UI
  truncates display text safely.

## Out of scope

- The specific lane-assignment, edge-routing, and color-cycling algorithms (left
  to the implementer per the requirements above).
- Diff rendering, commit detail panels, and any commit-scoped actions (covered by
  their own sections); this section only guarantees the graph is a valid
  selection/action surface.
- File-scoped history and blame layout (separate sections), beyond providing the
  general graph and "scroll to commit" entry points they reuse.
- Search/filter query semantics for history (separate section); this section
  renders whatever revision scope it is given.
- Editing operations (rebase, cherry-pick, reset, etc.) and their conflict flows.
- Exact visual styling, spacing, and iconography beyond the functional
  component-level requirements stated above.
