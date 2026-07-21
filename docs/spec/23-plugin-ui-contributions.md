# Plugin UI Contributions

**Status:** current v1 contract plus proposed surfaces. This document is the
public handoff for independently developed plugins. It contains no client
implementation or build-tooling requirements.

## Trust Boundary

Plugins provide manifest data and command results. cbranch owns all DOM, React,
CSS, focus management, keyboard handling, layout, confirmations, and network
access. A plugin must not provide markup, stylesheets, browser code, URLs, or
event callbacks.

The plugin runtime is trusted host ESM, not a Node sandbox. Capabilities only
govern cbranch-provided APIs. A private plugin must declare only the capabilities
it needs and treat all host code and proprietary build tooling as external to
this repository.

## Current v1 Surface

The only persistent command surface is the existing top-level **Plugins** menu.
Each command is either direct or placed into a host-rendered submenu path.

```json
{
  "id": "com.example.release.deploy",
  "title": "Deploy preview",
  "placement": "plugins",
  "submenu": ["Release", "Preview"]
}
```

- Omit `submenu` for one direct action below **Plugins**.
- `submenu` is an ordered array of display labels. cbranch creates and merges
  the nested menus; plugins cannot create a new top-level menu.
- Commands from a disabled plugin are unavailable.
- A command id must begin with `<plugin-id>.` and exactly match a command
  implemented by the reviewed ESM module.

The command receives `{ repoId, engagementId? }`. It may return a legacy string
or JSON-compatible value, capped at 1 MiB. It may instead return one of these
host-rendered structured results:

```ts
{ _tag: "notice", message: string }
{ _tag: "dialog", title: string, body: string }
{ _tag: "panel", panelId: string }
```

`notice` and `dialog` render with existing host primitives. `panel` is reserved
for a declared future panel surface; do not rely on it for private-plugin UI yet.

## Manifest Skeleton

```json
{
  "schemaVersion": 1,
  "id": "com.example.release",
  "version": "1.0.0",
  "displayName": "Release Tools",
  "publisherFingerprint": "sha256:...",
  "engines": { "cbranch": ">=0.2.2 <1.0.0", "pluginContract": 1 },
  "runtime": "trusted-esm",
  "entrypoint": "plugin.mjs",
  "capabilities": ["ui.contribute"],
  "automation": [],
  "contributes": {
    "commands": [
      {
        "id": "com.example.release.deploy",
        "title": "Deploy preview",
        "placement": "plugins",
        "submenu": ["Release"]
      }
    ],
    "panels": []
  }
}
```

## Proposed Surface Registry

The following are design targets, not v1 plugin contract fields. Private plugins
must not ship against them until a versioned contract and canary demonstrate
them:

| Surface | Proposed identifier | Host rule |
| --- | --- | --- |
| Commit context menu | `context.commit` | Receives the selected commit identity only. |
| Branch context menu | `context.branch` | Receives the selected branch identity only. |
| File context menu | `context.file` | Receives the selected repository-relative path only. |
| Working-tree context menu | `context.workingTree` | Host retains destructive confirmations. |
| Right drawer | `drawer.right` | Host-owned, resizable, dismissible region. |
| Bottom drawer | `drawer.bottom` | Host-owned, resizable, dismissible region. |
| Dedicated view | `view.plugin` | Host-owned route/tab with plugin identity. |
| Dialog | command result `dialog` | Host controls modal behavior and dismissal. |

New surfaces must be closed identifiers in a versioned manifest schema. A plugin
may supply labels and declarative data, but never arbitrary layout paths outside
the designated surface.

## Packaging and Release

Plugins are self-contained `.cbranch-plugin` archives containing `plugin.json`
and the declared ESM entrypoint. Do not run package-manager lifecycle scripts or
download dependencies at installation time.

The first-party test registry is released independently from desktop canaries:

- Desktop/server canary: `vX.Y.Z-rc.N`.
- Plugin registry release: `plugins-<plugin-id>-<version>`.

The registry target version must match `plugin.json`. A private plugin publishes
to its own signed TUF repository and must not commit client proprietary tooling,
credentials, or artifacts to cbranch.
