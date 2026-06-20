# Running cbranch (P1 read-only browser)

The P1 walking skeleton is runnable end-to-end: the host service serves the built
SPA and the RPC bus; the UI opens a repository and lets you browse its history,
commit details, and diffs (read-only).

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

## How to drive it (what to click)

1. **Open a repository.** The app starts on an empty state. Press **⌘/Ctrl-K** (or
   click **Open / switch**) to open the command palette. Type an **absolute path**
   to a git repo on this host (e.g. `/home/you/code/project` or `C:\code\project`)
   and select **Open path**. Previously opened repos appear in the list and are
   fuzzy-searchable.
2. **Status.** The top bar shows the current branch (or a *detached* badge), and
   *empty* / *in-progress* markers when applicable.
3. **History.** The left pane streams the commit history (newest first), virtualized
   for large repos. Click a row, or focus the list and use **↑/↓**, to select a
   commit.
4. **Details + diff.** Selecting a commit fills the right panes: commit identity,
   author/committer, full message, and clickable **parents** (top); the changed-file
   list and a unified diff of the selected file (bottom).

## Known P1 limits (by design / upcoming milestones)

- The commit **graph** is a placeholder dot; lane/edge rendering, ref-label chips,
  filters, and full keyboard nav arrive in the history-polish milestone.
- The diff is a basic unified view; inline/side-by-side toggle, Shiki syntax
  highlighting, the file tree, "view file at revision" (CodeMirror), and large-diff
  deferral arrive in the diff-viewer milestone.
- Working-tree status **counts** (staged/unstaged/untracked) depend on the P2
  `status.get` method; P1 shows branch/detached/empty/in-progress from `repo.state`.
- The live invalidation bus (auto-refresh on external changes) is wired after the UI.
```
