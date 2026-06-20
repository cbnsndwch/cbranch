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

### ▶ NEXT TASK: P3 spec-conformance fixes (Groups 1–9), then P4

**P3 self-review is DONE** → full report at `docs/_impl-notes/P3-REVIEW.md` (gaps grouped
A=4 critical bugs, B=8 missing behaviors, C=robustness [NOT in scope], D=9 UI gaps,
E=tests). User approved fixing **A, B, D, E** in grouped gate-green commits; toolbar
work must follow `docs/design/toolbar-quick-actions.md` (dense 2-row icon toolbar w/
split-button dropdowns).

**Interlude (done 2026-06-20):** a concurrent react-router framework-mode migration
landed mid-review. It + a global printWidth-120→80 reformat were committed as two clean
commits: `960f31e` (style: reformat + pin oxfmt) and `fb32969` (refactor(ui): react-router).
Formatter is now settled on **oxfmt 0.55.0 @ printWidth 80**; the VS Code oxc extension is
pinned to the workspace binary (`oxc.path.oxfmt` + `oxc.useExecPath`). Gate green: 505+323
tests, 80.69% branches.

**Resume protocol for the fixes:**
1. `pnpm gate` to confirm baseline green on current `main`.
2. **Group 1 (merge A2/B1/B2/B3) is implemented but STALE in `git stash@{0}`** (captured
   pre-80-reformat at 120-width + a junk git-engine.ts reflow). **Do NOT pop it** — it would
   conflict on every line. Instead **re-derive Group 1 fresh** on the current base (use the
   stash as a spec reference; the agent prompt that worked is preserved in the transcript).
   Then drop the stale stash.
3. Work Groups 1–9 (session task list), one gate-green thematic commit each. Core groups
   (1–4) share contract/`live.ts` → run sequentially. Groups:
   1 merge (A2/B1/B2/B3) · 2 sync lock+non-ff+streaming (A1/A4/B4/B7/B8) ·
   3 branch reapply+detached (A3/B5) · 4 worktree context switch (B6/D8) ·
   5 UI branches panel (D1/D5/D6) · 6 UI toolbar redesign (D7) ·
   7 UI palette+non-ff dialog (D2/D3) · 8 UI stash preview+confirmations (D4/D6/D9) ·
   9 test sweep (E).
   Delegation pattern that worked: 1 sub-agent per vertical slice (contract→core→engine→
   server→UI hook + tests), get `pnpm gate` green, report concise summary; orchestrator
   commits with an undercover message.

When all groups land, read `docs/spec/08-phase4-diff-conflict.md` and plan P4 (three-way
conflict editor, conflict-marker resolution UI, rebase, cherry-pick/revert).

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
