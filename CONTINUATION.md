# cbranch — Continuation Prompt

_Read by the assistant at the start of every resumed autonomous session._

## State as of 2026-06-20 (P3 fully complete)

Branch: `feat/p0-p1-walking-skeleton`
Gate: **GREEN — 505 tests, 80.69% branches**

### What was built in P3

**Core (S1-S9)** — 33 new RPC methods across refs, config, worktrees, stash, tags domains:

| Slice | Commit | What |
|-------|--------|------|
| S1    | 5d31d47 | RPC contract (33 methods: branches/merge/sync/remotes/worktrees/stash/tags) |
| S2    | 79c81a4 | Branch listing via `git for-each-ref` (ahead/behind, upstream, detached HEAD) |
| S3    | 5b38e4a | Branch lifecycle: create, switch (carry/stash/discard), rename, delete, set-upstream |
| S4    | 7fdd625 | Merge: ff / no-ff / squash + abort; conflict detection |
| S5    | 693c513 | Sync streaming: fetch / pull / push (Stream<SyncEvent>), pushDeleteRemoteRef |
| S6    | c0d36e9 | Remotes CRUD: list / add / set-url / rename / remove |
| S7    | 9273602 | Worktrees: list (porcelain parser) / add / remove / prune |
| S8    | 63902b7 | Stash: push / list / show / apply / pop / drop / clear |
| S9    | 0aabe44 | Tags: list / create (lw/annotated/signed) / delete / push / delete-remote |

**UI (UI-A + UI-B)**:

| Commit | What |
|--------|------|
| 4c28f5c | P3 query+mutation hooks (28 new hooks) · `activeView` Zustand state · AppShell view nav tabs (History/Branches/Worktrees/Stash/Tags) · BranchesPanel (local/remote groups, create/rename/delete/dirty-tree dialogs, dropdown menus) |
| 1b5ba77 | Fetch/Pull/Push streaming buttons in Toolbar (Sonner progress toasts) · RemotesManagerDialog (CRUD table) · WorktreesPanel (list + add/remove/prune) · StashPanel (list + new-stash/apply/pop/drop/clear) · TagsPanel (list + create/delete/push actions) |

### ▶ NEXT TASK: P4 — Diff & Conflict Resolution

**STOP — await user review/approval of P3 before starting P4.**

When the user approves, read `docs/spec/08-phase4-diff-conflict.md` and plan P4.

P4 key areas (from spec):
- Three-way merge conflict editor
- Conflict marker detection and inline resolution UI
- Rebase support (interactive and non-interactive)
- Cherry-pick and revert

### Key files added in P3

| Purpose | Path |
|---------|------|
| P3 UI hooks | `packages/ui/src/rpc/hooks.ts` (P3 section at bottom) |
| Store (activeView) | `packages/ui/src/state/store.ts` |
| AppShell (view nav) | `packages/ui/src/components/AppShell.tsx` |
| BranchesPanel | `packages/ui/src/components/BranchesPanel.tsx` |
| WorktreesPanel | `packages/ui/src/components/WorktreesPanel.tsx` |
| StashPanel | `packages/ui/src/components/StashPanel.tsx` |
| TagsPanel | `packages/ui/src/components/TagsPanel.tsx` |
| RemotesManagerDialog | `packages/ui/src/components/RemotesManagerDialog.tsx` |
| P3 core (branches) | `packages/core/src/git/branches.ts`, `branch-ops.ts` |
| P3 core (merge/sync) | `packages/core/src/git/merge.ts`, `sync.ts` |
| P3 core (remotes) | `packages/core/src/git/remotes.ts` |
| P3 core (worktrees) | `packages/core/src/git/worktrees.ts` |
| P3 core (stash) | `packages/core/src/git/stash.ts` |
| P3 core (tags) | `packages/core/src/git/tags.ts` |
| P3 implementation plan | `docs/_impl-notes/P3-PLAN.md` |

### Operating constraints

- **UNDERCOVER**: No AI/model mentions in commits. No co-authored-by lines.
- **Effect v4 only**: `effect@4.0.0-beta.84`. Never propose Effect v3 fallback.
- **Base UI**: `@base-ui/react@^1` (stable). Old `@base-ui-components/react` is deprecated.
- **Clean-room**: Never read `.local/SPEC-AGENT-BRIEF.md`. Build from `docs/spec/` + public docs only.
- **Gate must be green** before every commit.
- **Context budget**: Stay <30% of the 1M window. Measure with `node <profile>/c/hooks/context-usage.mjs`. Hand off when over (send Telegram ping, write a new CONTINUATION.md first).

### Resume protocol

1. Read this file.
2. Read `PROGRESS.md` → find the ▶ RESUME HERE section.
3. Run `pnpm gate` to confirm baseline (expected: green, 505+ tests, ≥80% branches).
4. Continue from the NEXT TASK above.
