# cbranch Commit Surface (Dedicated Dialog)

**Status: authoritative design decision. This REVERSES the inline-panel commit model.** The Phase-2 spec
(`docs/spec/06-phase2-stage-commit.md`) and `docs/_impl-notes/P2-PLAN.md` currently decompose stage &
commit into co-resident inline panels in the main shell with "no separate commit window." That is
superseded: **the commit experience is a dedicated, on-demand dialog surface** — the workflow that feels
right after years on a desktop git client. See "Reconciliation" (§9) for the precise edits this implies.

The component decomposition in `06`/`P2-PLAN` mostly survives — the change list, working-diff/partial-
staging area, and commit composer become the **contents of the dialog** instead of being mounted inline.
The impl agent can largely re-host existing P2 components rather than rebuild them.

---

## 1. Decisions (locked)

| Question | Decision |
|---|---|
| Surface type | **Blocking modal dialog** — dims/locks the app behind a backdrop. Base UI `Dialog`, modal (default). |
| Scope | **Full stage + commit** — staged/unstaged lists, the diff with hunk/line staging, and the message composer all live inside the dialog (GE-style). The main shell only shows a "N changes" affordance that opens it. |
| After commit (without closing) | **User toggle:** a "Keep open after commit" checkbox in the footer, **default ON**, remembered per session. ON → clear message, refresh, stay open for the next commit. OFF → close on success. |

> Tradeoff accepted: a blocking modal means the history graph isn't visible while composing a commit.
> That matches the "work entirely in the commit window" desktop habit. If that ever chafes, switching to a
> non-blocking dialog is a single Base UI `modal={false}` change — note it, don't design around it now.

---

## 2. The surface

- **Component:** Base UI `Dialog` (`Dialog.Root` → `Portal` → `Backdrop` → `Popup`, with `Title`/`Close`).
  Modal/blocking (the default). Styled with the `base-lyra` tokens.
- **Trigger:** opened from (a) the toolbar **Commit** button (`git-commit-horizontal`,
  `toolbar-quick-actions.md` #11), (b) **Commands → Commit…** (`menu-hierarchy.md`), and (c) a keyboard
  shortcut (**Ctrl/Cmd+K then C**, or a direct **Ctrl/Cmd+Shift+Enter** — pick one in the keymap, §6).
  The toolbar Commit button shows the pending-change count badge (`Commit (3)`).
- **Sizing:** large but bounded — `width: min(1100px, 92vw)`, `height: min(860px, 88vh)`, `min-width:
  720px`, `min-height: 480px`. Internally uses resizable split panes (see §3); the **dialog itself is not
  draggable/resizable** (web modals are centered) — persist the *internal* split positions, not window
  geometry.
- **Dismissal:** Esc and backdrop-click close the dialog. **This is safe and lenient by design** because
  no work is lost on close: staged changes live in the git index, and the message draft + option toggles
  are already persisted per-repo session (`06 REQ-P2-COMMIT-003` / `UX-P2-009`). Re-opening restores the
  draft. Do **not** add a "discard?" prompt for plain close — it would be noise given durable state.
  (Only guard if a mutation is mid-flight: block close while a stage/commit RPC is in progress.)

---

## 3. Layout

Three functional zones inside the `Popup`: a **header**, a **body** (two resizable columns), and a
**footer** (message composer + actions). The body mirrors the desktop three-pane arrangement adapted to
web.

```txt
┌──────────────────────────────────────────────────────────────────────┐
│ Commit — <branch>            <committer identity>            [Refresh] ✕│  header
├───────────────────────────────┬──────────────────────────────────────┤
│ Changes                       │ Diff — <selected path>                 │
│  ▾ Unstaged (4)        [Stage]│  [unstaged ⇄ staged toggle for mixed]  │
│    M  src/a.ts            [+] │  ┌────────────────────────────────────┐│
│    ??  new.txt            [+] │  │ hunk ───────────────  [Stage hunk] ││
│  ▾ Staged (2)        [Unstage]│  │  - old line                        ││
│    M  src/b.ts            [−] │  │  + new line   ← gutter line-select  ││
│    D  gone.ts             [−] │  │ hunk ───────────────  [Stage hunk] ││  body
│  [⚠ 1 conflict — resolve]     │  └────────────────────────────────────┘│
├───────────────────────────────┴──────────────────────────────────────┤
│ [conv-commit bar: type ▾ scope  ⚠breaking]                            │
│ Subject  [........................................................] 50│
│ Body     ┌──────────────────────────────────────────────────────────┐│  footer
│          │ (CodeMirror 6, plain text)                                ││
│          └──────────────────────────────────────────────────────────┘│
│ ☐ amend   ☐ sign-off   ☐ sign   ▸ author override   ☐ allow empty     │
│ ☑ keep open after commit            [Cancel]  [Commit ▾]              │
└──────────────────────────────────────────────────────────────────────┘
```

- **Body columns** are a horizontal resizable split (changes | diff). The **changes column** is a single
  virtualized list with collapsible **Unstaged** and **Staged** groups (decision: one list with two
  sections, not tabs — both states visible at once, matching the desktop two-list feel without the
  vertical-split overhead). Conflicts surface as a distinct group/badge at the bottom of the changes list.
- **Diff column** reuses the P1/P2 diff component (`react-diff-view` + Shiki) with per-hunk and
  line-selection staging controls; for a path that is partially staged, a **unstaged ⇄ staged** segmented
  toggle picks which side is shown.
- **Footer** is the composer: conventional-commit bar, subject field (with soft length indicator), body
  editor, option toggles, the keep-open checkbox, and the action buttons.

---

## 4. Behavior by zone

**Changes list** — virtualized; per-row change-kind glyph (added/modified/deleted/renamed/copied/
type-changed/untracked/conflicted) with rename `old → new` + similarity. Row quick-actions: stage/unstage
(`+`/`−`), discard (guarded). Group headers carry **Stage all / Unstage all**. Multi-select via
shift/ctrl + keyboard; **Space toggles stage** on the focused row. Untracked shown by default; ignored
behind a toggle. (`06 REQ-P2-STATUS-*`, `STAGE-*`, `DISCARD-*`.)

**Diff + partial staging** — per-hunk Stage/Unstage/Discard and line-level (incl. non-contiguous)
selection staging via exact-byte patch synthesis; discard only on the unstaged side and behind the
confirmation guard. This is the highest-value/highest-risk feature — it depends on the `06 §7` patch-
header synthesis for new files/deletions and byte-faithful EOL handling under autocrlf/.gitattributes,
which is still open and **must be closed** for line staging to be correct. (`06 REQ-P2-HUNK-*`.)

**Message composer** — separate subject field + CodeMirror 6 plain-text body. Soft ~50-char subject guide
+ blank-second-line guide (non-blocking, never auto-mutates text). Conventional-commit bar composes the
`type(scope):` prefix and offers common footer trailers (`BREAKING CHANGE`, `Co-authored-by`) as optional
inserts; all inserts go through the editor transaction API so **undo works**. Reuse-last-message loads
HEAD's message; a "recent messages" picker (last N from `git log`) is a nice-to-have. (`06 REQ-P2-MSG-*`.)

**Options** — amend (pre-fills previous message, warns it rewrites HEAD, warns if HEAD already pushed),
**reset author** (visible only when amending → `--reset-author`), sign-off trailer, GPG/SSH sign (honors
`gpg.format`; **never silently falls back to unsigned**), collapsible author override, allow-empty
(explicit opt-in). Toggle states persist per-repo session. (`06 REQ-P2-COMMIT-*`.)

**Actions / footer** — primary **Commit** (`Ctrl/Cmd+Enter`). The Commit button is a **split button**: the
caret reserves **Commit & push** (disabled until push lands in P3; see §8). **Cancel** closes. The
**keep-open** checkbox governs post-commit behavior (§5).

---

## 5. Lifecycle

1. **Open** → load status (refresh), restore the persisted draft + toggle states for this repo.
2. **Commit (keep-open ON)** → on success: show the new short-hash + subject (toast/inline), clear the
   message (unless amend), reset transient toggles sensibly, refresh changes + history domains, keep the
   dialog open with focus returned to the subject field.
3. **Commit (keep-open OFF)** → on success: same refresh, then close the dialog.
4. **Close** (Esc / backdrop / Cancel) → dialog closes; staged state and draft persist (durable). Blocked
   only while a mutation RPC is in flight.

The keep-open checkbox default is **ON**, persisted per session (Zustand; optionally mirror to
`localStorage` for across-reload persistence). This re-introduces the desktop "stay open and keep working"
lifecycle that the inline-panel model had made moot.

---

## 6. Keyboard map (define explicitly)

| Keys | Action |
|---|---|
| `Ctrl/Cmd+Enter` | Commit (from anywhere in the dialog, incl. message editor) |
| `Esc` | Close dialog (unless a mutation is in flight) |
| `Space` | Toggle stage/unstage on the focused change row |
| `↑ / ↓` | Move focus within the changes list |
| `Ctrl/Cmd+Z` / `Shift+…` | Undo/redo in the message editor (native CodeMirror) |
| `Tab / Shift+Tab` | Cycle focus regions (changes → diff → subject → body → actions) |

The app-wide command palette (`UX-P2-007`) still exposes Stage all / Unstage all / Commit / Amend / Reuse
last message / Reset as a secondary entry path.

---

## 7. Edge cases & correctness (must-handle)

These came out of the parity gap analysis; several are correctness issues, not polish:

- **Unborn branch / initial commit (no HEAD)** — in a fresh repo `HEAD` doesn't resolve. Amend, reset-to-
  HEAD~1, reset-author, and reuse-HEAD-message are all **invalid** and must be disabled/handled, not allowed
  to throw raw `fatal: ... unknown revision HEAD`. The first-commit path must work cleanly. **(P2-core.)**
- **Conflicts block commit, visibly** — conflicted entries get a distinct state; the **commit guard must
  block on unresolved conflicts** with a clear reason (today the guard text centers on "nothing staged" —
  make conflict-blocking equally explicit). Provide **stage-to-mark-resolved**: staging a conflicted file
  whose markers the user removed (in any editor) clears its conflicted state and unblocks committing. This
  is the minimal escape hatch so a mid-merge repo isn't a dead-end before the full P4 resolver. **(P2-core
  block; stage-to-resolve P2-nice but high value.)**
- **Detached HEAD** — committing is allowed; message it clearly (commit won't advance a branch).
- **Nothing staged** — Commit disabled with a tooltip; allow-empty is the explicit exception.
- **Amend of a pushed HEAD** — best-effort warning from tracking info before rewriting.

---

## 8. Out of scope / reserved

- **Commit & push** — push is P3, so the action is **disabled now but its slot is reserved** in the Commit
  split button. When push lands, wire it and the **post-amend force-with-lease** behavior. (Flagged as a
  common combined action — reserve the affordance so it isn't retrofitted awkwardly.)
- **Fixup / squash commits** (`fixup!`/`squash!` for autosquash rebase) — deferred to the rebase phase;
  recorded here as a deliberate defer, not a silent omission.
- **Named commit templates + validation-rules settings surface** — later, with a settings phase.
- **Spell-check** — rely on the browser's native spellcheck on the editor for MVP; no custom dictionary.
- **Submodule/superproject staging, assume-unchanged/skip-worktree/stop-tracking, file history/blame,
  external difftool/open-in-IDE** — deferred or desktop-only (replaced by the in-app diff).

---

## 9. Reconciliation with existing docs (for the spec/impl agents)

1. **`06-phase2-stage-commit.md`** — change the flow model from inline co-resident panels to **a dedicated
   modal dialog hosting the same components**. Keep all REQ/UX/AC content; restate `UX-P2-*` placement in
   terms of the dialog zones (§3) rather than shell panels. Add requirements for: unborn-branch handling,
   explicit conflict-blocking + stage-to-resolve, the keep-open lifecycle, and the dismissal/durability
   rule (§2).
2. **`desktop-layout-parity.md`** — the bottom **"Commit" detail tab** (§7.1) is for *viewing a selected
   historical commit* and is unchanged. Note that *authoring* a commit is this modal, launched from the
   toolbar/menu — not the bottom panel. Remove any implication that staging/authoring lives inline.
3. **RPC contract drift (`14-rpc-contract.md`)** — reconcile: **`deleteUntracked`**, **`discard.hunks`**,
   and **`commit.lastMessage`** are used by the P2 plan but missing from the authoritative catalog. Add
   them (and define the empty-repo "no last message" error code).
4. **`toolbar-quick-actions.md` / `menu-hierarchy.md`** — confirm the Commit button (#11) and **Commands →
   Commit…** both open this dialog; the `…` ellipsis on the menu item is correct (it opens a surface).
5. **`P2-PLAN.md`** — update the component-mounting plan: `StatusPanel`/`WorkingDiffPanel`/`CommitPanel`
   render inside a `CommitDialog` shell instead of inline; add the keep-open Zustand state.

---

## 10. Clean-room

No third-party product name, window/class identifier, or proprietary control name is used here; the prior
desktop client is referenced only functionally as "the desktop habit/reference." All component, REQ/UX, and
RPC names come from the cbranch plan itself. The dialog primitive and tokens are cbranch's chosen stack
(Base UI + `base-lyra`).
