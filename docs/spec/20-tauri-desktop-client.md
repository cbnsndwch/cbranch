# Tauri Windows Desktop Client

## Purpose

`apps/tauri` is the Windows desktop delivery surface for cbranch. It renders the
existing `packages/ui` bundle and uses the unchanged `packages/rpc-contract`
WebSocket protocol. It never opens a server socket, runs Git, stores a Git
credential, or provides a direct network route to the backend.

## SSH-forward transport

The desktop app creates one owned system-OpenSSH process per selected profile:

```text
Windows WebView -- ws/http://127.0.0.1:<local-port> -- ssh -L -->
remote 127.0.0.1:<cbranch-port>
```

- SSH arguments are passed as an argument vector, never through a shell.
- The client uses `-N -T`, `BatchMode=yes`, `StrictHostKeyChecking=yes`, and
  `ExitOnForwardFailure=yes`. Password prompts are deliberately unavailable.
- OpenSSH reads the user's normal agent, keys, `~/.ssh/config`, and
  `known_hosts`. The application stores none of them.
- The local listener is always `127.0.0.1`; it is allocated from an ephemeral
  loopback port and checked before the UI receives an endpoint.
- Connection failure distinguishes missing `ssh.exe`, host-key rejection,
  authentication rejection, unavailable remote host/port, local bind failure,
  and readiness timeout. Recent diagnostics redact URL and key/value secrets.
- Disconnect, profile replacement/deletion, start failure, and application exit
  terminate and reap only the child process created by this app. Existing user
  tunnels are never discovered or killed.

## Profiles and lifecycle

A local JSON profile contains only `{ id, name, host, user, sshPort,
remotePort }`. Validation rejects empty/control-character fields, unsafe option
prefixes, and invalid ports. IPv6 or advanced host syntax should use a safe SSH
config alias in this release.

The connection state machine is `disconnected -> connecting -> connected` with
`connected -> reconnecting -> connected` for a dropped RPC stream and `failed`
for tunnel, transport, or compatibility failures. A deliberate disconnect does
not retry. Switching a profile clears React Query data, unmounts consumers,
disposes the Effect RPC runtime, resets connection-scoped selection, then creates
a fresh runtime and cache for the new endpoint.

The first-run screen lists, creates, edits, tests, connects, disconnects, and
deletes profiles. Its diagnostics view shows the desktop version, selected
profile, tunnel state, endpoint, and redacted errors. It also presents a
copyable, non-secret OpenSSH diagnostic command.

## Backend compatibility and trust

Before mounting normal Git UI, every client calls the typed `system.info` RPC.
The response includes the protocol version and additive capabilities. A protocol
major mismatch or an older backend without this RPC produces an update message,
not partially functioning Git UI.

The remote server still binds `127.0.0.1` by default. The SSH forward reaches it
with a loopback Host, so the existing private-perimeter model is preserved. The
server accepts the exact Windows WebView2 Origin `http://tauri.localhost` only
when loopback-bound; CORS is restricted to that origin for the HTTP side channel.
`Origin: null`, look-alike hostnames, and arbitrary browser origins remain
rejected before route/RPC dispatch.

`packages/ui` receives an injected `{ rpcUrl, httpBaseUrl }` endpoint. Browser
deployments still derive both values from `window.location`; desktop side-channel
URLs resolve against the forwarded HTTP base.

## Windows delivery

The package is configured for a per-user NSIS installer with the existing
cbranch icon. It requires Windows 10/11 WebView2 and the Windows OpenSSH Client.
The app does not install OpenSSH, accept host keys, or use a custom key/password
prompt. Users must resolve those outside the application with normal `ssh`.

The Tauri capability set contains only `core:default` for the main window and
custom profile/tunnel commands. No shell, filesystem, process, clipboard,
opener, or broad plugin permissions are granted. Downloads and file selection
continue through the WebView's normal user-initiated controls.

## Explicit deferrals

Direct remote HTTP/HTTPS/WSS transport, public/LAN backend binding, TLS setup,
application tokens/login, key/password storage, and VS Code remote-client work
are out of scope. Adding any of those requires a new security/product decision.
