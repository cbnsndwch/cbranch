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

The public author SDK is `@cbranch/plugin-contract`. Plugin entrypoints import
their factory type from `@cbranch/plugin-contract/author` and pin the released
SDK major version that matches their manifest's `engines.pluginContract` value:

```ts
import type { PluginFactory } from '@cbranch/plugin-contract/author';

const plugin: PluginFactory = ({ log }) => ({
  commands: {
    'com.example.release.deploy': (_input, { repoId }) => {
      log('info', `Deploying ${repoId}.`);
      return 'Started deployment.';
    },
  },
});

export default plugin;
```

The v1 SDK exposes only `directory`, structured `log`, declared command
handlers, command lifecycle hooks, and `dispose`. It exposes no credentials,
Git, filesystem, network, process, arbitrary host-tool, or browser APIs.
`plugins/hello-world` is
the maintained compatibility fixture for this contract.

Plugins are self-contained `.cbranch-plugin` archives containing `plugin.json`
and the declared ESM entrypoint. Do not run package-manager lifecycle scripts or
download dependencies at installation time.

The first-party test registry is released independently from desktop canaries:

- Desktop/server canary: `vX.Y.Z-rc.N`.
- Plugin registry release: `plugins-<plugin-id>-<version>`.

The registry target version must match `plugin.json`. A private plugin publishes
to its own signed TUF repository and must not commit client proprietary tooling,
credentials, or artifacts to cbranch.

## Private Registry Availability

Authenticated HTTPS registries use the user's configured Git credential helper.
An optional token supplied during repository addition is passed once to `git
credential approve`; subsequent requests obtain a token through `git credential
fill`. The host sends that token only to the configured HTTPS origin with
redirects disabled, and reports a 401 response through `git credential reject`.
Repository lists, locks, audits, errors, and browser state never expose the
token. Cbranch does not implement or fall back to its own plaintext credential
store.

## External Author Workflow

An external plugin author pins the released `@cbranch/plugin-contract` major
version, develops in an isolated private repository, packages a deterministic
archive, and publishes only the signed archive and TUF metadata to a private
registry. Compatibility reports sent to cbranch must contain only sanitized
manifest and contract data. Do not send proprietary source, build logs,
repository paths, credentials, or client identifiers.
