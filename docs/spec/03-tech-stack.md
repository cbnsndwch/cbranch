# Technology Stack

## Purpose

This section defines the complete, version-pinned dependency stack that `cbranch`
is built on, the rationale behind each choice, and the setup notes required to
assemble a reproducible build for both delivery targets (the web server with its
browser bundle, and the later VSCode webview extension). It is the authoritative
reference an engineer uses to bootstrap the monorepo, add a dependency, or audit
the tree.

`cbranch` runs its Git engine and service **on the host** against the real
on-disk repository (via Node `fs` and the host `git` binary), while the browser
or webview is a pure view that talks to the service over a typed RPC transport.
The **wire contract** (methods, payload/success/error Schemas, transport binding,
trust model) is defined authoritatively in
[`14-rpc-contract.md`](14-rpc-contract.md); the **live-data design** (the
WebSocket invalidation bus) in [`15-sync-protocol.md`](15-sync-protocol.md). This
document names the libraries and their roles and reconciles to `14`/`15`; it does
not re-define their content.

Every dependency that is **bundled and shipped** to a user (server runtime deps
and anything that lands in the browser/webview bundle) MUST carry a permissive
license. License obligations, the approved license allow-list, and the
per-dependency attribution table live in `LICENSES.md`; this document
cross-references that file for compliance.

## User stories

- **As a maintainer**, I want one command to install the entire workspace so that
  a fresh clone is buildable without manual per-package steps.
- **As a maintainer**, I want every shipped dependency to be permissively licensed
  and recorded so that distributing `cbranch` carries no copyleft obligation.
- **As a contributor**, I want a single documented source of truth for which
  library handles each concern (state, diffs, virtualization, RPC, etc.) so that I
  do not introduce a redundant or conflicting dependency.
- **As a contributor**, I want pinned, compatible versions and known setup gotchas
  documented so that the build is reproducible and I do not rediscover them.
- **As a release engineer**, I want the web bundle and the extension bundle to be
  produced by the same build tool and to share the same core and UI packages so
  that behavior is identical across targets.

## Functional requirements

Each requirement is testable and observable. Versions are expressed as the
**minimum supported** version using a caret range unless a stricter pin is stated;
"current as of authoring" baselines are given to anchor the range. **Pre-stable
pillars are pinned exactly** (see REQ-STACK-035).

### Monorepo & package manager

- **REQ-STACK-001** The repository MUST be a single monorepo managed with **pnpm
  workspaces** (pnpm `>=9`, current baseline 9.x). A root `pnpm-workspace.yaml`
  MUST declare the workspace globs `packages/*` and `apps/*`.
- **REQ-STACK-002** The workspace MUST contain exactly these publishable/internal
  packages, each with its own `package.json`:
  - `packages/core` — transport-agnostic Git orchestration (the `GitEngine`).
  - `packages/rpc-contract` — the `@effect/rpc` method catalog, payload/error
    Schemas, and the transport interface.
  - `packages/ui` — the React component library and views.
  - `apps/web-server` — the Node host service and static bundle server.
  - `apps/vscode-ext` — the VSCode extension (later track; MUST exist as a
    package even if minimal).
- **REQ-STACK-003** Cross-package references MUST use the `workspace:*` protocol so
  that internal packages are always linked from source, never from a registry.
- **REQ-STACK-004** A single root command (`pnpm install`) MUST install the entire
  tree, and `pnpm -r build` MUST build every package in dependency order. CI MUST
  fail if `pnpm install --frozen-lockfile` detects a lockfile mismatch.
- **REQ-STACK-005** The repository MUST commit a single `pnpm-lock.yaml` at the
  root; no nested lockfiles are permitted.

### Language & toolchain

- **REQ-STACK-006** All first-party code MUST be authored in **TypeScript** (`>=5.6`,
  current baseline 5.x) with `strict` mode enabled in a shared base `tsconfig`.
- **REQ-STACK-007** The Node runtime target MUST be an active LTS line (Node `>=20`).
  The service MUST NOT use APIs unavailable on the lowest supported LTS without a
  documented polyfill.
- **REQ-STACK-008** Linting MUST use **oxlint** and formatting MUST use **oxfmt**
  (the oxc toolchain); both MUST be runnable from the root over all packages.
  ESLint and Prettier MUST NOT be used. Because oxfmt performs Tailwind class
  sorting and import sorting itself, `prettier-plugin-tailwindcss` (and any
  Prettier plugin) MUST NOT be added.
  - **Type-aware lint is alpha and OPTIONAL.** Type-aware rules (notably
    `typescript/no-floating-promises`) require oxlint's `oxlint-tsgolint` backend
    with `--type-aware` and the TypeScript-native (tsgo) toolchain. This path is
    **alpha**: it MAY be run locally and in CI as a non-blocking advisory check,
    but MUST NOT gate the build. Floating-promise risk in `packages/core` is
    additionally mitigated by Effect (effects are lazy values that must be run);
    the residual risk lives in the plain-React client (see REQ-STACK-018/019) and
    MUST be covered by review and tests there.

### Build tooling

- **REQ-STACK-009** **Vite** (`>=8`, current baseline 8.x — **Rolldown** is the
  default bundler) MUST be the build tool for both browser-facing targets — the web
  client bundle and the VSCode webview bundle — so a single configuration style
  produces both.
- **REQ-STACK-010** The web server (`apps/web-server`) MUST be a Node process; its
  own server-side TypeScript MAY be built with `tsc` or `tsup`/esbuild, but it MUST
  serve the Vite-produced static client bundle.
- **REQ-STACK-011** Production builds MUST emit source maps and MUST tree-shake
  unused exports; the browser bundle MUST be split such that the **Shiki grammars
  and the CodeMirror editor are loaded on demand** (via `dynamic import()`) rather
  than in the initial chunk. Chunk grouping uses Rolldown's
  **`output.codeSplitting`** (`groups[]`) — NOT the deprecated `advancedChunks`
  and NOT Rollup `manualChunks`. (The exact option shape is a HOW detail; verify
  it against the pinned Vite/Rolldown version at implementation time — see
  REQ-STACK-035.)

### UI framework & component system

- **REQ-STACK-012** The UI MUST be built on **React 19** (`react` and `react-dom`
  `>=19`). Server components are out of scope; `cbranch` ships a client-rendered SPA.
- **REQ-STACK-013** Styling MUST use **Tailwind CSS v4** (`>=4`, current baseline
  4.x) integrated through the **`@tailwindcss/vite`** plugin (the first-party Vite
  plugin), NOT the legacy PostCSS pipeline.
- **REQ-STACK-014** The component layer MUST be **shadcn/ui** generated with the
  **`base-lyra`** style on the **Base UI** base (`components.json` style
  `{base}-{style}` = `base-lyra`; Base UI v1, MIT). The `base-lyra` style is the
  boxy, sharp, square-edged look cbranch standardizes on. Components are vendored
  into `packages/ui` (copied source, not a runtime dependency) and built on **Base
  UI** primitives plus **class-variance-authority**, **clsx**, and
  **tailwind-merge**.
  - **Build-time primitive check:** the build/setup MUST verify that the specific
    primitives cbranch depends on exist on the pinned Base UI version — at minimum
    `ContextMenu`, `Resizable` (panels), `Popover`/`HoverCard`, `DropdownMenu`,
    `Dialog`/`Sheet`, and the `cmdk` command surface — and fail with a clear error
    if a required primitive is missing, so a gap is caught at setup, not at runtime.
- **REQ-STACK-015** Icons MUST be provided by **lucide-react**. No other icon font
  or set may be bundled.
- **REQ-STACK-016** A command palette MUST be provided by **cmdk**.
- **REQ-STACK-017** Long lists (commit history, file lists, blame, reflog) MUST be
  virtualized with **`@tanstack/react-virtual`**.

### Client data & state

- **REQ-STACK-018** Server-state caching, fetching, and invalidation MUST use
  **`@tanstack/react-query`** (`>=5`). React Query MUST be the **sole feeder** for
  synced repository data — there MUST NOT be a second fetch/cache path for the same
  data. Query keys MUST be structured `[repoId, domain, ...params]` to match the
  invalidation bus (see [`15-sync-protocol.md`](15-sync-protocol.md) §2).
- **REQ-STACK-019** Local/ephemeral UI state (panel sizes, selections, palette open
  state, theme) MUST use **Zustand**, per browser tab. Server data MUST NOT be
  duplicated into Zustand stores; it remains owned by React Query.
- **REQ-STACK-036** Live data MUST use the **WebSocket invalidation bus** defined in
  `15-sync-protocol.md`: the host pushes which *domains* changed (`refs`, `status`,
  `stash`, `worktrees`, `tags`, `commits`, `config`, `inProgress`) over the
  `repo.subscribe` streaming RPC, and the client invalidates and refetches the
  matching React Query keys. A host-side filesystem watcher feeds this bus
  (REQ-STACK-034). **TanStack DB is NOT used** — it was considered and dropped: a
  single-user app does not need row-level differential sync or optimistic-rebase
  machinery, and the invalidation bus delivers the same perceived liveness for far
  less code.

### Diff, editing, merge & highlighting

- **REQ-STACK-020** Read-only unified/split diffs MUST be rendered with
  **react-diff-view**, fed by parsed unified-diff patch text.
- **REQ-STACK-021** Text editing, hunk/line staging interactions, and the 3-pane
  merge editor MUST be built on **CodeMirror 6** (the `@codemirror/*` scoped
  packages) together with **`@codemirror/merge`** for the merge/compare surface.
  CodeMirror 6 is the only code-editor engine; the commit-message input is **plain
  text** (a textarea or a minimal CodeMirror instance), not a rich-text editor.
  No rich-text/WYSIWYG editor (e.g. tiptap/ProseMirror) is used — cbranch has no
  rich-text surface.
- **REQ-STACK-022** Syntax highlighting (for diffs, editors, and blame) MUST use
  **Shiki** as the **single highlighter** across surfaces — feeding react-diff-view
  via tokenized output and CodeMirror via **`@shikijs/codemirror`** — so
  highlighting is visually consistent everywhere. Grammar and theme assets MUST be
  loaded lazily (see REQ-STACK-011).

### RPC & transport

- **REQ-STACK-023** The RPC layer MUST use **Effect** (`effect@4.0.0-beta.84`,
  pinned) with **`@effect/rpc`** (the RPC module now lives under
  `effect/unstable/rpc`) to expose the service methods as a typed `RpcGroup`
  catalog. **Effect Schema** (`effect/Schema`, stable track) is the RPC validation
  layer — request/response/error payloads are Schemas, validated at the boundary.
  **birpc MUST NOT be used.** The authoritative method catalog, Schemas, and the
  canonical `GitError` union are defined in [`14-rpc-contract.md`](14-rpc-contract.md).
  - **Unstable-API quarantine (mandatory):** every `effect/unstable/*` import (rpc,
    socket, http) MUST be confined to a single adapter module
    (`packages/rpc-contract/src/effect-rpc-adapter.ts`) so a rename on a version
    bump touches one file. `effect/Schema` and the transport-agnostic `RpcGroup`
    catalog are the durable source of truth.
- **REQ-STACK-024** The web transport MUST be **one multiplexed WebSocket per
  connection, NDJSON-framed** (concurrent unary calls and streams correlated by a
  branded `RequestId`); there is no second channel — live-data push is a long-lived
  streaming RPC over the same socket. A separate **streamed HTTP download endpoint**
  on the same server carries large/binary payloads (archives, large blobs) per
  `14 §3.7`. The extension transport MUST be `webview.postMessage`. Both transports
  MUST satisfy the single transport binding defined in `packages/rpc-contract` so
  that the `RpcGroup` catalog is transport-agnostic.

### Server runtime

- **REQ-STACK-025** The host service (`apps/web-server`) MUST be a Node process
  whose HTTP server, router, static-asset serving, the large-payload download
  side-channel, and the RPC WebSocket endpoint are provided by **Effect's platform
  HTTP/socket layers** (`effect/unstable/http`, `effect/unstable/socket`) together
  with `@effect/rpc`'s WebSocket protocol layer and NDJSON serialization, assembled
  as one `Layer` and launched once at process root (`14 §2`). A separate HTTP
  framework (e.g. Fastify) is **not** used — the stack is unified on Effect to avoid
  two HTTP stacks.
- **REQ-STACK-026** **Trust model — no app-level auth in v1.** cbranch assumes
  private deployment behind a trusted perimeter (LAN / VPN / Tailscale). There is
  no login, session, or bearer token in v1. The service MUST bind to the perimeter
  interface — **default loopback (`127.0.0.1`)**, configurable — and MUST NOT be
  exposed to the public internet (state prominently in the run docs). Even with
  auth descoped, the service **MUST validate the `Origin`/`Host` header on the
  WebSocket upgrade (and on the HTTP side-channel) against a strict allowlist** and
  reject mismatches — this is a cheap, orthogonal control that defends against
  cross-site/DNS-rebinding access to the loopback service from a page in the user's
  browser. Git **remote** authentication is handled out-of-band at the host
  (`ssh-agent` / `credential.helper` / `gh`); cbranch never holds remote
  credentials. Adding app-level auth later is a non-breaking additive change in
  front of the same `RpcGroup`. (Authoritative trust model: `14 §3.6`; binding,
  warning, and security-checklist details: `12-nonfunctional.md`.)

### Git engine dependencies

- **REQ-STACK-027** The `GitEngine` MUST have a **single backend** that shells out
  to the **host `git` binary** via Node `child_process`. There is **no in-process
  pure-JS engine** (isomorphic-git is not used), so there is no dual-backend
  cache-invalidation or divergence-testing burden. Hot read paths are kept fast by
  a per-repo long-lived **`git cat-file --batch` / `--batch-check` process pool**
  (object reads without per-call process spawn) and by passing **`--no-optional-locks`**
  on read operations. `git` itself is a host prerequisite, not a bundled dependency,
  and MUST NOT appear in `LICENSES.md` attribution for bundled code.
- **REQ-STACK-028** All Git operations — local read/index/commit/graph **and**
  network sync (`fetch`, `pull`, `push`) and everything else (rebase incl.
  interactive via a non-interactive sequence-editor shim, revert, cherry-pick,
  worktrees, blame, submodules, reflog, gc/maintenance, complex merges, launching
  external merge tools) — run through the host `git` binary. Every spawn sets
  `GIT_TERMINAL_PROMPT=0` and a fail-fast askpass / `ssh -o BatchMode=yes` so git
  never blocks on a prompt (`14 §3.3`). **`clone` is out of scope** (the user
  clones via ssh and points cbranch at an on-disk path; the entry point is
  open-existing-path / `repo.open`).
- **REQ-STACK-029** Every engine method MUST be implemented behind the single
  `GitEngine` interface; the interface and its observable contract are stable and
  independent of the host-git invocation details, so an internal optimization
  (e.g. the batch-process pool) MUST NOT change the `GitEngine` interface or the
  RPC contract.
- **REQ-STACK-034** The host service MUST include a **filesystem watcher**
  (**chokidar**, or an equivalent permissively-licensed watcher) that feeds the
  invalidation bus (`15`). It watches the repository's common git dir and worktree,
  ignores high-volume irrelevant churn (`*.lock`, `objects/**`), and coalesces
  bursts within a debounce window (~150 ms) into a single `domains` set. (Watcher
  config — ignore globs, debounce — is pinned in `12-nonfunctional.md`.)

### Version policy

- **REQ-STACK-035** Stable dependencies track latest within their supported range.
  **Pre-stable pillars MUST be pinned exactly (no `^`)** and re-validated on every
  deliberate bump:
  - `effect@4.0.0-beta.84` — beta; the RPC API in `effect/unstable/rpc` may take
    breaking changes in minors (mitigated by the adapter-module quarantine,
    REQ-STACK-023). `effect/Schema` is on the stable track. **cbranch commits to
    Effect v4 and MUST NOT downgrade to Effect v3 as a churn mitigation:** v3's
    split-package layout (`@effect/rpc`, `@effect/schema`) and pre-rewrite APIs are
    not a fit for this architecture. Absorb beta churn by re-validating the
    quarantined adapter on each bump — never by retreating to the stable v3 major.
  - **oxfmt** — beta; pin and re-verify formatting output on bump.
  - **oxlint type-aware backend** (`oxlint-tsgolint`) — alpha; advisory only
    (REQ-STACK-008).
  Each pinned pre-stable dependency MUST carry a note to re-verify its public
  symbols / config shape against the pinned version before relying on them; the
  spec marks such symbols with `⚠` in `14`.

### Testing

- **REQ-STACK-030** Unit and integration tests MUST run on **Vitest**. Component
  tests MUST use **@testing-library/react**. End-to-end browser tests MUST use
  **Playwright**.

### License governance

- **REQ-STACK-031** Every dependency that is bundled into a shipped artifact (web
  server runtime dependencies and anything emitted into the browser/webview bundle)
  MUST carry a license on the permissive allow-list defined in `LICENSES.md`
  (e.g., MIT, BSD-2/3-Clause, Apache-2.0, ISC). A dependency under a copyleft or
  unknown license MUST NOT be added to the shipped tree. (Effect, Base UI,
  CodeMirror, Shiki, react-diff-view, cmdk, lucide-react, TanStack libraries,
  chokidar, and the oxc tools are all permissively licensed; record each in
  `LICENSES.md`.)
- **REQ-STACK-032** A license-audit script MUST run in CI and MUST fail the build if
  any production (non-dev) dependency resolves to a license outside the allow-list,
  or if a newly introduced dependency is missing from the `LICENSES.md` attribution
  table.
- **REQ-STACK-033** Dev-only tooling (build, lint, test) is exempt from bundling but
  MUST still be permissively licensed; the audit MAY treat dev dependencies under a
  separate, documented allow-list.

## Git operations

This section does not introduce new user-facing Git operations; it constrains how
the stack invokes Git. The exact subcommands, flags, and parsed output for each
feature are specified in their respective feature sections. The stack-level facts:

- The host-`git` path invokes the `git` binary through `child_process` with
  **explicit argument arrays** (never a shell-interpolated string) and parses its
  stdout/stderr. Machine-readable invocations are preferred — for example
  `--porcelain`/`-z` variants and explicit `--format`/`--pretty=format:` strings —
  so output is parsed from stable, documented formats rather than human-formatted
  text. Reads pass `--no-optional-locks`; object reads go through the per-repo
  `git cat-file --batch` pool (REQ-STACK-027).
- `git --version` MUST be invoked once at service startup to detect the host Git
  version and gate any version-dependent flags; if `git` is missing or below the
  minimum supported version the service surfaces a typed error
  (`GitError{ code: "hostGitMissing" | "hostGitTooOld" }`). The minimum version and
  per-flag fallbacks are pinned in `12-nonfunctional.md`.
- Mutating operations MUST be serialized per repository with a lock (an
  `Effect.Semaphore(1)` keyed by `repoId`); reads do not take the lock. `repoId` is
  derived from the repository's common git dir so sibling worktrees share one lock
  (`14 §3.2`/`§3.5`).

## UI/UX requirements

Expressed functionally in terms of the chosen libraries:

- **REQ-STACK-UX-001** The shell MUST render with shadcn/ui (`base-lyra` on Base UI)
  primitives — e.g., `Resizable` panels for the main layout, `Command` (cmdk) for
  the palette, `Dialog`/`Sheet` for modals, `DropdownMenu`/`ContextMenu` for
  actions, `Toast` (Sonner) for transient feedback — so the entire UI shares one
  component vocabulary.
- **REQ-STACK-UX-002** Light and dark themes MUST be driven by Tailwind v4 CSS
  variables and a class on the root element; the active theme MUST be persisted in
  the Zustand UI store.
- **REQ-STACK-UX-003** Any list that can exceed a few hundred rows MUST be
  virtualized via `@tanstack/react-virtual`; scrolling MUST stay smooth (no full
  re-render of off-screen rows).
- **REQ-STACK-UX-004** Diff views MUST use react-diff-view for read-only display and
  switch to a CodeMirror surface when the user enters hunk/line staging or editing.
- **REQ-STACK-UX-005** Syntax highlighting via Shiki MUST degrade gracefully: if a
  grammar fails to load, the view MUST fall back to unhighlighted monospace text
  without blocking render.

## Acceptance criteria

- A fresh clone followed by `pnpm install` then `pnpm -r build` completes with no
  errors and produces a runnable web server plus a browser bundle.
- `pnpm install --frozen-lockfile` succeeds in CI with no lockfile drift.
- `oxlint` and `oxfmt` run from the root over all packages; no ESLint/Prettier
  config or dependency is present in the tree.
- The browser bundle contains React 19, Tailwind v4 utility output, and the
  vendored shadcn/ui (`base-lyra` on Base UI) components; the initial chunk does
  NOT eagerly include all Shiki grammars or the full CodeMirror editor.
- The same `packages/core` and `packages/ui` are consumed by both `apps/web-server`
  and `apps/vscode-ext` via `workspace:*`.
- RPC calls from the client reach the service through `@effect/rpc` over one
  multiplexed NDJSON WebSocket in the web target, and the identical `RpcGroup`
  contract works over `webview.postMessage` in the extension target with no change
  to `packages/rpc-contract`; all `effect/unstable/*` imports are confined to the
  single adapter module.
- The license-audit CI job passes, and every shipped production dependency appears
  in the `LICENSES.md` attribution table with an allow-listed license.
- The service binds loopback by default; the WebSocket upgrade rejects a request
  whose `Origin`/`Host` is not on the allowlist.
- An internal optimization to a `GitEngine` method (e.g. routing an object read
  through the `cat-file --batch` pool) requires no change to callers or the RPC
  contract.

## Edge cases & error handling

- **Missing host `git`:** if the `git` binary is absent or its `git --version`
  cannot be parsed, the service MUST start in a degraded mode that surfaces a clear
  typed error (`hostGitMissing`) for any Git operation, rather than crashing.
- **Version-gated flags:** if the detected host Git is older than a flag requires,
  the service MUST either select a documented fallback invocation or return a typed
  `hostGitTooOld` error — never silently pass an unknown flag. (Minimum version and
  fallbacks: `12-nonfunctional.md`.)
- **Effect beta / unstable RPC churn:** because `effect@4.0.0-beta.84` and
  `effect/unstable/rpc` may take breaking changes, every unstable symbol MUST be
  accessed through the single adapter module (REQ-STACK-023) and re-validated on
  bump; `⚠`-marked symbols in `14` MUST be confirmed against the pinned version at
  implementation time rather than assumed.
- **oxfmt is beta:** pin it and treat any unexpected formatting change on bump as a
  bug to investigate before adopting the new output.
- **Base UI primitive gap:** if a required primitive (REQ-STACK-014) is absent on
  the pinned Base UI version, the build/setup check MUST fail clearly so the gap is
  resolved at setup, not discovered at runtime.
- **Tailwind v4 setup gotcha:** Tailwind v4 is configured through the
  `@tailwindcss/vite` plugin and a single CSS entry using the `@import "tailwindcss"`
  / `@theme` model; the legacy `tailwind.config.js` + PostCSS `@tailwind` directives
  MUST NOT be mixed in, or utility generation will be inconsistent.
- **shadcn/ui is vendored, not a dependency:** components are copied source under
  `packages/ui`; upgrades are explicit re-generations, and the runtime deps that
  remain (Base UI, cva, clsx, tailwind-merge) MUST stay version-compatible with the
  generated code.
- **React 19 peer ranges:** any added React library MUST declare React 19 support;
  libraries pinned to React 18 peers MUST NOT be force-installed via overrides
  unless verified compatible and recorded.
- **Dual-licensed dependencies:** if a dependency offers a permissive option among
  multiple licenses, the permissive option MUST be the one recorded in
  `LICENSES.md`; otherwise the dependency is rejected.
- **WebSocket transport loss:** the client MUST treat a dropped WebSocket as a
  recoverable error — reconnect, re-establish the `repo.subscribe` stream, and
  invalidate every query for the repo (a full resnapshot via refetch); see
  `15-sync-protocol.md` §5.

## Out of scope

- The concrete approved license list, full attribution text, and NOTICE handling —
  owned by `LICENSES.md`.
- The authoritative RPC method catalog, payload/error Schemas, and trust-model
  mechanics — owned by `14-rpc-contract.md`; the live-data invalidation design —
  owned by `15-sync-protocol.md`.
- App-level authentication / login / session tokens — descoped for v1 (trusted
  perimeter; REQ-STACK-026). (The client-side kdiff3 companion agent in `11` keeps
  its own loopback token — a separate trust boundary.)
- `git clone` and repository creation — out of scope; cbranch opens existing
  on-disk repositories.
- An in-process / pure-JS Git engine and any pure-JS SSH transport — not used; all
  Git goes through the host binary.
- Feature-level Git command details (exact flags and parsing per feature) — owned
  by the respective feature sections.
- Server-side rendering, React Server Components, and any non-SPA delivery model.
- Mobile-native packaging; `cbranch` targets desktop browsers and the VSCode webview.
- Bundling or distributing the `git` binary itself; it is a host prerequisite.
- Pinning exact patch versions of *stable* deps here; the committed `pnpm-lock.yaml`
  is the source of truth for resolved versions, and this document tracks supported
  minimum ranges (pre-stable pillars are pinned exactly per REQ-STACK-035).
