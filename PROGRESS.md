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
- ✅ NF-TEST-11 coverage gate: `@vitest/coverage-v8` installed; `vitest.coverage.config.ts` at root enforces ≥80% lines+branches for core+rpc-contract (96.27% lines / 82.13% branches). Per-package thresholds documented in `packages/{core,rpc-contract}/vitest.config.ts`. `pnpm coverage` + `pnpm gate` wired.

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
- ✅ `05` AC-1…AC-15 pass (unit+integration+component tests; see coverage below).
  - AC-1/5 (open/state) — e2e + repo.test.ts; AC-2 (invalid open) — repo.test.ts + git-engine.test.ts;
    AC-3 (recent list) — git-engine.test.ts; AC-4 (status porcelain) — repo.test.ts;
    AC-6/7 (history scale/columns) — history.test.tsx + graph layout tests;
    AC-8 (filters) — FilterBar.test.tsx + filters.test.ts; AC-9 (quick-find) — quick-find.test.ts;
    AC-10 (details) — e2e + components.test.tsx; AC-11 (merge diff) — diff.test.tsx;
    AC-12 (diff modes) — diff.test.tsx; AC-13 (file at rev) — e2e + file-at-revision.test.tsx;
    AC-14 (binary/submodule/large) — diff.test.tsx; AC-15 (read-only) — no mutation API exposed.
- ✅ Tests: 253 total (core unit, rpc-contract contract, ui component, one e2e happy-path NF-TEST-8,
    watcher→refetch NF-TEST-10).
- ✅ Gate: license-audit → oxlint → oxfmt → typecheck → build → test → coverage (≥80%) → depcheck. Green.
- ⬜ Perf: NF-PERF-1/2/3 measured on reference repo within budget (`scripts/measure-perf.mjs` ready;
    run against a 50k-commit repo on reference hardware per docs/spec/12).

## Cross-cutting: client-side routing (pre-P2)

Routing is a cross-cutting concern that needs to land before the app grows more navigation
surfaces. It is not a separate milestone but a prerequisite for all future work. See DECISIONS D13.

- ✅ Add `react-router@^8` to `packages/ui` (8.0.1).
- ✅ Define `router.tsx` with the route tree: `/` (landing → redirect to last repo or empty state),
  `/repos/:repoId` (history), `/repos/:repoId/commits/:oid` (selected commit), plus placeholder routes for
  `/repos/:repoId/branches/:name`, `…/tags/:name`, `…/worktrees/:id`, `…/stash/:index`, `…/blame/:rev/*`.
- ✅ Wrap the app in `<RouterProvider>` in `main.tsx` (route element renders `<App>`).
- ✅ Migrate `activeRepoId` and `selectedOid` from Zustand-only to URL-driven: write side uses
  `useNavigation()` (`navigation.ts`); `<SyncRouteToStore>` mirrors route params → store (`useLayoutEffect`,
  no first-paint flash) so legacy store subscribers keep working.
- ✅ Update component tests to wrap navigation-using components in `<MemoryRouter>` (`components.test.tsx`).
- ⬜ VS Code extension WebView caveat (D13): `MemoryRouter` entry point deferred to VSCode ext milestone.

## Later (not this milestone)
- ⬜ P2 (`06`) · P3 (`07`) · P4 (`08`/`11`) · P5 (`09`) · VSCode extension (`13`).

## Blocked / decisions to surface
- _(none yet)_

## ▶ RESUME HERE (P3 core complete — UI work next)

**P3-S1 through S9 COMPLETE. Gate green: 505 tests, 80.59% branches.**

Committed: S1 contract+stubs (5d31d47) · S2 branch listing (79c81a4) · S3 branch lifecycle (5b38e4a) · S4 merge (7fdd625) · S5 sync streaming (693c513) · S6 remotes (c0d36e9) · S7 worktrees (9273602) · S8 stash (63902b7) · S9 tags (0aabe44).

**All 33 P3 RPC methods are fully implemented in core.** Engine stubs replaced with real git invocations.

**Remaining: P3 UI slices (UI-A through UI-G)**
- UI-A: BranchesPanel (virtualized local+remote groups, context menus, BranchCreateDialog, BranchRenameDialog, DirtyTreeDialog)
- UI-B: SyncToolbar (Fetch/Pull/Push split buttons, progress toasts, non-FF AlertDialog)
- UI-C: RemotesManagerDialog (table + add/edit/rename/remove)
- UI-D: WorktreesPanel (list + Add/Remove/Prune + Switch context)
- UI-E: StashPanel (list + Apply/Pop/Drop/Clear + new-stash dialog + diff preview)
- UI-F: TagsPanel (list + new-tag dialog + delete/push actions)
- UI-G: AppShell integration + command palette entries

**Next: P3-UI-A — Branches panel** (main new view; add "Branches" tab to AppShell).

**The app runs end-to-end with stage+commit.** Open the "Changes" tab to see staged/unstaged file list, click a file to diff it, stage/unstage hunks, write a commit message, and commit.

**To run:** `pnpm -r build` then `CBRANCH_CLIENT_DIR=$PWD/packages/ui/dist pnpm --filter @cbranch/web-server start` → http://127.0.0.1:7420.

**To run current build:** `pnpm -r build` then `CBRANCH_CLIENT_DIR=$PWD/packages/ui/dist pnpm --filter @cbranch/web-server start` → http://127.0.0.1:7420.

**Key context files (gitignored working notes):** `docs/_impl-notes/DECISIONS.md` (D1–D12 locked decisions) + the 8 spec digests. **Verify command:** `pnpm gate`. **Clean-room:** never read `.local/SPEC-AGENT-BRIEF.md`; build only from `docs/spec/`+`LICENSES.md`+`BRANDING.md`+git/lib public docs. Undercover: no AI/model mentions in commits.

## Log
- 2026-06-20 — **P2 S2–S10 complete. Gate green: 385 tests.** Core slices (b3183af / 9df6f0f / 2f1f213 / 4a5c13e): porcelain-v2 status parser+statusGet (NUL-sep, `#`/`1`/`2`/`u`/`?`/`!` types), stage/unstage/discard/deleteUntracked/resetTo (per-repo mutex lock, stdin support in run-git), partial-stage patch builder (`buildPatch` pure fn + `stageHunks`/`unstageHunks`/`discardHunks` + `--recount`), commitCreate (stdin F-, amend/signoff/sign, pre-flight guard) + commitLastMessage. All 11 engine stubs replaced in live.ts. UI slices (dc175a9 / 6fa20be / 7bd43c9 / 3d6a0ad / eb3bf5f): S6 status helpers + store slices (commitDraft, selections, selectedDiffFile) + 9 mutation hooks (optimistic stage/unstage); S7 StatusPanel (ChangeListToolbar + StatusChangeList + Checkbox/Separator primitives); S8 WorkingDiffPanel (hunk block + Stage/Unstage/Discard Hunk buttons); S9 CommitPanel (ConventionalCommitBar + CommitMessageEditor + Switch/Select/Tooltip primitives + 7 tests); S10 DestructiveConfirmDialog + AlertDialog primitive + stageAll/unstageAll menu commands. Watcher coalesce widened to 300 ms (Windows NTFS reliability, f59d9d4). Coverage: 80.48% branches / 91.85% statements. **Next: AppShell integration — wire StatusPanel/WorkingDiffPanel/CommitPanel into a "Changes" tab.**
- 2026-06-20 — **P2 started — slice S1 landed (D15).** RPC write-path contract + full method plumbing as
  typed stubs (`360845b`): `schemas/working-tree.ts` (8 Schema.Class types) + 11 group methods (StatusGet,
  Stage/Unstage/Discard/DeleteUntracked/ResetTo, Stage/Unstage/DiscardHunks, CommitCreate, CommitLastMessage)
  + GitEngineApi/live.ts stubs + web-server handlers + UI api/query-keys. Gate green: 276 tests. Plan at
  `docs/_impl-notes/P2-PLAN.md`; D15 records selection-over-patch + DeleteUntracked-split decisions. Next: S2
  (porcelain-v2 status parser).
- 2026-06-20 — **Base UI migration + desktop menu chrome (D14).** Migrated the deprecated
  `@base-ui-components/react@1.0.0-rc.0` → stable `@base-ui/react@^1.6.0` (renamed package; `check:primitives`
  green on 12/12). Wired the shadcn `@/* → src` alias across tsconfig/vite/root-vitest/components.json so
  `shadcn add` resolves and emits working imports (verified with a throwaway `tooltip` add). Vendored the
  base-lyra `dropdown-menu` + `menubar` (copied source, REQ-STACK-014; only icon-placeholder swapped for
  lucide). Rebuilt `MenuBar` to render the full nine-menu chrome from `menu/menu-model.ts` (transcribed from
  docs/design/menu-hierarchy.md) with unwired items greyed via the `use-menu-actions` capability layer; wired
  Open/Recent/Refresh/Exit/Close/relative-date/About. Gate green: 256 tests. First real Base UI usage in the repo.
- 2026-06-20 — **Client-side routing (D13) landed.** Added `react-router@8.0.1` to `packages/ui`. New
  `router.tsx` (`createBrowserRouter`): `/` → `<Landing>` (redirect to most-recent repo via `recentList`,
  else the shell's "Open a repository" empty state), `/repos/:repoId`, `/repos/:repoId/commits/:oid`, +
  five `<PlaceholderPage>` routes staking the branches/tags/worktrees/stash/blame namespace. URL is now the
  source of truth for `activeRepoId`/`selectedOid`: write side calls `useNavigation()` (`navigation.ts`,
  `openRepo`/`selectOid`); `<SyncRouteToStore>` mirrors params → store via `useLayoutEffect` (no first-paint
  flash) so legacy store subscribers are untouched. `CommandPalette` open + commit selection now navigate
  instead of mutating the store. Tests wrap nav-using components in `<MemoryRouter>`. Gate green: 253 tests,
  typecheck/build/coverage/depcheck clean. WebView `MemoryRouter` entry deferred to the VSCode milestone.
- 2026-06-20 — **P1 verification gate complete.** NF-TEST-11: `@vitest/coverage-v8` wired; root `pnpm coverage`
  (via `vitest.coverage.config.ts`) enforces ≥80% lines+branches on core+rpc-contract; current: 96.27% lines /
  82.13% branches. Per-package configs in `packages/{core,rpc-contract}/vitest.config.ts` for independent
  threshold control. `pnpm gate` updated: adds `coverage` step between `test` and `depcheck`. NF-PERF-1/2/3:
  `scripts/measure-perf.mjs` ready (Node 22+ WebSocket, real WS RPC, 5 probe runs, p95 TTFR + incremental check
  + throughput). AC-1…AC-15 mapped to existing tests. **P1 COMPLETE. Gate green: 253 tests. STOP for review.**
- 2026-06-19 — **ui-C + ui-D complete** (8 gate-green commits, 185→253 tests). ui-C: commit graph (incremental
  append-only lanes/edges, SVG cell), ref chips, server filters, date pref, keyboard nav, quick-find. ui-D:
  changed-file list (flat/tree), diff controls (inline/split, ws, context, merge-parent/combined), next/prev nav,
  binary/submodule/large-diff cards, react-diff-view + on-demand Shiki, sonner toasts, CodeMirror 6 file-at-rev.
  ui-D2b (react-diff-view+Shiki+sonner) and ui-D3 (CodeMirror) were built by context-inheriting forks, each
  verified independently green. `@shikijs/codemirror` is NOT in the registry (404) → Shiki tokens bridged into
  CodeMirror as decorations directly.
- 2026-06-18 — Recon: Node 24.17, pnpm 10.32, git 2.54, registry reachable (effect beta, oxfmt, oxlint). Branch + bootstrap docs created. Spec digestion launched.
- 2026-06-19 — `apps/web-server` built: verified (running round-trip) that `effect@4.0.0-beta.84` ships no Node
  HTTP/WS listener; adopted `@effect/platform-node@4.0.0-beta.84` (DECISIONS D11) for the spec-literal wiring.
  Assembled the WS RPC bus + static + side-channel + global Origin/Host guard; 37 web-server tests incl. one
  real e2e round-trip. Full gate green (168 tests).
