# Running cbranch

The host service serves the built SPA and RPC bus. The UI can partition repositories
by consulting workspace, keep several repos open per workspace, coordinate branch/
fetch work, and use the full focused-repository Git surface.

## One-time

```bash
pnpm install
pnpm -r build          # builds core, rpc-contract, the UI bundle, and the server
```

## Start it

```bash
# Serve the built UI bundle from the host service, bound to loopback.
CBRANCH_CLIENT_DIR="$PWD/packages/ui/build/client" pnpm --filter @cbranch/web-server start
# → cbranch web-server starting on http://127.0.0.1:7420
```

Then open <http://127.0.0.1:7420> in a browser. The UI connects back to the same
origin over `ws://127.0.0.1:7420/rpc`.

Useful env vars (NF-PKG-9): `CBRANCH_BIND_ADDRESS` (default `127.0.0.1`),
`CBRANCH_PORT` (default `7420`), `CBRANCH_CLIENT_DIR` (static bundle dir),
`CBRANCH_CONFIG` (settings file path), `CBRANCH_LOG_LEVEL`. A non-loopback bind
prints a trust warning — cbranch has no app-level auth; keep it behind a trusted
perimeter (SSH tunnel / VPN).

## Development source references

```bash
pnpm dev
```

Open the Vite URL reported in the terminal (normally <http://localhost:5173>). In
development only, React Grab is active: hover an element, press **Cmd/Ctrl-C**, then
paste the copied source reference into the conversation. It is not loaded into the
production bundle.

## How to drive it (what to click)

1. **Create a workspace.** Use the **+** at the bottom of the left rail, name the
   client/workspace, choose an identifying swatch, and upload a PNG, JPEG, GIF, or WebP
   image up to 2 MB. An optional `http(s)` avatar image URL remains available. Uploaded
   images are stored beside cbranch's host config. When no image is set or it cannot load,
   cbranch shows the color-backed workspace initials. Existing recent repos remain explicitly
   unassigned until you add them.
2. **Add repositories.** Click **Add repository** in the workspace overview or press
   **⌘/Ctrl-O**. Type an absolute host path and select **Open path**. The repo is assigned
   to the active workspace and kept in its tab strip. The folder button beside the input
   opens a host-bounded filesystem picker. Repos owned by another workspace switch to that
   workspace instead of silently crossing the boundary.
3. **Coordinate repos.** The overview shows branch, dirty/conflict state, upstream, and
   ahead/behind for every repo. Select a subset to **Fetch selected**, cancel/retry a
   batch, create one **New branch**, or use **Branch matrix** to compare, repair, and
   switch an existing common branch with an explicit carry/stash strategy.
4. **Pull requests.** Open the **Pull requests** segment in the overview. cbranch derives
   GitHub repositories from each real `origin` and delegates to the host `gh` login. Run
   `gh auth login` on the host first; cbranch never stores the token. Filters cover repo,
   author, reviewer, state, branch, title, and number. **New PR** previews the exact
   merge-base-to-HEAD range before creation. Select related PRs and add them to an ordered
   **Change set** with dependency notes.
5. **Focused Git work.** Select a repo row or tab for history, status, staging, commit,
   branches, sync, worktrees, stash, tags, conflicts, rebase, and other repo-scoped tools.
6. **History.** The history pane streams commits (newest first), virtualized
   for large repos. Click a row, or focus the list and use **↑/↓**, to select a
   commit.
7. **Details + diff.** Selecting a commit fills the right panes: commit identity,
   author/committer, full message, and clickable **parents** (top); the changed-file
   list and a unified diff of the selected file (bottom).

## Current multi-repo limits

- Forge integration currently targets GitHub through the host `gh` CLI. GitLab and other
  forge adapters are not implemented.
- PR creation currently treats the focused repository's GitHub `origin` as the target
  repository. The base ref must be fetched locally and the head branch must already be
  pushed at the exact previewed commit.
- Change sets coordinate existing PRs; they do not impose merge queues or automatically
  merge/deploy repositories.
