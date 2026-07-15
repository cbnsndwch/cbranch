# Changelog

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
