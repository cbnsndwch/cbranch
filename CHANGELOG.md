# Changelog

## v0.2.4

### Bug Fixes

- Bootstrap public plugin registry trust without credential lookup by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.2.3...v0.2.4

## v0.2.3

### Bug Fixes

- Guide plugin publisher trust and allow repository removal by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.2.2...v0.2.3

## v0.2.2

### Features

- Add a durable OpenCode goal supervisor by @cbnsndwch
- Add the operator TUI goal-launch workflow by @cbnsndwch
- Add the `bro` OpenCode clarification command by @cbnsndwch
- Add a private plugin registry author SDK by @cbnsndwch
- Add host-owned plugin submenus by @cbnsndwch
- Release the hello-world plugin 0.1.1 by @cbnsndwch
- Add declarative plugin contribution UI by @cbnsndwch
- Streamline connection profiles by @cbnsndwch
- Improve canary repository defaults by @cbnsndwch
- Isolate the canary desktop application by @cbnsndwch
- Add a canary plugin lifecycle by @cbnsndwch
- Enable trusted ESM extensions by @cbnsndwch
- Add runtime plugin foundations by @cbnsndwch

### Bug Fixes

- Persist the verified TUF target version by @cbnsndwch
- Reject credential control characters in the web server by @cbnsndwch
- Publish plugin registry branch updates by @cbnsndwch
- Wrap plugin command result output by @cbnsndwch
- Serialize installed plugin responses by @cbnsndwch
- Validate matching canary RPC servers by @cbnsndwch
- Accept matching managed canary servers by @cbnsndwch
- Check desktop updates before connecting by @cbnsndwch
- Stamp the server bundle version for canary builds by @cbnsndwch
- Report managed server versions in canary builds by @cbnsndwch
- Serialize verified plugin catalog entries by @cbnsndwch
- Reload trusted plugin catalogs by @cbnsndwch
- Embed a distinct Windows canary icon by @cbnsndwch
- Use a shared UI build identity by @cbnsndwch
- Configure the canary-feed author by @cbnsndwch
- Publish immutable canary releases by @cbnsndwch
- Align canary release packaging by @cbnsndwch
- Install the browser for the canary gate by @cbnsndwch
- Run the canary gate on Linux by @cbnsndwch
- Ignore prerelease tags in stable publishing by @cbnsndwch
- Retain the trusted plugin registry root by @cbnsndwch
- Accept semantic RC tags in CI by @cbnsndwch

### Maintenance

- Document the goal-supervisor TUI workflow by @cbnsndwch
- Update workspace dependencies by @cbnsndwch
- Add the goal-supervisor specification by @cbnsndwch
- Remove the obsolete OpenCode plugin by @cbnsndwch
- Add the plugin UI-contributions implementation plan by @cbnsndwch
- Trigger registry publishing by tag by @cbnsndwch
- Format release workflows by @cbnsndwch
- Update GitHub Actions labels by @cbnsndwch
- Enable VS Code experimental modern UI by @cbnsndwch
- Document the trusted plugin lifecycle by @cbnsndwch
- Document the trusted plugin model by @cbnsndwch
- Add plugin workspace lock entries by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.2.1...v0.2.2

## v0.2.1

### Features

- Add manual desktop update checks and an About dialog with connection diagnostics
  by @cbnsndwch

### Maintenance

- Specify the sandboxed runtime plugin system and trusted repository model by
  @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.2.0...v0.2.1

## v0.2.0

### Bug fixes

- Sign Windows updater artifacts in CI by @cbnsndwch
- Compile Tauri tests and run server-bundle packaging correctly on Windows by
  @cbnsndwch

### Maintenance

- Cache Rust build outputs in Windows CI by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.9...v0.2.0

## v0.1.9

### Maintenance

- Create the signed GitHub release from the Windows build job and support server
  bundle packaging on Windows by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.8...v0.1.9

## v0.1.8

### Maintenance

- Restore Windows-only desktop release builds and package the server resource before
  Windows Tauri tests by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.7...v0.1.8

## v0.1.7

### Maintenance

- Install Tauri's Linux GTK and WebKit build dependencies in the release workflow
  by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.6...v0.1.7

## v0.1.6

### Features

- Add signed, in-app desktop updates from GitHub Releases by @cbnsndwch
- Support Tailscale SSH browser check-mode authentication without storing
  credentials by @cbnsndwch
- Add a selected-commit file tree and a pinable session activity panel for Git
  synchronization output by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.5...v0.1.6

## v0.1.5

### Fixed

- Exclude generated dependency/cache trees and duplicate Git-directory coverage from
  repository watchers, preventing large worktrees from saturating the cbranch server
  by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.4...v0.1.5

## v0.1.4

### Fixed

- Detect older managed servers before mounting the UI and offer an explicit
  **Update cbranch** action instead of failing on newer RPC methods by @cbnsndwch
- Bound host directory enumeration and metadata probes to keep large home-folder
  listings responsive by @cbnsndwch
- Show repository-opening progress, prevent duplicate opens, reuse the initial
  repository state, and surface filesystem-listing errors by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.3...v0.1.4

## v0.1.3

### Features

- Import selected Git repositories from a host folder into a new or existing
  workspace, with bounded shallow discovery, atomic membership updates, and
  protection against cross-workspace moves by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.2...v0.1.3

## v0.1.2

### Bug fixes

- Generate a valid systemd user-service working directory during managed remote
  setup by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.1...v0.1.2

## v0.1.1

### Bug fixes

- Load NVM-managed Node.js during non-interactive SSH managed-server setup,
  allowing remote hosts with Node 20+ installed through NVM to provision
  successfully by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/compare/v0.1.0...v0.1.1

## v0.1.0

### Features

- Browse repository history with commit graphs, filters, keyboard navigation,
  diffs, and file-at-revision views by @cbnsndwch
- Stage files and hunks, inspect working diffs, create/amend commits, reset,
  undo commits, and manage untracked changes by @cbnsndwch
- Manage branches, remotes, tags, worktrees, stashes, fetch/pull/push, merge
  strategies, and push-retry flows by @cbnsndwch
- Resolve conflicts with side-by-side merge editing; support cherry-pick,
  revert, blame, and file history by @cbnsndwch
- Add maintenance tooling: GC, clean, archive, reflog, bisect, submodules,
  Git config, interactive rebase, notes, patch exchange, and repository
  initialization by @cbnsndwch
- Group repositories into workspaces with editable slug URLs and
  cross-repository coordination by @cbnsndwch
- Add the SSH-forwarded desktop client with reusable connection profiles and
  managed remote-server provisioning by @cbnsndwch
- Add real-time repository invalidation, serialized Git operations, hardened
  path handling, and conflict-safe workflows by @cbnsndwch
- Add tag-driven Windows desktop release packaging with validation, checksums, CI
  quality gates, and browser tests by @cbnsndwch

**Full commit history:** https://github.com/cbnsndwch/cbranch/commits/v0.1.0
