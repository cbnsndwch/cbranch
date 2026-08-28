# Sub-Epic 5: Phase 7 Cleanup and VS Code/Remote-SSH

**Status:** Proposed, starts after stabilization

**Parent:** [Stabilization and Next Platform](../README.md)

## Objective

Close the bounded, already-understood Phase 7 shell gaps and then prove the next
major cbranch surface with a VS Code/Remote-SSH walking skeleton. The extension
must reuse the existing UI, RPC group, and Git engine rather than creating a
second product architecture.

The governing requirements are
[`18-phase7-shell-navigation-and-integrations.md`](../../../spec/18-phase7-shell-navigation-and-integrations.md)
and
[`13-vscode-extension.md`](../../../spec/13-vscode-extension.md).

## Goal Plan

```goal-plan
{
  "objective": "Close bounded Phase 7 shell gaps and prove the shared cbranch architecture through a VS Code/Remote-SSH walking skeleton.",
  "authoredBy": "repository-review",
  "units": [
    {
      "id": "p7-command-identity",
      "title": "Reconcile Phase 7 menu command identities",
      "instructions": "Implement P7-CLEAN-1 in this document. Align menu-model and registered-handler IDs for repository creation, go to commit, and edit gitattributes; add a contract-style action-resolution test; keep intentionally deferred actions explicitly disabled.",
      "dependencyIds": [],
      "acceptanceCriteria": [
        "Every intended enabled menu item resolves to its registered action",
        "Deferred actions are explicit rather than disabled by accidental ID mismatch"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "p7-navigation-view",
      "title": "Wire existing navigation and view behavior",
      "instructions": "Implement P7-CLEAN-2 in this document using existing state and contracts. Wire revision, parent/child, find navigation, branch scope, column visibility, and supported graph/view toggles while preserving keyboard and palette behavior.",
      "dependencyIds": ["p7-command-identity"],
      "acceptanceCriteria": [
        "Supported Navigate and View actions work from the menu",
        "Existing keyboard and command-palette behavior remains intact",
        "No unnecessary RPC method is added"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "p7-help",
      "title": "Complete the bounded Help surface",
      "instructions": "Implement P7-CLEAN-3 in this document. Add Manual, Changelog, Keyboard Shortcuts, Report Issue, and accurate About behavior through host-safe primitives while retaining terminal, artificial rows, CI indicators, and unsupported ordering as deferred.",
      "dependencyIds": ["p7-command-identity"],
      "acceptanceCriteria": [
        "The bounded Help actions work through host-safe navigation",
        "About reports the real application and host Git versions",
        "Excluded Phase 7 work remains explicitly deferred"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "vscode-activation-webview",
      "title": "Create the real extension activation and retained webview",
      "instructions": "Implement VSX-1 in this document. Replace the placeholder with lazy command/view activation, one retained webview, correct disposal, and webview-safe asset loading restricted to declared resource roots.",
      "dependencyIds": [
        "p7-navigation-view",
        "p7-help"
      ],
      "acceptanceCriteria": [
        "The extension activates only through declared contributions",
        "One retained webview hosts the product and disposes all resources",
        "Assets outside approved webview roots cannot load"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "vscode-csp-bootstrap",
      "title": "Bootstrap the shared UI with a restrictive CSP",
      "instructions": "Implement VSX-2 in this document. Generate per-load nonces, enforce restrictive CSP with no normal network connection, add a MemoryRouter webview entry, preserve the web target, and do not fork the React tree.",
      "dependencyIds": ["vscode-activation-webview"],
      "acceptanceCriteria": [
        "Every webview load uses a fresh script nonce and restrictive CSP",
        "Normal UI operation requires no network connect-src",
        "The existing packages/ui application is reused without a fork"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "vscode-rpc-transport",
      "title": "Bind typed RPC over postMessage",
      "instructions": "Implement VSX-3 in this document. Adapt postMessage to the existing CbranchRpcs transport, support concurrent correlation, typed closure, and invalidation events, validate inbound envelopes, and open no listener.",
      "dependencyIds": ["vscode-activation-webview"],
      "acceptanceCriteria": [
        "The existing RPC group works over one bidirectional postMessage channel",
        "Malformed inbound envelopes are rejected before dispatch",
        "Closed or reloaded webviews reject in-flight calls instead of hanging",
        "The extension opens no listening socket"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "vscode-platform-adapter",
      "title": "Add web and VS Code platform adapters",
      "instructions": "Implement VSX-4 in this document. Define PlatformAdapter and its persisted state, clipboard, external navigation, theme, and surface facts; implement web and extension adapters; restore state as a non-authoritative cache without credentials.",
      "dependencyIds": ["vscode-csp-bootstrap"],
      "acceptanceCriteria": [
        "Web and extension surfaces conform to one PlatformAdapter interface",
        "Repository, revision, view, and panel state survive webview reload",
        "Persisted webview state contains no credential or transport secret"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "vscode-vertical-slice",
      "title": "Deliver the shared architecture vertical slice",
      "instructions": "Implement VSX-5 in this document. Round-trip system information, open a repository, render history and diff, carry invalidation events, delegate merge opening where required, and prove there is no extension-specific Git construction or parsing.",
      "dependencyIds": [
        "vscode-rpc-transport",
        "vscode-platform-adapter"
      ],
      "acceptanceCriteria": [
        "System information, repository open, history, diff, and invalidation work through postMessage",
        "The extension host uses packages/core and packages/rpc-contract unchanged",
        "No extension-specific Git implementation is introduced"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    },
    {
      "id": "remote-ssh-proof",
      "title": "Prove execution in a real Remote-SSH host",
      "instructions": "Implement VSX-6 in this document. Run the extension host in a real Remote-SSH workspace, prove Git and filesystem work occur remotely, verify the local webview needs no tunnel or localhost service, and document a repeatable smoke test including reload and disposal.",
      "dependencyIds": ["vscode-vertical-slice"],
      "acceptanceCriteria": [
        "A real Remote-SSH run proves Git and filesystem execution on the remote extension host",
        "The local webview requires no SSH tunnel or localhost service",
        "A repeatable activation, repository, history, diff, invalidation, reload, and disposal procedure is recorded"
      ],
      "verificationRequirements": [],
      "required": true,
      "destructive": false
    }
  ],
  "finalVerificationRequirements": [
    {
      "id": "vscode-typecheck",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/vscode-ext", "typecheck"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "vscode-build",
      "type": "command",
      "executable": "pnpm",
      "args": ["--filter", "@cbranch/vscode-ext", "build"],
      "timeoutMs": 600000,
      "outputCapBytes": 2097152,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "vscode-focused-tests",
      "type": "command",
      "executable": "pnpm",
      "args": ["vitest", "run", "apps/vscode-ext", "packages/ui/src"],
      "timeoutMs": 600000,
      "outputCapBytes": 4194304,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "vscode-browser-tests",
      "type": "command",
      "executable": "pnpm",
      "args": ["test:browser"],
      "timeoutMs": 600000,
      "outputCapBytes": 4194304,
      "expectedExitCode": 0,
      "required": true
    },
    {
      "id": "vscode-repository-gate",
      "type": "command",
      "executable": "pnpm",
      "args": ["gate"],
      "timeoutMs": 1800000,
      "outputCapBytes": 8388608,
      "expectedExitCode": 0,
      "required": true
    }
  ]
}
```

## Entry Criteria

- Sub-epics 1 through 4 are complete, or the maintainer has explicitly accepted
  their remaining risks before expanding product scope.
- The repository gate is green without relying on an unexplained flaky failure.
- Phase 9 and goal-supervisor release claims are reconciled.

## Scope

### P7-CLEAN-1: Command identity audit

- Reconcile menu-model and registered-handler IDs for repository creation, go to
  commit, and edit gitattributes.
- Add a contract-style test that every intended enabled menu item resolves to a
  registered action.
- Keep intentionally deferred actions visibly and explicitly disabled rather
  than failing through accidental ID mismatch.

### P7-CLEAN-2: Existing navigation and view wiring

- Wire current revision, parent/child, first/last parent, and find-next/previous
  where the underlying state already exists.
- Wire branch-scope, column visibility, and supported graph/view toggles through
  existing state rather than minting unnecessary RPC methods.
- Preserve keyboard and command-palette behavior while enabling menu access.

### P7-CLEAN-3: Bounded Help completion

- Add Manual, Changelog, Keyboard Shortcuts, and Report Issue actions using
  existing host-safe navigation primitives.
- Verify About reports the real application and host Git versions.
- Explicitly retain terminal, artificial rows, CI indicators, and unsupported
  log ordering as deferred unless separately approved.

### VSX-1: Real extension activation and retained webview

- Replace the `0.0.0` placeholder with a real VS Code extension entrypoint.
- Activate only through the declared command/view contribution.
- Create one retained webview surface and dispose all host resources correctly.
- Load built UI assets only through restricted webview resource roots.

### VSX-2: CSP-safe shared UI bootstrap

- Generate a fresh script nonce for every webview HTML load.
- Apply a restrictive Content Security Policy with no normal-operation network
  `connect-src` requirement.
- Add a `MemoryRouter` webview entry while preserving the existing web target.
- Do not fork the React application tree.

### VSX-3: Typed postMessage RPC transport

- Adapt `webview.postMessage` and inbound webview messages to the existing
  `CbranchRpcs` transport contract.
- Support concurrent request/response correlation, typed closure errors, and
  server-initiated invalidation events over the same channel.
- Validate inbound envelopes before RPC dispatch.
- Open no extension-owned network listener.

### VSX-4: Platform adapter

- Define the UI `PlatformAdapter` required by REQ-VSX-030 through REQ-VSX-037.
- Implement web and VS Code adapters for persisted state, clipboard,
  open-external, theme changes, and surface facts.
- Restore selected repository, revision, active view, and panel state as a
  non-authoritative cache.
- Keep credentials and transport secrets out of persisted webview state.

### VSX-5: End-to-end vertical slice

- Round-trip system information through the shared RPC group.
- Open a repository and render history and diff using the existing core and UI.
- Carry the repository invalidation bus over the postMessage transport.
- Delegate merge-editor opening to VS Code where the extension contract requires
  host-specific behavior.
- Demonstrate that no extension-specific Git command construction or parsing was
  introduced.

### VSX-6: Remote-SSH proof

- Install and run the extension host side in a real Remote-SSH workspace.
- Verify that `GitEngine` and filesystem access execute on the remote extension
  host against the remote repository.
- Verify that the local webview needs no SSH tunnel or localhost service.
- Capture a repeatable smoke-test procedure for activation, repository open,
  history, diff, mutation invalidation, reload, and disposal.

## Acceptance Criteria

- Intended Phase 7 menu/help actions are enabled through matching registered
  handlers, and deferred actions are explicit.
- The extension renders the existing `packages/ui` application without a fork.
- The extension host uses the existing `packages/core` Git orchestration and
  `packages/rpc-contract` group.
- Webview CSP, nonce, resource roots, and message validation meet the VS Code
  specification.
- Repository open, history, diff, and invalidation work through postMessage.
- UI state survives webview reload without storing secrets.
- A Remote-SSH run proves that Git and filesystem work occur on the remote host.
- The extension opens no listening socket.

## Verification

```sh
pnpm --filter @cbranch/vscode-ext typecheck
pnpm --filter @cbranch/vscode-ext build
pnpm vitest run apps/vscode-ext packages/ui/src
pnpm test:browser
pnpm gate
```

The sub-epic must also add a documented manual or automated Remote-SSH smoke test
because local unit tests cannot prove remote extension-host placement.

## Out of Scope

- Full feature parity in the first VS Code slice.
- A forked UI or extension-specific Git implementation.
- Any HTTP, WebSocket, or other listening server owned by the extension.
- Phase 9 broker APIs or plugin execution inside the webview.
- Terminal delivery, CI integration, or other explicitly deferred Phase 7 work.
