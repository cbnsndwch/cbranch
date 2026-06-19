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

## P0.5 — Effect v4 ⚠-symbol verification ✅
- ✅ All `⚠` symbols verified accurate at the pin via a RUNNING in-memory round-trip. Playbook locked: `Rpc.make(tag, {payload, success, error, stream})` (payload = bare fields ok; success/error MUST be Schemas; `stream:true` ⇒ top-level error `Never`); `RpcGroup.make(...)` variadic; server `group.toLayer({Tag: handler})`; client object keyed by tag; `Stream.runCollect`→Array.
- ✅ In-memory contract-test transport found: `RpcTest.makeClient(group)` (NF-TEST-6). Adapter now re-exports `RpcTest`. Smoke test kept at `packages/rpc-contract/src/_contract-smoke.test.ts`.
- Flag carried to contract author: test files are excluded from `tsc -b`; contract type-assertions need a dedicated test typecheck config.

## P1 — Read-only walking skeleton
- ✅ `rpc-contract`: `CbranchRpcs` (10 P1 methods), GitError (23 codes), Domain/InvalidationEvent, LogQuery/DiffSpec, authored success Schemas; in-memory contract tests (NF-TEST-5/6); test typecheck wired. (commit 4e08d00)
- 🔄 `core`: GitEngine + host-git backend (exact `05` commands); `cat-file --batch` pool; `--no-optional-locks`; repoId = SHA-256 of common git dir (D2); non-interactive git env; per-repoId `Effect.Semaphore(1)` scaffold.
  - ✅ core-A: host-git infra (runGit/env/error-classify, cat-file pool, SHA-256 repoId, version gate ≥2.37, semaphore scaffold) + config store (NF-CFG-7) + `repo.open/state/recentList/recentRemove` + fixture harness (NF-TEST-3/4) + 77 unit tests. Root gate now includes core `typecheck:test`. (commit 9074957)
  - 🔄 core-B: `log.stream`, `commit.detail`, `commit.diff`, `diff.workingFile`, `file.contentAtRev`, `repo.subscribe` (chokidar→InvalidationEvent per 15) + parsers + tests.
- Deferred NF gate: `@vitest/coverage-v8` not yet installed → NF-TEST-11 80% line/branch coverage not measured; add in verification pass.

> Backbone built sequentially in main tree (core → web-server → ui) to keep one clean lockfile/gate per step; parallel fan-out reserved for install-free intra-package work (e.g. UI view panels).
- ✅ `web-server`: Effect platform HTTP/WS (one multiplexed NDJSON socket at `/rpc` via `RpcServer.layerHttp`
  protocol `websocket` + `RpcSerialization.layerNdjson`) + static SPA serve (`HttpStaticServer`, spa fallback)
  + HTTP side-channel (`GET /sidechannel/blob`, blob via the engine `cat-file` pool, NF-SEC-5/6 containment) +
  global Origin/Host allowlist on BOTH HTTP routes and the WS upgrade (NF-SEC-3) + default loopback bind 7420
  with non-loopback warning (NF-PKG-2/9) + startup git-version gate (NF-PKG-5, via `gitEngineLayer`). Bound on
  Node via **`@effect/platform-node@4.0.0-beta.84`** (DECISIONS D11 — `effect` core ships no Node listener;
  spec-literal wiring otherwise). 10 RPC handlers → `GitEngineApi`; migrated off the P0 placeholder bridge.
  37 unit + 1 real end-to-end round-trip test (NF-TEST-8). Gate green (168 tests). Chokidar→bus wiring is the
  client step (below).
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

## ▶ RESUME HERE (state as of the web-server commit)
**Done & committed (gate green at each):** P0 scaffold (26f22af) · P0.5 effect-rpc spike (bdcef02) · rpc-contract P1 (4e08d00) · core-A infra+repo.* (9074957) · core-B history/diff/content+watcher (08c71c9) · **`apps/web-server` (THIS commit)**. **`core` engine + `web-server` host are COMPLETE for P1** (168 tests green). Branch `feat/p0-p1-walking-skeleton`.

**web-server recap (for the UI client step):** RPC bus at `ws://<host>:<port>/rpc` (multiplexed NDJSON);
HTTP side-channel `GET /sidechannel/blob?repoId=&rev=&path=`; static SPA at `/` (set `CBRANCH_CLIENT_DIR` to
the UI `dist`, or build into `apps/web-server/public`); bind via `CBRANCH_BIND_ADDRESS`/`CBRANCH_PORT`
(default `127.0.0.1:7420`); start with `pnpm --filter @cbranch/web-server start` (or `node dist/main.js`).
Node binding = `@effect/platform-node@4.0.0-beta.84` (DECISIONS **D11**). **UI gotcha:** `Stream.runCollect`
returns a plain `Array` at this pin.

**Remaining for P1 (do in this order, main tree, gate-green + commit each):**
1. ✅ **`apps/web-server`** — DONE (see above + DECISIONS D11). Migrated off the P0 bridge.
2. 🔄 **`packages/ui`** — building in sub-milestones (gate-green + commit each), **vertical-slice-first** so the
   interaction model is user-testable early, then fan out the rest:
   - ✅ **ui-A infra** — single Effect RPC client over the WS bus (`makeAppRuntime`/`RpcClientService`) + a
     mockable Promise/subscription facade `CbranchApi` (`src/rpc/api.ts`, the NF-TEST-7 seam) + `ApiProvider`;
     React Query keys `[repoId, domain, …]` (D9, `src/rpc/query-keys.ts`); ephemeral Zustand store
     (`src/state/store.ts`); theme light/dark/system + no-flash (`src/theme/theme.ts`); providers wired in
     `main.tsx`. Deps added: `effect`(exact), `@tanstack/react-query`, `zustand`, `lucide-react`. 14 tests.
   - ✅ **ui-B vertical slice (RUNNABLE — user-test checkpoint)** — Resizable shell (`AppShell`, react-resizable-panels
     v4 `Group`/`Panel`/`Separator`) + cmdk repo switcher (`CommandPalette`: RepoOpen + recent list, ⌘/Ctrl-K) +
     status summary (`StatusSummary` from `repo.state`) + virtualized streaming history (`HistoryList` + `useLogStream`
     + @tanstack/react-virtual) + details (`DetailsPanel`/`commit.detail`) + basic unified diff (`DiffPanel`/`commit.diff`).
     Data hooks in `src/rpc/hooks.ts`. Component tests (jsdom, mocked RPC, NF-TEST-7) via `.test.tsx` + per-file jsdom
     docblock; `MIT-0` added to license allow-list (jsdom dep). **RUNS:** `pnpm -r build` then
     `CBRANCH_CLIENT_DIR=$PWD/packages/ui/dist pnpm --filter @cbranch/web-server start` → http://127.0.0.1:7420 (see
     `RUNNING.md`). Web-server now **bundled** (esbuild, DECISIONS **D12**) so the built artifact runs under Node ESM.
   - ⬜ **ui-C** history polish — commit graph (spec 10), ref-label chips, filters (P1-FILT-*), quick-find, full keyboard nav, date-format pref.
   - ⬜ **ui-D** diff + file-at-rev — react-diff-view + Shiki, inline/split toggle, whitespace/context; CodeMirror 6 file-at-rev; binary/submodule/large-diff placeholders; sonner toasts; remaining base-lyra primitives.
   RPC CLIENT via the adapter subpath `@cbranch/rpc-contract/effect-rpc-adapter`. GOTCHA: `Stream.runCollect`→Array (see [[cbranch-effect-v4-gotchas]] in memory).
3. 🔄 **Invalidation bus end-to-end** — ✅ CLIENT wired: `useInvalidationBus` (`src/rpc/use-invalidation-bus.ts`,
   called in `AppShell`) subscribes `repo.subscribe` → `invalidateQueries([repoId, domain])`; on drop it
   resnapshots `[repoId]` + reconnects with backoff (NF-ERR-6). Unit-tested with a mocked event. ⬜ Remaining:
   the full watcher→refetch proof (NF-TEST-10: external `git` change → `InvalidationEvent` → fresh read) lands
   in the e2e/verification phase against the real server.
4. **e2e happy-path** (NF-TEST-8): start real server vs throwaway repo, open repo, browse log/graph/details/diffs read-only.
5. **P1 verification gate**: all `05` AC-1…AC-15; add `@vitest/coverage-v8` + NF-TEST-11 80% coverage (core+rpc-contract); measure NF-PERF-1/2/3 on a reference repo. Then **STOP for user review** (per kickoff first-run note) before P2.

**Key context files (gitignored working notes):** `docs/_impl-notes/DECISIONS.md` (D1–D12 locked decisions) + the 8 spec digests. **Verify command:** `pnpm gate`. **Clean-room:** never read `.local/SPEC-AGENT-BRIEF.md`; build only from `docs/spec/`+`LICENSES.md`+`BRANDING.md`+git/lib public docs. Undercover: no AI/model mentions in commits.

## Log
- 2026-06-18 — Recon: Node 24.17, pnpm 10.32, git 2.54, registry reachable (effect beta, oxfmt, oxlint). Branch + bootstrap docs created. Spec digestion launched.
- 2026-06-19 — `apps/web-server` built: verified (running round-trip) that `effect@4.0.0-beta.84` ships no Node
  HTTP/WS listener; adopted `@effect/platform-node@4.0.0-beta.84` (DECISIONS D11) for the spec-literal wiring.
  Assembled the WS RPC bus + static + side-channel + global Origin/Host guard; 37 web-server tests incl. one
  real e2e round-trip. Full gate green (168 tests).
