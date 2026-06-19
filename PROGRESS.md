# cbranch — Implementation Progress

Running checklist for the clean-room build. Legend: ✅ done · 🔄 in-flight · ⛔ blocked · ⬜ not started.

> Build order (per `docs/spec/16-implementation-plan.md`): **P0 scaffold → P1 read-only
> walking skeleton** (rpc-contract → core → web-server → ui), host-git-first. Then P2–P5 +
> VSCode extension. Verify → commit → status → continue at each boundary; never advance on red.

## Branch
- `feat/p0-p1-walking-skeleton` (never main).

## Milestone 0 — bootstrap docs
- ✅ Feature branch created.
- ✅ `LICENSE` (MIT), `PROVENANCE.md`, `PROGRESS.md`.
- 🔄 Spec digestion (parallel readers → `docs/_impl-notes/`).

## P0 — Repository scaffold
- ⬜ pnpm monorepo: `packages/{core,rpc-contract,ui}` + `apps/{web-server,vscode-ext}`, `workspace:*`.
- ⬜ Shared `tsconfig` (strict); oxlint + oxfmt; Vite 8; Tailwind v4; vendored `base-lyra` on Base UI (+ primitive-existence check, REQ-STACK-014).
- ⬜ Pinned pre-stable deps EXACTLY (effect@4.0.0-beta.84, oxfmt beta, oxlint type-aware alpha advisory-only).
- ⬜ CI: `install --frozen-lockfile` + license audit + lint/format + `pnpm -r build` + dependency-direction check (REQ-ARCH-007).
- ⬜ Gate green on empty skeleton.

## P0.5 — Effect v4 ⚠-symbol verification
- ⬜ Verify every `⚠` symbol in `14` against installed `effect@4.0.0-beta.84` types; build the single adapter `packages/rpc-contract/src/effect-rpc-adapter.ts`.

## P1 — Read-only walking skeleton
- ⬜ `rpc-contract`: RpcGroup + Schemas for P1 methods (`repo.open/recentList/recentRemove/state/subscribe`, `log.stream`, `commit.detail/diff`, `file.contentAtRev`), GitError union (§4), InvalidationEvent/Domain (§5).
- ⬜ `core`: GitEngine + host-git backend (exact `05` commands); `cat-file --batch` pool; `--no-optional-locks`; repoId = hash of common git dir; non-interactive git env; scaffold per-repoId `Effect.Semaphore(1)`.
- ⬜ `web-server`: Effect platform HTTP/WS (one multiplexed NDJSON socket) + static serve + HTTP side-channel; Origin/Host allowlist on WS upgrade; default loopback bind + warning; chokidar → invalidation bus (last).
- ⬜ `ui`: shell (Resizable, cmdk), status summary, virtualized streaming history + graph (`10`), details panel, read-only diff (react-diff-view + Shiki) + file-at-rev (CodeMirror 6); React Query sole synced feeder + Zustand ephemeral.

## P1 — Definition of done
- ⬜ `05` AC-1…AC-15 pass.
- ⬜ Tests: core unit (fixture harness), rpc-contract (incl. malformed-payload reject), ui component, one e2e happy-path.
- ⬜ Gate: oxlint + `oxfmt --check` + tsc --noEmit + `pnpm -r build` + vitest + license audit + dependency-direction.
- ⬜ Perf: NF-PERF-1/2/3 measured on reference repo within budget.

## Later (not this milestone)
- ⬜ P2 (`06`) · P3 (`07`) · P4 (`08`/`11`) · P5 (`09`) · VSCode extension (`13`).

## Blocked / decisions to surface
- _(none yet)_

## Log
- 2026-06-18 — Recon: Node 24.17, pnpm 10.32, git 2.54, registry reachable (effect beta, oxfmt, oxlint). Branch + bootstrap docs created. Spec digestion launched.
