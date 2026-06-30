# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What cbranch is

A cross-platform, browser-based Git GUI. A **host service** runs on the machine that owns
the repository and drives the real on-disk `.git` via the host `git` binary; the **browser
(or VSCode webview) is a pure view** with no Git logic that reaches the service only over a
typed RPC transport (one multiplexed NDJSON WebSocket). There is no in-process/pure-JS git
engine and no `git clone` — repos are opened by existing on-disk path.

The spec under `docs/spec/` is authoritative and written as testable `REQ-*` / `NF-*`
requirements. **`docs/spec/14-rpc-contract.md` is the source of truth for the wire
contract; `15-sync-protocol.md` for the live-data design; `02-architecture.md` and
`03-tech-stack.md` for the rest.** When changing cross-cutting behavior, reconcile to those
rather than guessing. `PROGRESS.md` tracks build phases (P0→P5); `RUNNING.md` is the run guide.

## Commands

Run from the repo root unless noted. Package manager is **pnpm** (`>=9`); Node `>=20`.

```bash
pnpm install                 # install whole workspace (one root lockfile)
pnpm -r build                # build every package in dependency order
pnpm dev                     # builds core + rpc-contract, then runs all `dev` in parallel
pnpm test                    # vitest run (whole workspace)
pnpm typecheck               # tsc -b + per-package typechecks (incl. UI + *.test typecheck)
pnpm lint                    # oxlint
pnpm format / format:check   # oxfmt  (NOT prettier)
pnpm coverage                # vitest with the ≥80% line/branch gate (core + rpc-contract)
pnpm gate                    # the full CI gate, run this before considering work done
```

`pnpm gate` = `license-audit → lint → format:check → typecheck → build → test → coverage →
depcheck`. CI (`.github/workflows/ci.yml`) runs the same sequence on Node 24 with a frozen
lockfile.

**Run a single test:** `pnpm vitest run path/to/file.test.ts` (or `-t "name"` to filter by
test name; add `--watch` for watch mode). The root `vitest.config.ts` is the canonical
runner — it carries no Vite plugins and resolves `@/*` to `packages/ui/src`.

**Run the app** (read-only browser, see `RUNNING.md`):

```bash
pnpm -r build
CBRANCH_CLIENT_DIR="$PWD/packages/ui/build/client" pnpm --filter @cbranch/web-server start
# → http://127.0.0.1:7420 ; client connects back over ws://127.0.0.1:7420/rpc
```

In dev (`pnpm dev`): the UI runs on Vite `:5173` and proxies `/rpc` (WS) + `/sidechannel`
(HTTP) to the web-server on `:7420`. Env vars: `CBRANCH_BIND_ADDRESS`, `CBRANCH_PORT`,
`CBRANCH_CLIENT_DIR`, `CBRANCH_CONFIG`, `CBRANCH_LOG_LEVEL`.

## Architecture & package boundaries

Five workspace packages with a **strict, acyclic dependency direction enforced by
`scripts/check-deps.mjs`** (the `depcheck` gate step):

| Package | Role | May depend on |
|---|---|---|
| `packages/rpc-contract` | Typed RPC catalog + payload/error Schemas + transport binding | (nothing internal) |
| `packages/core` | The `GitEngine` — all Git orchestration, transport-agnostic | rpc-contract (types) |
| `packages/ui` | React 19 SPA — presentation + client state only, no Git logic | rpc-contract |
| `apps/web-server` | Node host service + static bundle server | core, rpc-contract |
| `apps/vscode-ext` | VSCode webview binding (later track, scaffold only) | ui, core, rpc-contract |

Hard rules the depcheck gate fails on:

- `core` must never import `ui`, HTTP, WebSocket, or webview symbols.
- **Only `apps/web-server` may declare a listening-socket library** (`@effect/platform-node`,
  `ws`, `express`, …). It is the single process that opens a socket.

**`GitEngine` (`packages/core/src/engine/`) is the sole entry point for all Git behavior.**
Every RPC handler calls through it; nothing invokes `git` directly outside `packages/core`.
The single backend shells out to the **host `git` binary** via `child_process` with explicit
argument arrays (never a shell string), `--` separators, and a non-interactive env
(`GIT_TERMINAL_PROMPT=0`, `ssh -o BatchMode=yes`). Hot reads go through a per-repo
`git cat-file --batch` pool and pass `--no-optional-locks`. Mutations are serialized per
repo by an `Effect.Semaphore(1)` keyed by `repoId` (= hash of the common git dir, so sibling
worktrees share one lock). Errors are the single canonical **`GitError`** tagged union
(`packages/rpc-contract/src/schemas/errors.ts`) — mapped from exit code + known sentinels,
never localized message parsing.

The `rpc-contract` is the **single source of truth** both client and server import unchanged
(`CbranchRpcs` in `src/rpc/group.ts`). A contract change therefore breaks compilation on
whichever side is out of date. On-wire method tags are PascalCase (e.g. `RepoOpen`,
`LogStream`); the doc label `<domain>.<verb>` is a comment on each method.

Live state: a host-side **chokidar watcher → invalidation bus** pushes which *domains*
changed (`refs`, `status`, `commits`, …) over the `repo.subscribe` streaming RPC; the client
invalidates the matching React Query keys. There is no cross-process object cache.

## Conventions you must follow

- **Effect v4 is pinned exactly** (`effect@4.0.0-beta.92`) and must not be downgraded to v3.
  Every `effect/unstable/*` import (rpc, socket, http) is **quarantined in one adapter
  module** — `packages/rpc-contract/src/effect-rpc-adapter.ts` (consumed via the
  `@cbranch/rpc-contract/effect-rpc-adapter` subpath). Do not import `effect/unstable/*`
  anywhere else. `effect/Schema` is stable and imported directly.
- **UI data flow:** `@tanstack/react-query` is the *sole* feeder for synced repo data —
  never add a second fetch/cache path, and never duplicate server data into Zustand (Zustand
  holds only ephemeral view state: panel sizes, selections, palette, theme). Query keys are
  `[repoId, domain, ...params]` so the invalidation bus can target them; immutable
  content-addressed reads (commit detail/diff, blob at a fixed rev) sit under non-domain
  prefixes and are never invalidated. See `packages/ui/src/rpc/query-keys.ts`.
- **Tooling is oxc, not the JS classics:** lint = `oxlint`, format = `oxfmt`. ESLint and
  Prettier must not be added. oxfmt does Tailwind-class and import sorting itself, so no
  `prettier-plugin-tailwindcss` either. Style: double quotes, semicolons, trailing commas,
  2-space indent, printWidth 80.
- **shadcn/ui is vendored, not a dependency:** components under `packages/ui/src/components/ui`
  are copied source (`base-lyra` style on Base UI). `pnpm check:primitives` verifies the
  required Base UI primitives exist on the pinned version. The `@/*` alias → `packages/ui/src`
  is mirrored across `components.json`, the UI `tsconfig`, `vite.config.ts`, and the root
  vitest config — keep them in sync.
- **Every bundled dependency must be permissively licensed** and recorded in `LICENSES.md`;
  `pnpm license-audit` fails the build otherwise.
- **TS module strategy:** `module: Preserve` + `moduleResolution: Bundler` in
  `tsconfig.base.json` — relative imports are extensionless and resolved by the bundler
  (Vite/Rolldown) or by esbuild for the server. `packages/ui` is a non-composite app
  typechecked separately (not referenced by the root `tsc -b` solution).

## Testing

Vitest, tests live next to source as `*.test.ts(x)`. Default environment is **node**; React
component tests opt into jsdom **per file** via a `// @vitest-environment jsdom` docblock and
mock the RPC client (no live host). `packages/core/src/testing/fixtures.ts` builds throwaway
real git repos in a temp dir with fixed identities/timestamps so commit hashes are
deterministic across machines — use it for engine tests rather than mocking git. There is one
real end-to-end RPC round-trip test in `apps/web-server` (`server.integration.test.ts`).
Coverage gate (`vitest.coverage.config.ts`) enforces ≥80% lines+branches for core +
rpc-contract.
