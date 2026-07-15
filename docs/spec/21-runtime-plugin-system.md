# Phase 9 — Runtime Plugin System & Distributed Repositories

## Purpose

Phase 9 adds a runtime plugin system to cbranch. A plugin extends cbranch with
commands, panels, repository automation, and integrations without adding its
code to the cbranch release. Plugins are installed on the host, execute on the
host, and are usable from the browser and desktop clients through the existing
typed RPC connection.

The initial product priority is **host automation**. Plugins may automate Git
and host tools for repositories in the active engagement workspace, but only
through a permissioned host broker. This is a deliberate high-trust feature:
installed plugin code can cause material changes to repositories and invoke
approved host programs. The system therefore treats a plugin installation as a
software-supply-chain decision, not as a UI customization.

Plugins are distributed from multiple independently operated repositories,
including private repositories. Repository metadata and artifacts use The
Update Framework (TUF) roles and target digests so a compromised mirror,
transport, or repository server cannot substitute an unsigned artifact or
silently replay an expired release.

This document supersedes P7's plugin deferral (`REQ-P7-PLUGIN-001`) once Phase
9 is accepted. It does not alter the v1 trust model: cbranch remains a personal,
single-user service behind a trusted perimeter and does not become a public
multi-tenant plugin marketplace.

## Product decisions

The following decisions are fixed for the first release of this phase:

- The primary capability is host automation, not merely read-only insights.
- Plugins may receive a workspace-scoped filesystem and repository grant after
  explicit approval. The active engagement workspace is the default boundary;
  access outside it is a separate, high-risk grant.
- Repositories may be public or private. Private HTTPS access uses a token held
  only in the host OS secret store. Private Git repositories use the host's SSH
  configuration, keys, and agent; cbranch does not collect or store SSH keys.
- Only artifacts signed by an explicitly trusted publisher are installable.
  Untrusted repositories may be added and browsed, but cannot install or update
  plugins.
- Ordinary updates require review. A security update may install automatically
  only when it is publisher-signed, carries a signed advisory reference, remains
  within the installed major version, and requests no new or broader permission.
- Plugins are disabled by default after installation. Permission approval and a
  separate explicit enable action are required before code may run. A disabled
  plugin has no running code and no host access.

## Goals

- Let users add, browse, install, disable, configure, update, and remove
  plugins from more than one repository.
- Support public HTTPS repositories, private HTTPS repositories, and Git
  repositories reachable through HTTPS or SSH.
- Make publisher identity, signature status, source repository, version,
  requested permissions, and update rationale visible before installation.
- Run plugin logic outside the browser and without exposing a raw `GitEngine`,
  raw RPC client, Node API, environment, credential, or host filesystem handle.
- Permit useful workspace-scoped automation while enforcing a reviewable,
  least-privilege capability grant at every host operation.
- Make installation and update selection reproducible and recoverable.
- Preserve existing package boundaries: only `apps/web-server` opens sockets or
  spawns non-Git host processes; `packages/core` remains transport-agnostic and
  is the only package that directly orchestrates Git.

## Non-goals

- A public marketplace, account system, publisher-hosting service, ratings, or
  social discovery.
- Installation from arbitrary URLs, local directories, npm, or a Git branch
  without signed repository metadata.
- Arbitrary JavaScript/TypeScript execution in the web-server process, Node
  module loading, native addons, shell scripts, or direct browser DOM access.
- A security guarantee against a plugin granted the broad `hostAutomation`
  capability. Such a grant is equivalent to trusting that publisher's code to
  act as the host user within the approved scope.
- Automatic ordinary feature updates, dependency resolution at runtime, or
  plugin-to-plugin imports in the initial release.
- Altering cbranch's app authentication, loopback binding, Origin/Host guard, or
  Git remote credential model.

## Personas and user stories

- As a developer, I add my team's private plugin repository and authenticate
  without placing its token in a URL, browser store, config file, or log.
- As a developer, I inspect a plugin's publisher, source, permissions, release
  notes, and artifact digest before installing it.
- As a developer, I run a trusted release-management plugin against repositories
  in the current engagement without handing the plugin an unrestricted Node
  process or my Git credentials.
- As a security-conscious user, I can disable a plugin immediately, inspect its
  audit history, revoke its permissions, and return to the last known-good
  version after a bad release.
- As a team maintainer, I publish signed metadata and self-contained plugin
  artifacts from our existing private Git or HTTPS infrastructure without
  registering with a cbranch-operated service.
- As a publisher, I issue a signed security advisory and replacement artifact
  that cbranch can install automatically only when the update cannot broaden the
  existing authority.

## Concepts

- **Plugin repository.** An HTTPS endpoint or Git repository containing the
  versioned TUF metadata and plugin targets described in this document. A
  repository is a distribution source, not a cbranch Git repository.
- **Publisher.** The organization or person controlling one or more trusted TUF
  root keys. Its stable publisher fingerprint is derived from its trusted root
  metadata, not from its display name or repository URL.
- **Trust root.** The locally approved TUF root metadata and threshold keys for
  a publisher. Adding or rotating one always requires an explicit user action.
- **Plugin artifact.** A self-contained, immutable `.cbranch-plugin` archive
  selected by signed target metadata and verified by SHA-256 and length before
  extraction. It contains no runtime-downloaded dependencies.
- **Plugin manifest.** The canonical `plugin.json` contained in the verified
  artifact. It declares identity, compatibility, declarative UI contributions,
  automation actions, and requested capabilities.
- **Grant.** The user-approved subset of a manifest's requested capabilities,
  resource scopes, and command declarations. A plugin cannot exercise an
  ungranted request.
- **Engagement scope.** The set of repository roots owned by the selected Phase
  8 engagement workspace. It is the default filesystem and Git target boundary
  for an automation grant.
- **Security update.** A signed release carrying one or more advisory IDs in
  signed target metadata. It is eligible for unattended installation only under
  the policy in `REQ-PLG-UPD-005`.

## Architecture and execution model

```
Browser / desktop UI
        │ existing typed RPC; plugin UI is declarative data only
        ▼
packages/ui ───────────────► apps/web-server
                                  │
                                  ├─ Plugin repository client + TUF verifier
                                  ├─ Plugin manager / permission broker
                                  ├─ sandboxed plugin worker
                                  │       │ capability requests only
                                  │       ▼
                                  ├─ packages/core GitEngine (Git capabilities)
                                  └─ host-process broker (approved automation)
```

### Package boundaries

- `packages/plugin-contract` defines versioned manifest, capability, declarative
  UI, repository metadata, broker request/result, and audit-event schemas. It
  has no UI, transport, Node process, filesystem, or Git implementation imports.
- `packages/plugin-runtime` hosts the transport-agnostic plugin manager,
  manifest validation, grant evaluation, TUF verification adapter, and worker
  protocol. It MUST NOT open sockets, invoke Git, or spawn a host program.
- `packages/core` remains the only direct Git orchestration layer. The web server
  invokes `GitEngine` on behalf of an approved plugin through a narrow broker;
  plugins never import or receive `GitEngine`.
- `apps/web-server` owns repository fetching, OS-secret-store access, sandbox
  worker lifecycle, host-process execution, and mapping plugin operations to
  existing `GitEngine` methods. It is the only place a non-Git process may be
  spawned for a plugin.
- `packages/ui` renders host-validated declarative contributions and calls only
  the existing cbranch RPC contract. It never downloads an artifact, evaluates
  plugin code, or receives a repository credential.

### Sandboxed worker

Plugins execute in a separately supervised, sandboxed worker runtime, not in
the cbranch Node process. The runtime has no ambient network, filesystem,
environment-variable, subprocess, or DOM access. It communicates with the host
only through a versioned, schema-validated request/response protocol.

The implementation MUST use an OS-supported sandbox plus a capability-oriented
runtime (for example, a WASI/component worker). A JavaScript `vm`, an iframe,
or a permission convention inside a Node process is not a security boundary and
MUST NOT be used as one. If the required sandbox is unavailable on a supported
host platform, plugin execution and installation MUST be unavailable with an
actionable message; cbranch's non-plugin features continue to work.

The host terminates a worker when it is disabled, removed, crashes, exceeds a
resource limit, loses its engagement context, or cbranch shuts down. The host
enforces per-invocation cancellation, time, memory, output-size, and concurrent
worker limits. A plugin crash or timeout fails only that invocation and must not
bring down the host service or leave a repository mutation lock held.

### Declarative UI

Plugins contribute only schema-validated commands, menu placements, forms,
status items, and panels described as data. The cbranch UI renders these with
its own components, localization, accessibility, and CSP. Plugins cannot supply
HTML, CSS, React components, scripts, arbitrary URLs, or event handlers.

This prevents a plugin from escaping the existing browser trust boundary and
ensures menus, dialogs, keyboard navigation, and screen-reader semantics remain
under cbranch's control.

## Distributed repository protocol

### Repository forms

`plugin.repositoryAdd` accepts one of two source kinds:

| Source kind | Canonical location | Use |
| --- | --- | --- |
| `https` | An HTTPS base URL | Static object hosting or a registry service. |
| `git` | A `https://` or `ssh://` Git URL | Existing Git hosting, including private team repositories. |

Plain HTTP, `file:`, local paths, URL userinfo, redirects to another origin, and
custom transport helpers are rejected. HTTPS certificates are validated by the
host OS trust store. Git repositories are fetched with explicit argument arrays,
no checkout, hooks disabled, and the non-interactive host-Git policy from `14
§3.3`; SSH uses the host's configured agent, keys, host verification, and
`known_hosts`.

An HTTPS repository serves the following logical paths below its base URL. A Git
repository carries the same paths in the signed `main` ref; cbranch reads them
from a fetched commit without running repository code.

```
metadata/root.json
metadata/timestamp.json
metadata/snapshot.json
metadata/targets.json
metadata/delegated/<role>.json
targets/<plugin-id>/<version>/<artifact>.cbranch-plugin
```

Repositories MAY delegate targets by namespace or role using standard TUF
delegations. They MUST publish at least `root`, `timestamp`, `snapshot`, and
`targets` metadata. The repository's targets metadata supplies the artifact
hash, byte length, plugin id, version, minimum cbranch/plugin-contract version,
publisher fingerprint, release notes, permission declaration digest, and optional
security advisory IDs. Artifact paths and any custom target fields are data under
the signed targets role and are not trusted before verification.

### TUF trust and freshness

- Cbranch verifies TUF metadata according to its role threshold, expiry,
  version, hash, length, delegation, and rollback rules before showing a target
  as verified or downloading it.
- The initial root is accepted only after the user verifies and approves its
  publisher fingerprint out of band. A repository URL alone is never a trust
  decision.
- Root rotation follows the TUF root-update procedure: the new root must be
  authorized by both the previously trusted root and its own threshold keys.
- A timestamp or targets role that is expired, rolled back, malformed, or signed
  by insufficient keys blocks new installation and update. The installed,
  previously verified version remains runnable offline.
- Repository mirrors, Git hosts, and artifact CDNs are untrusted transport. A
  successful TLS or SSH connection is not proof that an artifact is trusted.
- Cbranch uses the host clock to evaluate expiry. A materially incorrect clock
  yields a visible freshness error and never bypasses expiry validation.

## Private repository access

### HTTPS tokens

For a private HTTPS repository, cbranch asks for an operator-created,
least-privilege read token after the user has added the URL. The token is sent
directly from the host service to that repository over HTTPS and is stored only
in the OS secret store, keyed by the repository's stable local id. Configuration,
lockfiles, logs, browser state, persisted or traced RPC request data, errors,
and diagnostics contain only an opaque credential reference and never the token.

The repository client attaches an authorization header only to the configured
origin, strips it on every redirect, and rejects cross-origin redirects. It
never sends a plugin-repository token to a plugin worker, Git remote, artifact
URL at another origin, or browser client. If no secure secret store is available,
cbranch permits use for the current process only and clearly states that the
credential will not persist; it MUST NOT fall back to plaintext storage.

### Git over SSH

For a private Git repository, cbranch delegates authentication to host Git and
the host's normal SSH configuration. It uses `BatchMode=yes`, does not prompt
through the browser, and reports host-key, unavailable-agent, and authorization
failures distinctly. Cbranch never reads, copies, or persists SSH private keys,
agent material, `known_hosts`, or SSH configuration secrets.

### Repository management UX

The Plugins settings area lists each configured repository with its source URL
(redacted if it contained an invalid secret), source kind, publisher fingerprint,
trust state, last successful metadata refresh, freshness state, and credential
state (`not needed`, `available`, `needs attention`). It offers add, refresh,
disable, remove, trust-root rotation, and credential replacement actions. Removing
a repository does not delete already installed plugins; it prevents future
discovery and update from that source.

## Artifact and manifest format

Each `.cbranch-plugin` archive is a deterministic tar+zstd archive with a
maximum compressed size of 50 MiB and a maximum extracted size of 200 MiB. The
archive contains exactly one root manifest and all runtime assets. It MUST reject
absolute paths, `..` traversal, symlinks, device files, duplicate entries, and
files beyond the declared limits during extraction.

`plugin.json` is JSON validated by the versioned `packages/plugin-contract`
schema. At minimum it contains:

```json
{
  "schemaVersion": 1,
  "id": "com.example.release-automation",
  "version": "1.4.2",
  "displayName": "Release Automation",
  "publisherFingerprint": "sha256:...",
  "engines": { "cbranch": ">=0.3.0 <1.0.0", "pluginContract": 1 },
  "entrypoint": "worker.wasm",
  "capabilities": ["git.read", "git.write", "automation.exec"],
  "automation": [
    {
      "id": "prepare-release",
      "executable": "/usr/bin/make",
      "arguments": ["release-check"],
      "workingDirectory": "repository"
    }
  ],
  "contributes": { "commands": [], "panels": [] }
}
```

Plugin IDs are reverse-DNS ASCII identifiers and immutable once published.
Versions use SemVer. The manifest publisher fingerprint and capability digest
must match the signed target metadata. The artifact contains no executable
format other than the supported sandbox worker format and no package-manager
lockfile or dependency install script.

## Permission model

### Capability groups

| Capability | Authority | Default grant |
| --- | --- | --- |
| `ui.contribute` | Render validated declarative panels, commands, and forms. | Requested by all UI plugins. |
| `git.read` | Read structured Git data for one selected engagement repository. | Per repository selection. |
| `git.write` | Invoke approved cbranch Git mutations for an engagement repository. | Off; explicit confirmation per destructive action remains mandatory. |
| `workspace.read` | Read files under engagement repository roots through capped broker APIs. | Off; explicit workspace grant. |
| `workspace.write` | Write files under engagement repository roots through capped broker APIs. | Off; high risk. |
| `network.connect` | Make brokered HTTPS requests to approved exact origins. | Off; origin allow-list required. |
| `automation.exec` | Execute one manifest-declared host executable and argument template through the broker. | Off; high risk. |
| `hostAutomation` | Broad automation over the host user's authority outside an engagement. | Never granted by default; separate typed confirmation. |

The default `automation.exec` scope is the current engagement workspace. The
broker resolves every repository and filesystem target to a real path and
requires it to fall under an engagement repository root. An invocation has a
single selected repository as its working directory unless the approved action
explicitly operates on another repository in that engagement.

`automation.exec` is not a shell. The manifest declares an absolute executable,
fixed argument template, working-directory policy, declared environment names,
and expected input schema. The broker invokes it as an argument vector, rejects
shell interpreters and `PATH` resolution, provides a minimal sanitized
environment, redacts secrets, and bounds execution time and stdout/stderr. Any
change to the executable path, argument template, environment declaration, or
scope is a new permission request.

`hostAutomation` is available only after a separate dialog that states it can
act with the host user's full permissions and is not constrained by the normal
workspace boundary. It is excluded from automatic security updates and must be
reapproved after every plugin version change.

### Git operations

The Git broker maps each plugin request to a named `GitEngine` method and the
same typed schemas cbranch uses. It never exposes arbitrary Git arguments,
repository paths, ref names, environment variables, or a raw child-process
interface. Existing per-`repoId` locks, cancellation, progress, confirmation,
invalidation, and `GitError` handling continue to apply.

A plugin's `git.write` grant does not bypass a cbranch destructive-action
confirmation. The host displays the plugin name, publisher, operation, affected
repository, and target in the confirmation before invoking a destructive Git
method. Plugin-supplied wording is informational only and cannot alter the
confirmation semantics.

## Lifecycle

1. The user adds a repository URL and, when necessary, supplies host-only
   credentials.
2. Cbranch fetches and verifies TUF metadata, then asks the user to approve the
   publisher fingerprint as a trusted publisher.
3. The user browses verified targets and selects a plugin version.
4. Cbranch downloads the target to a private staging directory, verifies its
   hash/length, validates the archive and manifest, checks compatibility, and
   displays the requested permissions and automation declarations.
5. The user approves a grant. Cbranch atomically activates the artifact and
   writes the installed lock record. The plugin remains disabled; the user must
   explicitly enable it after the grant is recorded successfully.
6. When enabled in an engagement, cbranch starts the sandboxed worker on demand
   and renders its validated contributions.
7. Disabling stops the worker and revokes all subsequent broker requests.
8. Removal stops the worker, deletes its artifacts and grants, and retains only
   redacted audit records according to the user-configured retention policy.

Artifacts live under a host-private data directory (default
`$XDG_DATA_HOME/cbranch/plugins`, or the platform equivalent) with owner-only
permissions. The human-readable host configuration continues to live at the
location specified by `NF-CFG-7`, but stores only repository descriptors,
publisher fingerprints, plugin enablement, and opaque secret references.

`plugins.lock.json` is an atomically written, machine-managed record of every
active plugin's id, version, artifact SHA-256, repository id, TUF target version,
publisher fingerprint, manifest capability digest, and grant digest. It allows a
reinstall to select the same verified targets and makes rollback deterministic.

## Functional requirements

### Core runtime

- **REQ-PLG-001.** The system SHALL execute plugin code only in a separately
  supervised sandbox worker with no ambient filesystem, network, process,
  environment, credential, DOM, or Node-module access.
- **REQ-PLG-002.** The system SHALL expose plugin operations through a versioned,
  schema-validated broker protocol and SHALL reject malformed, unknown, or
  ungranted requests before they reach Git, filesystem, network, or process APIs.
- **REQ-PLG-003.** Only `apps/web-server` MAY create plugin workers, access OS
  secrets, fetch plugin repositories, or spawn brokered host processes.
- **REQ-PLG-004.** Plugin UI contributions SHALL be declarative, schema-validated
  data rendered by `packages/ui`; arbitrary markup, script, stylesheet, React
  component, and browser network contribution types are prohibited.
- **REQ-PLG-005.** Disabling, uninstalling, crashing, timing out, cancelling, or
  losing engagement context SHALL terminate the relevant worker and reject new
  broker requests without affecting core cbranch availability.
- **REQ-PLG-006.** Each brokered operation SHALL carry an operation id and be
  cancellable. Plugin operations that mutate a repository SHALL use the existing
  per-repository lock and invalidation rules.

### Repositories and trust

- **REQ-PLG-REP-001.** Cbranch SHALL support an HTTPS repository and a Git
  repository reachable over HTTPS or SSH, each carrying the TUF layout defined
  above.
- **REQ-PLG-REP-002.** Cbranch SHALL reject plain HTTP, local paths, URL
  userinfo, custom transport helpers, and cross-origin redirects for plugin
  repository or artifact access.
- **REQ-PLG-REP-003.** Before installing or updating a plugin, cbranch SHALL
  verify TUF role thresholds, hashes, lengths, versions, delegations, expiry,
  rollback protection, target digest, and manifest-to-target consistency.
- **REQ-PLG-REP-004.** A publisher SHALL become trusted only after an explicit
  user approval of its root fingerprint. A repository URL, TLS certificate, SSH
  host key, display name, or successful metadata fetch is insufficient.
- **REQ-PLG-REP-005.** Trust-root addition, removal, and root-key rotation SHALL
  be explicit auditable actions. Rotation must satisfy the TUF old-and-new root
  authorization rules.
- **REQ-PLG-REP-006.** Expired, malformed, unavailable, or rollback-suspect
  metadata SHALL block installation and update while leaving an already installed
  verified version runnable. The UI SHALL identify the repository and failure
  without exposing credentials.
- **REQ-PLG-REP-007.** Git-backed repository refresh SHALL fetch data without a
  worktree checkout, Git hooks, shell evaluation, or repository-controlled
  executable code.

### Private access and secrets

- **REQ-PLG-SEC-001.** HTTPS repository credentials SHALL be stored only in an
  OS secret store and referenced elsewhere by an opaque identifier. If a secure
  store is unavailable, cbranch MAY retain a credential in process memory for
  the current run but MUST NOT persist it in plaintext.
- **REQ-PLG-SEC-002.** Repository tokens SHALL never appear in URLs, config,
  lockfiles, logs, diagnostic exports, RPC responses, persisted or traced RPC
  request data, plugin worker messages, or browser state. Known token values
  must be redaction-tested.
- **REQ-PLG-SEC-003.** HTTPS authorization SHALL be sent only to the configured
  origin over TLS and stripped before any redirect; cross-origin redirects shall
  fail.
- **REQ-PLG-SEC-004.** SSH access to a Git repository SHALL use the host's normal
  SSH agent/configuration and non-interactive Git policy. Cbranch SHALL not read,
  persist, or expose SSH private-key or agent material.
- **REQ-PLG-SEC-005.** Plugin code SHALL never receive repository credentials,
  app secrets, host environment variables, or a raw network socket.

### Installation and updates

- **REQ-PLG-INST-001.** Installation SHALL be staged, hash-verified, archive-safe,
  compatibility-checked, atomically activated, and recorded in a lockfile before
  a plugin may run.
- **REQ-PLG-INST-002.** Plugins SHALL be self-contained. The installer SHALL not
  run package-manager commands, lifecycle scripts, artifact hooks, or dynamic
  dependency downloads.
- **REQ-PLG-INST-003.** The installation review SHALL display publisher
  fingerprint, repository, version, artifact digest, release notes, compatibility,
  requested capabilities, workspace scope, automation declarations, and any
  advisory identifiers.
- **REQ-PLG-INST-004.** Cbranch SHALL not install a plugin from an untrusted
  publisher or a target whose signature or digest verification fails.
- **REQ-PLG-UPD-001.** Cbranch SHALL check configured repositories for updates on
  an explicit refresh and no more frequently than once every 24 hours while the
  service is running. Checks make no browser-originated network request.
- **REQ-PLG-UPD-002.** An ordinary plugin update SHALL require user review and
  explicit installation approval.
- **REQ-PLG-UPD-003.** Cbranch SHALL retain the previous verified artifact and
  grant until an update is activated successfully, and SHALL offer rollback to
  any retained verified version.
- **REQ-PLG-UPD-004.** A version that changes publisher fingerprint, plugin id,
  major version, manifest capability digest, automation declaration, executable
  declaration, scope, or grant is never eligible for automatic installation.
- **REQ-PLG-UPD-005.** Cbranch MAY automatically install a security update only
  when the target is TUF-verified from the already trusted publisher, remains in
  the installed SemVer major range, contains at least one signed advisory ID,
  does not trigger any condition in `REQ-PLG-UPD-004`, and the user has enabled
  security-only automatic updates. `hostAutomation` plugins are never eligible.
- **REQ-PLG-UPD-006.** An automatically installed security update SHALL emit an
  audit event and a persistent UI notification naming the plugin, versions,
  publisher, and advisory IDs, with one-click rollback.

### Permissions and automation

- **REQ-PLG-PERM-001.** Every requested capability and resource scope SHALL be
  denied until explicitly granted by the user.
- **REQ-PLG-PERM-002.** The default filesystem and Git scope for an automation
  grant SHALL be repository roots belonging to the active engagement workspace.
  The host SHALL resolve and re-check real paths on every request to prevent
  traversal and symlink escape.
- **REQ-PLG-PERM-003.** A capability request that adds or broadens authority,
  including a new executable, argument template, network origin, writable path,
  Git mutation, or workspace/host scope, SHALL require a new approval and SHALL
  disable the plugin until resolved.
- **REQ-PLG-PERM-004.** `automation.exec` SHALL use an absolute,
  manifest-declared executable and a validated argument vector. It SHALL not use
  a shell, `PATH` lookup, shell interpreter, arbitrary environment, or raw
  command string.
- **REQ-PLG-PERM-005.** Brokered host-process invocations SHALL use a sanitized
  environment, a realpath-validated working directory, cancellation, output
  streaming with a size cap, and a configurable time limit. Credentials and file
  contents shall not be recorded in output or logs.
- **REQ-PLG-PERM-006.** `hostAutomation` SHALL require a separate high-risk
  confirmation stating that it can act with the host user's authority outside
  engagement boundaries. It SHALL be reapproved after every version update and
  shall never auto-update.
- **REQ-PLG-PERM-007.** Plugin-originated Git mutations SHALL use the existing
  `GitEngine` and preserve all cbranch confirmation, locking, cancellation,
  error, and invalidation requirements. A plugin may not bypass a destructive
  action's confirmation.

### User experience and audit

- **REQ-PLG-UX-001.** The Plugins settings surface SHALL show configured
  repositories, trust/freshness/credential states, installed plugins, enabled
  state, version, publisher, grants, updates, and rollback actions.
- **REQ-PLG-UX-002.** Every permission and update review SHALL be keyboard
  operable, focus-trapped where modal, accessible, localized, and specific about
  the action's authority. Approval and cancel controls shall be unambiguous.
- **REQ-PLG-UX-003.** Plugin commands and panels SHALL visibly identify their
  plugin and publisher and show a disabled/unavailable state if the worker,
  grant, repository scope, or sandbox is unavailable.
- **REQ-PLG-AUD-001.** Cbranch SHALL write structured, redacted audit records for
  repository trust changes, installs, removals, enables/disables, grant changes,
  update decisions, brokered Git mutations, host-process invocations, denials,
  and worker crashes/timeouts.
- **REQ-PLG-AUD-002.** Audit records SHALL include time, plugin id/version,
  publisher fingerprint, repository id, engagement/repo id where applicable,
  operation id, capability, outcome, and redacted error code. They SHALL never
  include a credential, command output that contains a secret, or file contents.

## RPC contract delta

The authoritative wire contract remains `14-rpc-contract.md`. This phase adds
the following user-facing methods to the existing `RpcGroup`; all payloads and
results are named schemas in `packages/plugin-contract`, and every error uses
the canonical `GitError` union extended only when no existing code applies.

| Method | Payload | Success | Notes |
| --- | --- | --- | --- |
| `plugin.repositoryList` | `{}` | `PluginRepository[]` | Redacted descriptors and trust/freshness state. |
| `plugin.repositoryAdd` | `{ kind, url, credential? }` | `PluginRepository` | Credential is transferred once over guarded RPC, sent to the secret store, then discarded. |
| `plugin.repositoryRefresh` | `{ repositoryId }` | `RepositoryRefresh` | Fetches and verifies metadata; no plugin code runs. |
| `plugin.repositoryRemove` | `{ repositoryId }` | `void` | Removes source configuration, not installed artifacts. |
| `plugin.publisherTrust` | `{ repositoryId, rootFingerprint, approved }` | `PluginRepository` | Explicit root trust decision. |
| `plugin.catalogList` | `{ repositoryId }` | `PluginCatalogEntry[]` | Only verified signed targets are returned. |
| `plugin.install` | `{ repositoryId, pluginId, version, grant }` | `InstalledPlugin` | Mutating, atomic install. |
| `plugin.list` | `{}` | `InstalledPlugin[]` | Grants are descriptive, never secrets. |
| `plugin.enable` / `plugin.disable` | `{ pluginId }` | `InstalledPlugin` | Starts/stops workers as needed. |
| `plugin.update` | `{ pluginId, version, grant? }` | `InstalledPlugin` | Mutating, explicit ordinary update. |
| `plugin.rollback` | `{ pluginId, version }` | `InstalledPlugin` | Retained verified target only. |
| `plugin.auditList` | `{ pluginId?, cursor? }` | `PluginAuditPage` | Redacted, paged audit records. |
| `plugin.invoke` | `{ pluginId, commandId, repoId, input }` | `PluginInvocation` | Routes a validated command to an enabled worker. |

`plugin.repositoryAdd` is a deliberately narrow exception to the usual advice
that secrets not traverse RPC: its optional credential is accepted only over the
already Origin/Host-guarded private transport, passed immediately to the host
secret-store adapter, redacted from tracing, and never returned or persisted in
the configuration. A future native secret-store picker may remove even this
one-time transfer without changing repository semantics.

Plugin contribution data is part of `plugin.list` / `plugin.invoke` results and
is schema-validated on both worker-to-host and host-to-UI boundaries. It is not a
new browser socket, does not weaken the `/rpc` Origin/Host guard, and must obey
the normal RPC payload cap or use a bounded existing side channel.

## Error handling

The canonical `GitErrorCode` gains only specific plugin failures where the
existing `networkError`, `authRequired`, `authFailed`, `permissionDenied`,
`resultTooLarge`, `cancelled`, `fsError`, and `gitFailed` codes are insufficient:

- `pluginRepositoryUntrusted`
- `pluginMetadataInvalid`
- `pluginMetadataExpired`
- `pluginArtifactInvalid`
- `pluginIncompatible`
- `pluginPermissionDenied`
- `pluginSandboxUnavailable`
- `pluginWorkerFailed`
- `pluginPolicyDenied`

Errors must be actionable and localized. For example, an expired timestamp says
the repository needs a fresh signed metadata release; it does not show a raw
signature stack trace. A worker failure identifies the plugin/version and offers
disable, retry, or rollback. No failure path may leak a token, SSH material,
unredacted source URL secret, or plugin private data.

## Non-functional requirements

- Plugin repository verification, artifact extraction, manifest validation,
  permission comparison, path containment, process-declaration validation, and
  secret redaction MUST have automated tests.
- TUF tests MUST cover insufficient signature threshold, expired metadata,
  rollback/replay, delegated targets, root rotation, artifact substitution, and
  a valid private-repository refresh using fixture transport adapters.
- Runtime tests MUST prove that a worker cannot access host files, network,
  environment, Node modules, or processes except through granted broker calls.
- Broker tests MUST prove that an ungranted request, symlink escape, shell path,
  dynamic executable, broadened update, or missing destructive confirmation is
  rejected without changing the target repository.
- End-to-end tests MUST cover public HTTPS, private token HTTPS, private Git over
  SSH fixture repositories, trust approval, install, disable, workspace-scoped
  invocation, ordinary update review, eligible security auto-update, ineligible
  permission-expanding update, rollback, and credential redaction.
- Plugin activity MUST not block normal cbranch operation. The default worker
  invocation time limit is 60 seconds; the default stdout/stderr cap is 1 MiB;
  defaults are configurable under a dedicated plugin policy section in the host
  config. Exceeding either fails the invocation and records an audit event.
- The UI MUST expose progress and cancellation for repository refresh, download,
  install, update, and long-running plugin invocations.
- Telemetry remains opt-in under `NF-TELEM-1..4`; repository refreshes are
  user-configured software-update traffic, not telemetry, and must be documented
  with their source URLs and scheduling behavior.

## Acceptance criteria

- A user can add a public HTTPS repository, approve its displayed publisher root
  fingerprint, install a verified artifact, approve its workspace grant, enable
  it, and run a declared automation command against an engagement repository.
- A user can add a private HTTPS repository with a token, restart cbranch, and
  refresh it successfully while the token is absent from config, lockfiles, UI,
  logs, audit exports, and browser storage.
- A user can add a private `ssh://` Git repository that uses the host's existing
  SSH agent and `known_hosts`; no SSH secret is displayed, copied, or persisted
  by cbranch.
- A repository that serves an expired timestamp, a target signed by too few keys,
  a replayed metadata version, or an artifact with a mismatching digest cannot
  install or update a plugin.
- A plugin requesting a shell, dynamic executable, workspace escape, raw Git
  argument, raw network socket, or ungranted capability cannot perform that
  operation; the denial is visible in its audit history.
- A signed security release with no authority change updates automatically only
  when the user enabled that policy and receives a persistent advisory notice.
  A release with a broader grant, changed command declaration, major version,
  publisher change, or `hostAutomation` never updates automatically.
- Disabling a running plugin terminates it; a subsequent command invocation is
  rejected; cbranch's ordinary Git UI remains usable.
- Rolling back restores the exact prior verified artifact and grant from the lock
  record and leaves an audit trail.

## Edge cases

- **Offline or unavailable repository:** cached verified plugins keep working;
  discovery and update show stale status rather than using unverified cache data.
- **Expired metadata while offline:** installed plugins keep working, but install
  and update remain blocked until fresh valid metadata is available.
- **Credential revoked or expired:** refresh reports an authentication failure,
  preserves the installed plugin, and offers credential replacement without
  revealing the existing token.
- **Publisher key compromise or revocation:** disabling/removing the local trust
  root immediately prevents new installation and update from that publisher. The
  UI identifies installed affected plugins and offers disable/remove/rollback;
  it never silently uninstalls a user's tools.
- **Engagement changes while automation runs:** the active invocation retains a
  resolved repository scope; new requests are denied until it is explicitly
  invoked in the new engagement.
- **External repository mutation:** plugin-originated and external Git changes
  continue to use the existing filesystem watcher and invalidation bus; plugins
  cannot inject row-level client state.
- **Interrupted install or update:** staging is deleted on recovery and the last
  atomically active lock record remains authoritative.
- **Sandbox unavailable on a platform:** plugin controls explain that the platform
  runtime is unavailable; cbranch never falls back to executing a plugin in Node.

## Open decisions before implementation

- Select and validate the concrete cross-platform sandbox/runtime combinations
  for Linux, macOS, and Windows. The selected solution must satisfy the no-ambient-
  authority requirement; otherwise the platform is unavailable for plugins.
- Decide whether team-managed trust roots can be preprovisioned by a host policy
  file and how that policy interacts with an individual user's ability to remove
  trust.
- Define the supported publisher release tool and CI reference implementation for
  generating deterministic artifacts, TUF metadata, delegation, key rotation,
  and signed security advisories.
- Define retention defaults for old verified artifacts and redacted audit records,
  including disk-pressure behavior and any export format.
- Decide whether `network.connect` is required in the first plugin-runtime cut or
  should follow after the Git and declared-command automation broker is proven.
