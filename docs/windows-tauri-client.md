# Windows Tauri Client Setup

## Managed Remote Server

The default **Set up cbranch** action installs the server and starts a
per-user `systemd` service through SSH. It requires a Linux x86_64 remote host
with Node 20+ and an active systemd user manager. It does not require a remote
cbranch checkout, pnpm, or GitHub access.

Node installed through NVM is supported: when `node` is absent from the
non-interactive SSH `PATH`, setup loads `$NVM_DIR/nvm.sh`, defaulting to
`$HOME/.nvm/nvm.sh`.

The managed server remains loopback-only. Do not expose it on a LAN or the
public internet; cbranch v1 has no application login or token.

From Windows, verify SSH before opening cbranch desktop:

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes user@server exit
```

If this reports a host-key prompt, run normal `ssh user@server` first and verify
the fingerprint. If it reports `Permission denied`, load/configure the key in
your normal SSH agent or `%USERPROFILE%\.ssh\config`.

## Desktop profile

1. Install the current-user cbranch NSIS installer.
2. Create a profile with its display name, SSH host/config alias, SSH user and
   port, and the remote cbranch port (usually 7420).
3. Select **Test tunnel**. This validates strict-host-key SSH forwarding without
    retaining the process.
4. Select **Connect**. The application creates a temporary local
    `127.0.0.1` port, verifies that cbranch responds through it, then connects
    the existing UI.

If no server is found, select **Set up cbranch**. The desktop installs a
version-matched server, starts it, and automatically updates the profile if it
must choose another loopback port. Use **Set up manually instead** only when you
need to control the installation yourself.

## Common failures

- **OpenSSH not found:** install the Windows OpenSSH Client optional feature,
  then restart cbranch.
- **Host-key verification failed:** verify the host key with normal OpenSSH;
  cbranch intentionally cannot accept it for you.
- **Authentication failed:** configure an SSH key/agent or an SSH config alias.
  Password entry is intentionally unsupported.
- **Tunnel cannot reach remote cbranch:** confirm the remote server is running,
  listening on `127.0.0.1:<remote-port>`, and that the profile targets the
  correct SSH host/port.
- **Managed setup cannot start:** install Node 20+, ensure an active
  `systemd --user` manager is available on the Linux x86_64 host, or use the
  manual setup option.
- **Backend compatibility failed:** update the remote cbranch server or the
  desktop client so both support the same protocol version.

The **About and diagnostics** control displays redacted tunnel details and a
copyable diagnostic command for a support report. It never includes passwords,
private keys, or application tokens because cbranch does not have or store them.
