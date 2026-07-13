# Phase 8 — Multi-Repository Workspaces

## Purpose

Phase 8 turns cbranch from a flat recent-repository client into a daily-driver
workspace for consulting work. Repositories are partitioned into named
**workspaces**; each workspace restores its own open repository set and exposes
cross-repository branch, sync, and pull-request coordination without mixing one
client's data into another client's view.

This phase supersedes the original P1 limitation that only one repository may be
open at a time. One repository remains the **focused editor context** for history,
diff, staging, and destructive operations, while a workspace may keep several
repositories open and query their summary state concurrently.

## Terminology

The product UI and operator documentation use **workspace**. The persisted
`engagements` array, `Engagement*` type and RPC names, and `engagementId` remain
compatibility identifiers; they do not change the user-facing vocabulary. Each workspace
also has a unique, editable URL slug, generated from its name when created.

## Invariants

- A repository belongs to at most one workspace. Reassignment is atomic and
  removes it from its previous workspace.
- No aggregate, search, batch operation, notification count, or forge query may
  include repositories outside the active workspace.
- Open-tab order and last active repository are persisted per workspace on the
  host, not in browser-local storage.
- Git mutations remain serialized per repository. A batch operation may run on
  independent repositories concurrently, but it reports each repository's result.
- cbranch stores workspace metadata but never forge credentials. GitHub/GitLab
  authentication uses host-provided CLIs or credential mechanisms.

## Functional Requirements

### Workspaces and membership

- **REQ-P8-ENG-001** The host config MUST persist named workspaces with stable internal
  ids, unique editable URL slugs, identifying colors, an optional avatar image URL or host-stored raster upload,
  creation/update timestamps, repository membership,
  ordered open repo ids, and the last active repo id.
- **REQ-P8-ENG-002** The UI MUST create, rename, edit a URL slug, recolor, upload or clear a PNG, JPEG,
  GIF, or WebP avatar image up to 2 MB, reorder workspaces from the rail or manager, and
  delete workspaces. A missing or failed avatar MUST fall back to color-backed initials.
  Deleting a workspace MUST leave every repository on disk and move its members
  to an explicit unassigned set.
- **REQ-P8-ENG-003** Membership MUST be exclusive. Assigning a repository to one
  workspace MUST remove it from every other workspace in the same atomic config
  write.
- **REQ-P8-ENG-004** Existing recent repositories MUST migrate safely as
  unassigned repositories. No migration may guess a client boundary from paths.
- **REQ-P8-ENG-005** Repository switching MUST group entries by workspace. If a
  selected repo belongs to another workspace, cbranch MUST switch to that
  workspace; it MUST NOT silently move the repo across the partition.
- **REQ-P8-ENG-006** The UI MUST support importing selected repositories from a
  host folder into either the current workspace or a newly named workspace. The
  host MUST scan only immediate, non-hidden, non-symlinked directory children,
  resolve each candidate through Git, and bound the candidate count. Import MUST
  revalidate the selected paths and persist recent entries, membership, open tabs,
  and the active workspace in one config write. A repository owned by another
  workspace MUST be shown as unavailable and MUST NOT be moved by import.

### Concurrent repository session

- **REQ-P8-SESSION-001** Each workspace MUST persist an ordered set of open
  repositories and restore its last active repository when selected.
- **REQ-P8-SESSION-002** The shell MUST expose workspace switching, a workspace
  overview, open-repository tabs, add/open, close, and tab switching without
  discarding another open repository's cached view state.
- **REQ-P8-SESSION-003** Routes MUST encode the workspace boundary with its slug
  (`/w/:workspaceSlug`, `/w/:workspaceSlug/r/:repoId`, and
  `/w/:workspaceSlug/r/:repoId/commits/:oid`) while retaining `/repos/:repoId` deep
  links for unassigned repositories.
- **REQ-P8-SESSION-004** A workspace-scoped repo deep link MUST add that repo to
  the workspace's open set. A repo id that is not a member MUST be rejected by the
  host session operation.
- **REQ-P8-SESSION-005** New and newly opened repositories MUST be assigned to the
  current workspace before navigation completes. With no current workspace they
  remain explicitly unassigned.

### Cross-repository overview and branches

- **REQ-P8-OVERVIEW-001** The workspace overview MUST show every member repo's
  availability, current branch/detached state, staged/unstaged/conflict counts,
  upstream, and ahead/behind state, kept live by each repo's invalidation stream.
- **REQ-P8-OVERVIEW-002** The user MUST select a subset of workspace repos and
  fetch all selected repos with per-repo completion/failure reporting and cancel.
- **REQ-P8-BRANCH-001** The user MUST create and switch to the same branch name
  across selected repos. Partial failure MUST identify each failed repo and MUST
  never roll back successful independent repos implicitly.
- **REQ-P8-BRANCH-002** The overview MUST support switching selected repos to an
  existing common branch, with dirty-tree strategy chosen explicitly when needed.
- **REQ-P8-BRANCH-003** A branch matrix MUST compare the selected branch's local
  and upstream state across repos and expose per-repo repair actions.

### Pull requests and review coordination

- **REQ-P8-PR-001** For each configured forge remote, cbranch MUST list open pull
  requests scoped to the active workspace, including repo, number, title, source/
  target branches, author, draft/review state, checks summary, and update time.
- **REQ-P8-PR-002** The workspace MUST filter pull requests by repo, author,
  reviewer, state, and branch, and MUST provide direct host links for repo, branch,
  commit, and PR.
- **REQ-P8-PR-003** The user MUST create a pull request from a focused repo and
  edit title/body/base/draft state. cbranch MUST preview the exact head/base and
  commit range before creation.
- **REQ-P8-PR-004** A coordination view MUST group related PRs across repositories
  into a named change set, preserving ordering/dependency notes without requiring
  every repo to use the same branch name.
- **REQ-P8-PR-005** Forge credentials MUST remain outside cbranch config. Missing or
  expired host credentials MUST produce a per-forge actionable state without
  hiding local Git functionality.

### Reliability and privacy

- **REQ-P8-SAFE-001** Cross-repo destructive operations are forbidden. Destructive
  actions remain focused-repo operations with existing explicit confirmation.
- **REQ-P8-SAFE-002** Batch operations MUST return a result per repository and may
  be retried only for the failed subset.
- **REQ-P8-PRIV-001** Command logs, diagnostics, and issue templates MUST not emit
  workspace names or repository paths unless the user explicitly includes them.
- **REQ-P8-A11Y-001** Workspace colors MUST always be accompanied by initials or a
  name. Rails, tabs, tables, and batch dialogs MUST be keyboard-operable.

## RPC Additions

Phase 8 adds these app-level methods to the existing RPC group:

- `EngagementList`
- `EngagementDirectoryPreview`
- `EngagementCreate`
- `EngagementDirectoryImport`
- `EngagementUpdate`
- `EngagementDelete`
- `EngagementRepoAssign`
- `EngagementRepoRemove`
- `EngagementSessionSet`
- `EngagementActivate`
- `ChangeSetCreate`
- `ChangeSetUpdate`
- `ChangeSetDelete`
- `ChangeSetItemsSet`
- `GitHubPullsList`
- `GitHubPullPreview`
- `GitHubPullCreate`

The `Engagement*` and change-set methods mutate only cbranch's host config and therefore do
not take a per-repo Git lock. Forge methods resolve a real repository through the
transport-agnostic engine and delegate credentials to the host `gh` installation. The
v3 host config migration adds ordered change sets while accepting v2 workspace files
with an empty default.

## Completion Gate

Phase 8 is complete only when ENG, SESSION, OVERVIEW, BRANCH, PR, SAFE, PRIV, and
A11Y requirements above have focused tests; workspace config survives restart;
partition boundaries are tested against cross-client leakage; batch partial failure
and cancellation are exercised; and desktop/mobile browser screenshots verify the
rail, tabs, overview, branch matrix, and PR coordination surfaces.

## Out of Scope

- Cross-workspace aggregate dashboards or batch operations.
- Hosting repositories, issues, CI, or pull-request data inside cbranch.
- Storing GitHub/GitLab access tokens in cbranch config.
- Treating separate OS users as cbranch tenants; deployment remains personal and
  single-user behind the trusted perimeter.
