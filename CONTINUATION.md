# cbranch — Continuation Prompt

_Read by the assistant at the start of every resumed autonomous session._

## State as of 2026-06-20 (P2 S2–S10 complete)

Branch: `feat/p0-p1-walking-skeleton`  
Gate: **GREEN — 378 tests, 80.48% branches / 91.85% statements**

### What was built in P2

| Slice | Commit | What |
|-------|--------|------|
| S1    | 360845b | RPC write-path contract (8 schemas, 11 methods) |
| S2    | b3183af | porcelain-v2 status parser + `statusGet` |
| S3    | 9df6f0f | stage/unstage/discard/deleteUntracked/resetTo + per-repo mutex |
| S4    | 2f1f213 | `buildPatch` partial-stage + `stageHunks`/`unstageHunks`/`discardHunks` |
| S5    | 4a5c13e | `commitCreate` + `commitLastMessage` |
| S6    | dc175a9 | UI status helpers, store slices (commitDraft/selections), 9 mutation hooks |
| S7    | 7bd43c9 | `StatusPanel` (ChangeListToolbar + StatusChangeList + Checkbox/Separator) |
| S8    | 3d6a0ad | `WorkingDiffPanel` (hunk viewer, Stage/Unstage/Discard Hunk buttons) |
| S9    | eb3bf5f | `CommitPanel` (ConventionalCommitBar + CommitMessageEditor + Switch/Select/Tooltip) |
| S10   | 6fa20be | `DestructiveConfirmDialog` + `AlertDialog` primitive + stageAll/unstageAll menu cmds |

Also landed: `f59d9d4` — watcher coalesce widened to 300 ms (Windows NTFS reliability).

### What is NOT yet done

The three P2 UI components (StatusPanel, WorkingDiffPanel, CommitPanel) are implemented but **not wired into the AppShell**. The running app shows no P2 UI.

### ▶ NEXT TASK: AppShell integration

Wire the P2 panels into `packages/ui/src/components/AppShell.tsx` (or wherever the app layout lives). Goal: add a "Changes" tab/pane that shows:
- Left column: `<StatusPanel repoId={activeRepoId} />`
- Centre/right: `<WorkingDiffPanel repoId={activeRepoId} />` (shows diff for `selectedDiffFile`)
- Bottom: `<CommitPanel repoId={activeRepoId} />`

After integration:
1. Run `pnpm gate` — must stay green (378 tests, ≥80% branches)
2. Commit with a conventional message (no AI/model mentions, no co-authored-by)
3. Update PROGRESS.md log entry
4. STOP — report to user that P2 is fully functional end-to-end

### Key files

| Purpose | Path |
|---------|------|
| App layout | `packages/ui/src/components/AppShell.tsx` |
| Router | `packages/ui/src/router.tsx` |
| Store | `packages/ui/src/state/store.ts` |
| StatusPanel | `packages/ui/src/components/StatusPanel.tsx` |
| WorkingDiffPanel | `packages/ui/src/components/WorkingDiffPanel.tsx` |
| CommitPanel | `packages/ui/src/components/CommitPanel.tsx` |
| Status lib | `packages/ui/src/lib/status.ts` |
| RPC hooks | `packages/ui/src/rpc/hooks.ts` |

### Operating constraints

- **UNDERCOVER**: No AI/model mentions in commits. No co-authored-by lines.
- **Effect v4 only**: `effect@4.0.0-beta.84`. Never propose Effect v3 fallback.
- **Base UI**: `@base-ui/react@^1` (stable). Old `@base-ui-components/react` is deprecated.
- **Clean-room**: Never read `.local/SPEC-AGENT-BRIEF.md`. Build from `docs/spec/` + public docs only.
- **Gate must be green** before every commit.
- **Context budget**: Stay <30% of the 1M window. Measure with `node <profile>/c/hooks/context-usage.mjs`. Hand off when over (send Telegram ping, write a new CONTINUATION.md first).

### Resume protocol

1. Read this file.
2. Read `PROGRESS.md` → find ▶ RESUME HERE section.
3. Run `pnpm gate` to confirm baseline (expected: green, 378+ tests).
4. Continue from the NEXT TASK above.
