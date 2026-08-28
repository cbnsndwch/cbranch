# Host Qualification Evidence

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
