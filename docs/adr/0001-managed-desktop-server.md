# ADR 0001: Managed Desktop Server Provisioning

## Status

Accepted

## Context

The desktop client connects over a strict-host-key SSH loopback forward. A new
profile can reach its SSH host without finding a cbranch server, and a manual
source checkout plus pnpm build workflow makes first use unnecessarily fragile.

## Decision

Each desktop release includes a version-matched Linux x86_64 server archive.
The archive contains the bundled Node server, its production dependencies, the
built UI, and a fixed installer. The desktop streams that archive through the
existing SSH transport and invokes only a fixed remote bootstrap command.

The bootstrap installs under the selected user's XDG data directory, writes a
`systemd --user` unit, binds the server to `127.0.0.1`, and starts it. It uses
the profile's port when available; otherwise it selects an unused loopback port
and the desktop updates the profile to match.

Managed setup requires a Linux x86_64 host with Node 20+ and an active systemd
user manager. The server archive travels inside SSH; the desktop never asks the
remote host to clone a repository, run pnpm, or download a dependency. A manual
setup path remains available for operators who need complete control.

## Consequences

- Releases must build the server archive once on Ubuntu and include it in every
  desktop bundle and the GitHub Release assets.
- A managed server is owned by the remote user, not cbranch desktop. Deleting a
  profile does not remove it.
- Without systemd user lingering, a service can stop once the final user session
  exits. Desktop reports this condition rather than attempting a privileged
  `loginctl enable-linger` operation.
- Automated Node installation, non-Linux hosts, non-x86_64 hosts, service
  removal, and multi-user service ownership remain future decisions.
