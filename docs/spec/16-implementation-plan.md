# Implementation Plan & Bootstrap

> **This is the first document an implementer reads.** It sequences the build; it
> introduces **no new requirements**. Authority for behavior and contracts stays
> with [`00-README.md`](00-README.md) (index), `01`–`13` (product + features), and
> the **authoritative** [`14-rpc-contract.md`](14-rpc-contract.md) (wire contract)
> + [`15-sync-protocol.md`](15-sync-protocol.md) (live data).

## Clean-room reminder

Build **solely** from the artifacts allowed in `CLEANROOM.md` §2: everything under
`docs/spec/`, plus `LICENSES.md` and `BRANDING.md`, official Git documentation, and
the public docs of the named permissive libraries. Do **not** seek, read, or port
any other Git GUI's source. (Note: `SPEC-AGENT-BRIEF.md` is a dirty-side working
document and is **not** part of the hand-off — do not build from it.)

## Prerequisites (host)

- Node **≥ 20 LTS**, pnpm **≥ 9**, host `git` **≥ 2.37** (`12` NF-PKG-5),
  TypeScript **≥ 5.6**.
- Optional: the TypeScript-native (tsgo) toolchain, only if running the **advisory,
  non-blocking** type-aware lint (`03` REQ-STACK-008).

## Dependency discipline (read before `pnpm install`)

- **Pin pre-stable pillars exactly** (no `^`): `effect@4.0.0-beta.92`, `oxfmt`
  (beta), the `oxlint` type-aware backend (alpha) — `03` REQ-STACK-035.
- **Quarantine every `effect/unstable/*` import** (rpc, socket, http) behind
  `packages/rpc-contract/src/effect-rpc-adapter.ts` (`14 §1`). Treat each
  `⚠`-marked symbol in `14` as *verify against the pinned version before relying on
  it* — the names are accurate to the pinned beta but may move on a bump.
- Wire the **license audit** (`03` REQ-STACK-031/032; `LICENSES.md`) into CI from
  the first commit.

## Build order — host-git-first (`03` REQ-STACK-029 / `02` REQ-ARCH-020)

### P0 — Repository scaffold

1. pnpm monorepo with `packages/{core,rpc-contract,ui}` + `apps/{web-server,vscode-ext}`,
   `workspace:*` references, single root `pnpm-lock.yaml`.
2. Shared `tsconfig` (`strict`); **oxlint + oxfmt**; **Vite 8**; **Tailwind v4** via
   `@tailwindcss/vite`; vendor **shadcn `base-lyra` on Base UI** and run the
   primitive-existence check (`03` REQ-STACK-014). CI: `install --frozen-lockfile`
   + license audit + lint/format + `pnpm -r build` + the dependency-direction check
   (`02` REQ-ARCH-007).

### P1 — Read-only walking skeleton (the first shippable slice)

Implement in this order; every engine method sits behind the `GitEngine` interface
and is realized with the **host `git`** commands enumerated in `05` "Git operations":

3. **`packages/rpc-contract`** — the `RpcGroup` + Effect Schemas for the **P1
   methods only**: `repo.open`, `repo.recentList`, `repo.recentRemove`,
   `repo.state`, `repo.subscribe`, `log.stream`, `commit.detail`, `commit.diff`,
   `file.contentAtRev` — plus the canonical `GitError` union (`14 §4`) and the
   `InvalidationEvent` / `Domain` schema (`14 §5`). All unstable imports behind the
   adapter module.
4. **`packages/core`** (GitEngine, host-git backend) — implement those P1 methods
   via the exact commands in `05`; stand up the per-repo `git cat-file --batch`
   read pool and `--no-optional-locks` reads; `repoId` = hash of the common git dir
   (`14 §3.5`); the non-interactive git environment (`14 §3.3`). No mutations in P1,
   so no lock path is exercised yet — but scaffold the per-`repoId`
   `Effect.Semaphore(1)` for P2.
5. **`apps/web-server`** — the Effect platform HTTP/WebSocket server (one multiplexed
   **NDJSON** socket), serving the static client bundle and the large-payload **HTTP
   side-channel** (`14 §3.7`). Enforce the **`Origin`/`Host` allowlist on the WS
   upgrade** (`02` REQ-ARCH-072), **default loopback bind** + non-loopback warning
   (`12` NF-PKG-2/9). Wire the **chokidar watcher → `repo.subscribe` invalidation
   bus** (`15`) last — `05` P1-STAT-5 permits on-demand/focus refresh first, so the
   bus can light up at the end of P1.
6. **`packages/ui`** — the shell (`Resizable` layout, cmdk switcher), status
   summary, the **virtualized streaming history + graph** (`10`), the details panel,
   the read-only diff viewer (react-diff-view + Shiki) and file-at-revision
   (CodeMirror 6). React Query is the **sole** synced feeder, keyed
   `[repoId, domain, …]`; Zustand holds ephemeral UI state.

## Definition of done — P1 walking skeleton

- All of `05` AC-1…AC-15 pass.
- A user opens a repo by path and browses history / graph / details / diffs
  read-only over the (loopback) service; switching repos fully replaces context.
- **Tests:** core unit tests for the P1 GitEngine methods against the fixture
  harness (`12` NF-TEST-3/4); rpc-contract tests, incl. a malformed-payload reject
  via Schema (NF-TEST-5/6); UI component tests (NF-TEST-7); one e2e happy-path
  (NF-TEST-8). License audit + lint/format + build green.
- **Perf:** NF-PERF-1/2/3 measured on the reference repo and within budget
  (`12` NF-PERF-9 CI gate).

## Then — subsequent phases

- **P2 (`06`)** — introduce the per-repo mutation lock + the lock-policy table
  (`12` NF-LOCK), file/hunk staging (the patch rule in `14 §7`), commit/amend, and
  optimistic mutations (`15 §6`).
- **P3 (`07`)**, **P4 (`08`/`11`)**, **P5 (`09`)** per their docs.
- **VSCode extension (`13`)** — a parallel track once core stabilizes: bind the same
  `RpcGroup` to `webview.postMessage` and implement the `PlatformAdapter`
  (REQ-VSX-036/037). No new Git logic.

## What NOT to build in the walking skeleton

No mutations, no working-tree/index diffs, no `clone`, no auth/login, no conflict
editor, no rebase/reflog/bisect, no extension (`05` "Out of scope").

## Verification & hand-off gates

- **Clean-room:** complete the provenance record (`CLEANROOM.md` §6) and the
  hand-off checklist (§7); build only from §2 artifacts.
- **License:** every shipped dependency is present in `LICENSES.md` with an
  allow-listed license; the CI license audit is green.
- **Contract integrity:** a contract change is a compile error on whichever side is
  out of date (`02` REQ-ARCH-054); the same `RpcGroup` works over WS (web) and
  `postMessage` (extension) with no contract change.
