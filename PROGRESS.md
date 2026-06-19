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
- ✅ Spec digestion (8 parallel readers → `docs/_impl-notes/` 03/02/14/15/04/05/10/12).
- ✅ `docs/_impl-notes/DECISIONS.md` — locked all implementer-gap resolutions (D1–D10): method tags, repoId hash, NDJSON via lib, side-channel routes, stale-AC reconciliations, authored P1 success Schemas.

## P0 — Repository scaffold ✅ (gate verified green independently)
- ✅ pnpm monorepo: `packages/{core,rpc-contract,ui}` + `apps/{web-server,vscode-ext}`, `workspace:*`, one root lockfile.
- ✅ Shared `tsconfig.base.json` (strict, `module: Preserve` + `moduleResolution: Bundler`, project refs); oxlint + oxfmt; Vite 8 / Rolldown (`output.codeSplitting.groups[]`); Tailwind v4 via `@tailwindcss/vite`; Base UI `1.0.0-rc.0` (all 12 needed primitives present; HoverCard→PreviewCard, DropdownMenu→Menu); base-lyra placeholder Button (full registry vendoring deferred to P1).
- ✅ Pinned EXACTLY: `effect@4.0.0-beta.84`, `oxfmt@0.55.0`, `oxlint@1.70.0`. tsgolint not wired (advisory).
- ✅ CI (`.github/workflows/ci.yml`) + `pnpm gate` = license-audit → lint → format:check → typecheck → build → test → depcheck. License audit: prod strict-permissive, dev allows build-time MPL-2.0 (lightningcss, documented), strong copyleft denied. Dep-direction check enforces D10 + socket rule.
- ✅ Gate green on empty skeleton (5 pkgs build; 5 tests pass).
- Flags: Base UI rc.0 is npm-deprecated prerelease (pinned exact, re-evaluate); TS pinned `^5.9` (5.9.3) over 6.0.3.

## P0.5 — Effect v4 ⚠-symbol verification 🔄
- ✅ Symbol PRESENCE verified at the pin (adapter re-exports Rpc/RpcClient/RpcGroup/RpcSerialization/RpcServer, Socket, Http; `Schema.TaggedErrorClass` present, `Schema.TaggedError` absent).
- ⬜ Verify the actual API SHAPES (RpcGroup.make / Rpc.make signatures, layer wiring) by building a tiny end-to-end in-memory RPC round-trip against the installed types before authoring the full P1 contract.

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
