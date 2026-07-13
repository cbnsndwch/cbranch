# Windows Tauri Client Setup

## Remote server

1. Install Node 20+ and cbranch on the machine holding the repository.
2. Build and start the server with its default loopback bind:

   ```sh
   pnpm build
   CBRANCH_BIND_ADDRESS=127.0.0.1 CBRANCH_PORT=7420 pnpm --filter @cbranch/web-server start
   ```

3. On the remote host, verify it is loopback-only. Do not expose port 7420 on a
   LAN or the public internet; cbranch v1 has no application login or token.
4. From Windows, verify SSH before opening cbranch desktop:

   ```powershell
   ssh -o BatchMode=yes -o StrictHostKeyChecking=yes user@server exit
   ```

   If this reports a host-key prompt, run normal `ssh user@server` first and
   verify the fingerprint. If it reports `Permission denied`, load/configure the
   key in your normal SSH agent or `%USERPROFILE%\.ssh\config`.

## Desktop profile

1. Install the current-user cbranch NSIS installer.
2. Create a profile with its display name, SSH host/config alias, SSH user and
   port, and the remote cbranch port (usually 7420).
3. Select **Test tunnel**. This validates strict-host-key SSH forwarding without
    retaining the process.
4. Select **Connect**. The application creates a temporary local
    `127.0.0.1` port, verifies that cbranch responds through it, then connects
    the existing UI.

If the desktop app says that no cbranch server was found, install Node 20+ and
pnpm on the remote host, obtain a cbranch checkout there, then run the shown
commands from that checkout. The server must bind to `127.0.0.1`. If the chosen
port is occupied, select an unused loopback port with `CBRANCH_PORT` and update
the desktop profile's remote port to match.

## Common failures

- **OpenSSH not found:** install the Windows OpenSSH Client optional feature,
  then restart cbranch.
- **Host-key verification failed:** verify the host key with normal OpenSSH;
  cbranch intentionally cannot accept it for you.
- **Authentication failed:** configure an SSH key/agent or an SSH config alias.
  Password entry is intentionally unsupported.
- **Tunnel cannot reach remote cbranch:** confirm the remote server is running,
  listening on `127.0.0.1:<remote-port>`, and that the profile targets the
  correct SSH host/port. The desktop app does not install or manage the remote
  service for you.
- **Backend compatibility failed:** update the remote cbranch server or the
  desktop client so both support the same protocol version.

The **About and diagnostics** control displays redacted tunnel details and a
copyable diagnostic command for a support report. It never includes passwords,
private keys, or application tokens because cbranch does not have or store them.
