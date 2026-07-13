# Tauri Desktop Client

## Purpose

`apps/tauri` is the desktop delivery surface for cbranch. It renders the
existing `packages/ui` bundle and uses the unchanged `packages/rpc-contract`
WebSocket protocol. It never opens a server socket, runs Git, stores a Git
credential, or provides a direct network route to the backend.

## SSH-forward transport

The desktop app creates one owned system-OpenSSH process per selected profile:

```text
Tauri WebView -- ws/http://127.0.0.1:<local-port> -- ssh -L -->
remote 127.0.0.1:<cbranch-port>
```

- SSH arguments are passed as an argument vector, never through a shell.
- The client uses `-N -T`, `BatchMode=yes`, `StrictHostKeyChecking=yes`, and
  `ExitOnForwardFailure=yes`. Password prompts are deliberately unavailable.
- OpenSSH reads the user's normal agent, keys, `~/.ssh/config`, and
  `known_hosts`. The application stores none of them.
- The local listener is always `127.0.0.1`; it is allocated from an ephemeral
  loopback port and checked before the UI receives an endpoint.
- Before starting RPC, the desktop WebView requests the forwarded server's
  `GET /healthz` identity endpoint. It includes the server release and protocol
  version, distinguishes an unreachable cbranch server from an unexpected or
  incompatible responder, and keeps the normal Git UI unmounted in either
  case. A server older than the desktop's required same-major release offers
  **Update cbranch** rather than partially functioning UI. `system.info`
  remains the authoritative typed RPC compatibility check after this preflight.
- When the preflight finds no compatible server, the default action streams the
  version-matched server archive over the existing SSH transport and invokes a
  fixed remote bootstrap command. The desktop never sends a user-controlled
  command string to the remote shell.
- Connection failure distinguishes missing `ssh`, host-key rejection,
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

When a tunnel reaches an SSH host but no cbranch service responds at the
configured remote loopback port, the default **Set up cbranch** action installs
the bundled server under the selected remote user's XDG data directory and
starts a `systemd --user` service. Managed setup supports Linux x86_64 hosts
with Node 20+ and an active user service manager. It keeps the server bound to
`127.0.0.1`; if the configured port is occupied, the installer selects another
  available loopback port and updates the local profile. The installer accepts
  readiness only after `/healthz` reports the deployed release version. A
  manual setup path is available for operators who need to retain full control.

## Backend compatibility and trust

Before mounting normal Git UI, every client calls the typed `system.info` RPC.
The response includes the release version, protocol version, and additive
capabilities. A protocol mismatch, an older same-major backend, or an older
backend without this RPC produces an update message, not partially functioning
Git UI.

The remote server still binds `127.0.0.1` by default. The SSH forward reaches it
with a loopback Host, so the existing private-perimeter model is preserved. The
server accepts exact Tauri origins only when loopback-bound: Windows WebView2 uses
`http://tauri.localhost`, while macOS and Linux use `tauri://localhost`. CORS is
restricted to those origins for the HTTP side channel. `Origin: null`, look-alike
hostnames, and arbitrary browser origins remain rejected before route/RPC dispatch.

`packages/ui` receives an injected `{ rpcUrl, httpBaseUrl }` endpoint. Browser
deployments still derive both values from `window.location`; desktop side-channel
URLs resolve against the forwarded HTTP base.

## Desktop delivery

Stable `vMAJOR.MINOR.PATCH` tags produce a GitHub Release with a per-user Windows
NSIS installer, macOS Apple Silicon and Intel DMGs, and Ubuntu DEB/AppImage bundles.
The release workflow builds a Linux x86_64 server archive once, embeds it in each
desktop artifact, and publishes it with the release assets and checksums.
The current artifacts are unsigned manual downloads. Windows requires WebView2 and
an OpenSSH client; macOS and Linux require their normal system OpenSSH client. The
app does not install OpenSSH, accept host keys, or use a custom key/password prompt.
Users must resolve those outside the application with normal `ssh`.

Windows release binaries use the GUI subsystem, and the owned `ssh.exe` child
is launched without a console window. SSH failures remain available as
redacted in-application diagnostics; a terminal is not part of the user
interface.

The Tauri capability set contains only `core:default` for the main window and
custom profile/tunnel commands. No shell, filesystem, process, clipboard,
opener, or broad plugin permissions are granted. Downloads and file selection
continue through the WebView's normal user-initiated controls.

## Explicit deferrals

Direct remote HTTP/HTTPS/WSS transport, public/LAN backend binding, TLS setup,
application tokens/login, key/password storage, and VS Code remote-client work
are out of scope. Adding any of those requires a new security/product decision.

Automated Node installation, non-Linux or non-x86_64 remote hosts, systemd user
lingering, service removal, and multi-user service ownership remain deferred.
