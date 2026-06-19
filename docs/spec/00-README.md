# cbranch — Specification Index

> ## CLEAN-ROOM HAND-OFF
>
> **This folder is the complete, source-clean specification for building `cbranch` from scratch.**
>
> The implementer **MUST build SOLELY** from:
> 1. The documents contained in this `docs/spec/` folder.
> 2. Public, official **Git documentation** (the `git` man pages, `gitformat-*`, `gitprotocol-*`, and the Pro Git book).
> 3. The **named permissive-licensed libraries** listed in the Technology Stack document (e.g. React, shadcn/ui on Base UI, Tailwind, CodeMirror + `@codemirror/merge`, react-diff-view, Shiki, Effect + `@effect/rpc` (Effect Schema), TanStack Query/Virtual, Zustand, chokidar, Lucide, cmdk; built with Vite/Rolldown and the oxc toolchain).
>
> The implementer **MUST NOT** consult, read, decompile, copy, or otherwise reference the source code, assets, or proprietary documentation of **any other product** — including any pre-existing Git GUI. All design herein is original and derived only from public Git behavior and the libraries above.
>
> If a required detail is missing from this folder, fill the gap from public Git documentation or first-principles design — **never** from another product's implementation. See **[../../CLEANROOM.md](../../CLEANROOM.md)** for the binding clean-room rules.

---

## What cbranch is

`cbranch` is a cross-platform, browser-based Git GUI, with a planned VSCode webview extension that shares the same core. It targets a developer working on a remote Linux/macOS host over SSH (including VSCode Remote-SSH) who opens cbranch in a browser through an SSH tunnel to visually manage Git repositories. It operates on **one repository at a time** with a fast repo switcher.

The engine and service run **on the remote host** against the real on-disk repository via Node `fs`. The browser/webview is a pure view talking to the service over a typed RPC transport (WebSocket + HTTP for the web app; `webview.postMessage` for the extension).

---

## How to read this spec

Read the documents in the following order. Documents 01–04 are foundational and should be read before any phase document. Documents 05–09 are the phase plan and are each independently shippable. Documents 10–13 are cross-cutting and may be read alongside the phases they touch. Documents 14–15 are the **authoritative** RPC wire contract and live-data sync protocol; read them alongside 02–04, as all other documents reconcile to them. **An implementer should start at [`16-implementation-plan.md`](16-implementation-plan.md)**, which sequences the build (it adds no requirements).

| # | Document | One-line summary |
|---|----------|------------------|
| 00 | `00-README.md` (this file) | Clean-room hand-off, reading order, and phase plan. |
| 01 | [`01-overview.md`](01-overview.md) | Product Overview & Glossary — who cbranch is for, the SSH-tunnel usage model, and shared terminology. |
| 02 | [`02-architecture.md`](02-architecture.md) | System Architecture — host-resident engine/service, browser-as-view, the `GitEngine` interface, host-`git`-only backend with a `cat-file --batch` pool, per-repo locking, and the filesystem-watcher → invalidation bus. |
| 03 | [`03-tech-stack.md`](03-tech-stack.md) | Technology Stack — pnpm monorepo, oxc toolchain (oxlint/oxfmt), Vite 8/Rolldown, React 19 + shadcn/ui (`base-lyra` on Base UI) + Tailwind v4, CodeMirror 6 + Shiki, Effect + `@effect/rpc`, and the full named-library list. |
| 04 | [`04-domain-model.md`](04-domain-model.md) | Domain Model & RPC Contract — core Git domain types and the typed RPC surface shared by web and extension transports. |
| 05 | [`05-phase1-browse.md`](05-phase1-browse.md) | **Phase 1** — Read-only Repository Browser (history, commits, diffs, trees, refs). |
| 06 | [`06-phase2-stage-commit.md`](06-phase2-stage-commit.md) | **Phase 2** — Stage & Commit (working tree, index, hunk staging, commit/amend). |
| 07 | [`07-phase3-branches-sync.md`](07-phase3-branches-sync.md) | **Phase 3** — Branches, Sync (fetch/pull/push), Worktrees, Stash, Tags. |
| 08 | [`08-phase4-cherrypick-conflicts.md`](08-phase4-cherrypick-conflicts.md) | **Phase 4** — Cherry-pick, Conflict resolution, Blame & File History. |
| 09 | [`09-phase5-power.md`](09-phase5-power.md) | **Phase 5** — Power Features (interactive rebase, reflog, bisect, archive, clean, gc/maintenance, submodules, settings). |
| 10 | [`10-commit-graph.md`](10-commit-graph.md) | Commit Graph Rendering (cross-cutting) — lane assignment, edge drawing, virtualization. |
| 11 | [`11-conflict-merge-kdiff3.md`](11-conflict-merge-kdiff3.md) | Conflict Resolution, 3-way Merge Editor & kdiff3 Integration (cross-cutting). |
| 12 | [`12-nonfunctional.md`](12-nonfunctional.md) | Non-functional Requirements — trust model (default loopback bind, Origin/Host checks; no app auth in v1), config store, filesystem watcher, performance budgets & CI gates, reliability, accessibility. |
| 13 | [`13-vscode-extension.md`](13-vscode-extension.md) | VSCode Extension (parallel track) — reusing the core over the `postMessage` transport. |
| 14 | [`14-rpc-contract.md`](14-rpc-contract.md) | **RPC Contract (authoritative)** — the `@effect/rpc` + Effect Schema wire contract: method catalog, payload/success Schemas, the canonical `GitError` union, the multiplexed NDJSON WebSocket binding, history-streaming model, and the trust model. |
| 15 | [`15-sync-protocol.md`](15-sync-protocol.md) | **Live-Data Sync (authoritative)** — the WebSocket invalidation bus: host filesystem watcher → domain invalidation → React Query refetch; multi-tab, echo-suppression, and reconnect semantics. |
| 16 | [`16-implementation-plan.md`](16-implementation-plan.md) | **Implementer entry point** — prerequisites, dependency discipline, the host-git-first build order, and the P1 read-only walking-skeleton definition of done. Adds no requirements. |

> **Documents 14 and 15 are authoritative for the wire contract and live-data
> design.** Read them alongside 02–04; all other documents reconcile to them.

---

## Companion documents (repo root)

- **[../../CLEANROOM.md](../../CLEANROOM.md)** — the binding clean-room development rules this hand-off enforces.
- **[../../LICENSES.md](../../LICENSES.md)** — license inventory and obligations for every named dependency.
- **[../../BRANDING.md](../../BRANDING.md)** — product naming, marks, and asset guidelines for `cbranch`.

---

## Architecture in one paragraph

`cbranch` is a **pnpm workspace monorepo**: `packages/core` (transport-agnostic Git orchestration), `packages/rpc-contract` (the `@effect/rpc` method catalog + Effect Schema types + transport binding), `packages/ui` (React 19 + shadcn/ui `base-lyra` on Base UI + Tailwind v4), `apps/web-server` (Node + Effect platform HTTP/WebSocket), and `apps/vscode-ext` (later track). The Git engine is a single **`GitEngine` interface** with **one backend**: it shells out to the **host `git` binary** for every operation — local read/index/commit/graph as well as network sync (fetch/pull/push) and everything else (rebase including interactive via a non-interactive sequence-editor shim, revert, cherry-pick, worktrees, blame, submodules, reflog, gc/maintenance, merges, and launching external merge tools). Hot reads stay fast via a per-repo `git cat-file --batch` pool and `--no-optional-locks` (no in-process pure-JS engine, so no dual-backend divergence). Mutating operations are **serialized per repository** with an `Effect.Semaphore(1)` keyed by `repoId`; live state is propagated by a **host filesystem watcher → WebSocket invalidation bus** that tells the client which domains to refetch. `git clone` and app-level authentication are out of scope for v1 (cbranch opens existing repositories; deployment is behind a trusted perimeter with a default loopback bind plus an `Origin`/`Host` check).

---

## Phase plan

Each phase is independently shippable. The VSCode extension is a **parallel track** that begins after the core stabilizes.

1. **P1 — Read-only browser.** Browse history, commits, diffs, file trees, branches, and tags. No mutations.
2. **P2 — Stage & commit.** Working-tree/index management, hunk-level staging, commit and amend.
3. **P3 — Branches, sync, worktrees, stash, tags.** Branch management, fetch/pull/push, worktrees, stash, and tag operations.
4. **P4 — Cherry-pick, conflicts, blame.** Cherry-pick, the 3-way merge/conflict workflow, blame, and file history.
5. **P5 — Power features.** Interactive rebase, reflog, bisect, archive, clean, gc/maintenance, submodules, and settings.

> **VSCode extension (parallel track):** reuses `packages/core` and `packages/rpc-contract` over the `webview.postMessage` transport once the core is stable. See `13-vscode-extension.md`.
