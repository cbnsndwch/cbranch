# Host Qualification Evidence

## 2026-08-28 attempted release qualification

**Decision:** Not qualified for release. Seven of eight required checks passed.
The `systemd-user-manager` check failed, so this record is failure evidence, not
a waiver or a pass.

**Reviewed commit:** `3b46659424aa6402d1a032403ed0bde0921f5cd2`

**Package:** `@cbranch/opencode-goal-supervisor@0.1.0`

**Platform:** `linux-x64`

**Exact runtimes:**

- Development Node: `v24.15.0`
- Node 20 consumer: `v20.20.2`
- OpenCode: `1.17.20`
- Bun: `1.3.14`
- systemd user manager: `degraded`

The command was run with explicit, absolute runtime selections and
`CBRANCH_SYSTEMD_QUALIFY=1`:

```sh
CBRANCH_NODE20_BIN=/home/serge/.nvm/versions/node/v20.20.2/bin/node \
CBRANCH_OPENCODE_BIN=/home/serge/.opencode/bin/opencode \
CBRANCH_BUN_BIN=/home/serge/.bun/node_modules/.bin/bun \
CBRANCH_SYSTEMD_QUALIFY=1 \
pnpm --filter @cbranch/opencode-goal-supervisor qualify:host
```

**Passed:** `node20-packed-consumer`, `development-packed-consumer`,
`package-tests`, `package-typecheck`, `package-test-typecheck`,
`real-opencode-adapter`, `bun-tui-import`.

**Failed:** `systemd-user-manager`. `systemctl --user is-system-running`
reported `degraded` rather than `running`.

The `uv_interface_addresses` system error 97 recorded on 2026-07-26 did not
reproduce. The full repository gate completed on this host at this commit.

The degraded state came from three failed user units unrelated to this package
(`update-notifier-crash.service`, `xdg-desktop-portal-gtk.service`,
`xdg-desktop-portal.service`). The check treats any non-`running` manager state
as a failure, so an unrelated failed unit is sufficient to fail qualification.
The check was left unchanged; a required check must not be weakened to make the
package appear qualified. Re-run on a host whose user manager reports `running`,
or narrow the check to the properties the service lifecycle actually depends on
before making a release decision.

This record retains no credentials, control tokens, transcript bodies, or
artifact bodies.

## 2026-07-26 attempted release qualification

**Decision:** Not qualified for release. The required repository gate did not
complete in this execution environment, so this record is failure evidence, not
a waiver or a pass.

**Reviewed commit:** `be0989617839264f08bef3909db07dec1b044dba`

**Package:** `@cbranch/opencode-goal-supervisor@0.1.0`

**Platform:** `linux-x64`

**Exact runtimes:**

- Development Node: `v24.15.0`
- Node 20 consumer: `v20.20.2`
- OpenCode: `1.17.20`
- Bun: `1.3.14`
- systemd user manager: `running`

The command was run with explicit, absolute runtime selections and
`CBRANCH_SYSTEMD_QUALIFY=1`:

```sh
CBRANCH_NODE20_BIN=/home/serge/.nvm/versions/node/v20.20.2/bin/node \
CBRANCH_OPENCODE_BIN=/home/serge/.opencode/bin/opencode \
CBRANCH_BUN_BIN=/home/serge/.bun/node_modules/.bin/bun \
CBRANCH_SYSTEMD_QUALIFY=1 \
pnpm --filter @cbranch/opencode-goal-supervisor qualify:host
```

The release entrypoint passed Node 20 and development-Node isolated packed
consumer checks, package tests and typechecks, the temporary OpenCode adapter
scenario, the Bun TUI import, and the systemd user-manager availability check.
It failed at `pnpm gate` while the UI build attempted to start Vite's prerender
preview server. Node reported `uv_interface_addresses` system error 97. No
required check was skipped or reported as passing.

This record retains no credentials, control tokens, transcript bodies, or
artifact bodies. Re-run the command on a host where `pnpm gate` completes before
making a release decision.
