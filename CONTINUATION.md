# cbranch — Session Continuation Prompt

> A previous session handed off here. When the user says "continue", read this
> file, then resume autonomously. (Supersedes the prior UI-B-era version.)

## What this is
Autonomous, clean-room build of **cbranch** (browser-based Git GUI). **On branch
`feat/p4`**, working dir `D:\GIT_REPOS\DEVOPS\cbranch`. Phase: **P4** — cherry-pick/revert,
conflict resolution + 3-way merge editor, blame, single-file history.

## Operating mode (carry forward)
- **Autonomous / ultracode:** keep going; make a gate-green commit at each slice. Run
  `pnpm gate` before every commit; never advance on red. `pnpm format` first (oxfmt @ 80).
- **Undercover commits:** conventional messages; NO AI/model mentions, no co-authored-by,
  no internal tool/codenames.
- **Clean-room:** build only from `docs/spec/**`, `docs/design/**`, `LICENSES.md`,
  `BRANDING.md`, git/library public docs. NEVER read `.local/SPEC-AGENT-BRIEF.md`.
- **Context protocol:** stay under **30%** of the 1M window; check with
  `node "C:\Users\serge\AppData\Local\claude-profiles\c\hooks\context-usage.mjs"`. Over 30%
  → rewrite this file, ping via **`telegram-notify`**, STOP. (This handoff triggered at 38.1%.)
- **Per-slice loop that worked:** scout patterns → implement the slice yourself → `pnpm format`
  + `pnpm gate` → run an **adversarial review Workflow** (4 dims → per-finding skeptic verify)
  → fix confirmed findings + add tests → re-gate → undercover commit. Reuse it.

## State — P4 plan at `docs/_impl-notes/P4-PLAN.md` (gitignored). Core S1–S7 + UI-A/B/C/D landed on `feat/p4`:
- S1 contract+plumbing `09724e1` · S2 conflict.list `61d0f9c` · S3 conflict.sides `28af0be` ·
  S4 conflict mutations `e463129` · S5 cherry-pick/revert/continuation `7ecc0ad` · S6 blame `ec5d591` ·
  S7 file history `89217e4`.
- UI-A conflict panel + in-progress banner `c622199`.
- UI-B 3-way merge editor `47522b4` + `9287eca`.
- **UI-C (this session) — cherry-pick / revert / empty-result dialogs:** `1e795b1`
  (`feat(ui): cherry-pick and revert dialogs with empty-result prompt`). Gate green, branches **80.51%**.
  Files: `lib/sequencer-outcome.ts`(+test, pure result→action router), `components/SequencerDialogs.tsx`
  (+test; `CherryPickDialog`/`RevertDialog`/`EmptyPickDialog` + the `PickDialogs` host + a shared
  `usePickTarget` hook), `state/store.ts` (`pickDialog` discriminated state + `setPickDialog`),
  `rpc/hooks.ts` (`useCherryPick`/`useRevert`), `menu/menu-model.ts` (`commands.revert`),
  `menu/use-menu-actions.ts` (wired cherryPick/revert on the selected commit), `AppShell.tsx`
  (renders `<PickDialogs/>`), `CommitTab.tsx` (detail-view buttons), `HistoryList.tsx` (row actions menu).
  - **Design:** `store.pickDialog = {cherryPick|revert} commits[] | {empty} mode+offender+message | null`.
    Mainline `<select>` (native) shown only for a single merge commit (parents≥2 from `useCommitDetail`),
    **gates submit** (AC-3/5); `usePickTarget` gates on `detail.isSuccess` so a failed detail load can't
    skip the gate. `-x` + don't-commit checkboxes; editable single-commit revert message (git-style
    default), **preserved through the empty prompt** (threaded into `OpContinue{allowEmpty,message}`).
    Outcome routing (`planSequencerAction`): completed/staged→toast+close, conflicts→`solveConflicts`
    view, empty→EmptyPickDialog (Skip=`OpSkip` / Commit-anyway=`OpContinue{allowEmpty}`); empty dialog
    dismiss routes to `solveConflicts` so the in-progress banner is reachable. Errors→`toast.error`,
    dialog stays open (REQ-UX-011).
  - **Reviewed via the adversarial Workflow: 8 confirmed findings (all LOW), ALL fixed** (detail-error
    gate, empty Cancel→banner, revert message through empty, mainline shows parent shortOids, dedup via
    `usePickTarget`, multi-commit deferral note).
- **UI-D (this session) — blame view:** `66fabc3`
  (`feat(ui): blame view with line gutter and previous-revision walk-back`). Gate green, branches **80.44%**.
  New: `lib/blame-blocks.ts`(+test, pure contiguous-block grouping REQ-BL-003), `components/BlamePanel.tsx`(+test),
  `components/ui/popover.tsx` + `ui/skeleton.tsx` (vendored Base UI wrappers — popover/skeleton were MISSING).
  Edited: `rpc/hooks.ts` (`useBlame`, content-addressed; `force` keys a distinct cache leaf), `state/store.ts`
  (`blameTarget {rev,path}` overlay slice, reset on repo change), `AppShell.tsx` (renders `<BlamePanel>` overlay,
  `onOpenCommit`→`selectOid`), `DiffPanel.tsx` (toolbar "Blame" + passes `onBlame` to the file list),
  `ChangedFileList.tsx` (optional `onBlame` "…" file menu; row refactored button→div to avoid nested buttons).
  - **Design:** store-driven Dialog overlay (NOT the reserved `/blame` route — every view here is store-driven).
    Virtualized line list (`@tanstack/react-virtual`, fixed `ROW_HEIGHT`), gutter shows the owning commit once per
    contiguous block (block-start hairline border), per-line rows keep granularity. `BlameCommitPopover` (click) =
    full SHA/author/date/subject + "Open commit" (`selectOid`) + "Blame previous" (re-blames `previousOid`/
    `previousPath`, **per-frame back-stack**). Oversize → `BlameTooLarge` arm: "Blame anyway" forces **and** drops
    highlighting (REQ-EDGE-010); a header "Syntax highlighting" toggle otherwise. Shiki tokens bridged like
    `FileAtRevision`. Entry points: diff toolbar + file "…" menu (REQ-UX-012). rev = a concrete commit oid (cacheable).
  - **Reviewed via the adversarial Workflow: 6 confirmed (2 med correctness, 1 reuse, 2 test, 1 low), ALL fixed**
    (clear Shiki tokens at effect-entry so a cache-immediate frame change never paints stale lines; "Blame anyway"
    drops highlighting; **`forced` moved into per-frame stack state** to kill the deferred-reset races; subscribe
    `theme` for re-tokenize on light/dark; added loading-Skeleton + both entry-point tests). 3 "Back-button untested"
    findings correctly DISMISSED (Back is not spec-mandated; repeatability already covered) — though a Back assertion
    was added anyway since it was cheap.

## KEY GOTCHAS (verified across UI-A/B/C)
- **Base UI `Checkbox`/`Switch` label trap:** the control renders a button AND a hidden form input, so a
  `<label htmlFor>` labels BOTH → `getByLabelText` finds 2. Use **`aria-label` on the control** + a plain
  `<span>` for text (see `CheckboxField`); query/click via `getByLabelText`.
- **Base UI `Select` is unproven in this repo** (only the wrapper exists, no consumer). For the mainline
  picker UI-C used a **native `<select>`** (spec REQ-UX-002 permits "Select or numeric input") — robust +
  trivially testable via `fireEvent.change`. Prefer that over the vendored Select until one is proven.
- **`@shikijs/codemirror` is a 404 in this registry** — bridge Shiki tokens into CodeMirror as decorations
  (FileAtRevision pattern). Only `@codemirror/merge` was added in UI-B.
- **UI vitest MUST run via the ROOT config:** `pnpm exec vitest run <file>` — NOT `pnpm --filter @cbranch/ui`.
- **depcheck recognizes dynamic `import()`** (a lazy `import("@codemirror/merge")` satisfies it).
- **Tooling escape trap:** Write/Edit content JSON-decodes; never put a literal `\n`/`\r\n`/`\\` in written
  CODE strings — use `String.fromCharCode(10)` (repo convention; see `NL` in SequencerDialogs.tsx).
- **Component tests:** fake `CbranchApi` via `makeApi(over) as unknown as CbranchApi` (only the methods the
  component calls), wrap in `QueryClientProvider`+`ApiProvider`, drive store with `useUiStore.setState`,
  mock `sonner` to assert toasts. `// @vitest-environment jsdom` header; Base UI dialogs/menus render in jsdom.
- **`toHaveBeenCalledWith` ignores `undefined`-valued keys** (`{a:true,b:undefined}` ≡ `{a:true}`); use
  `expect.objectContaining` when an opts object may carry undefined fields.
- **Base UI `Popover` works in jsdom** (vendored `ui/popover.tsx` mirrors `tooltip.tsx`); opens on a plain
  `fireEvent.click` of the trigger, same as the `DropdownMenu` (no ResizeObserver polyfill needed). `Skeleton`
  carries `data-slot="skeleton"` — query it to assert a loading state.
- **Async-highlight-on-frame-change trap:** any virtualized list that renders Shiki TOKEN content per row must
  `setTokens(null)` at the tokenize-effect entry — when the next item's data is cache-immediate the data ref goes
  non-null→non-null without passing through null, so the previous frame's tokens paint the new lines for a tick.
- **Per-frame transient state:** a back-stack frame must carry its own flags (e.g. blame `forced`); a separate
  `useState` reset via `useEffect(…, [frame])` lags one render → a wasted/stale fetch on navigate. Put it in the frame.
- **Run a UI vitest file:** `pnpm exec vitest run <file>` (ROOT config) — the gate's exit code is masked by `| tail`
  AND by a trailing `; echo`, so to read a real gate result redirect to a file and check separately (don't trust the
  bg-task "exit 0" through a pipe).

## NEXT — do in order, gate-green + undercover commit each
1. **UI-E — File history view** (core S7 ready). `FileHistoryPanel` (Table: SHA/author/date/subject +
   rename indicator w/ prior path), `FileHistoryRow`, `useFileHistory` (`useInfiniteQuery`, `nextCursor`,
   Load more). Per-revision actions reuse viewers: View diff (`commitDiff` paths=[path]), View file at rev
   (`fileContentAtRev`), **Blame at rev** (set `store.blameTarget = {rev:oid, path}` → reuses UI-D's `BlamePanel`).
   `shadcn add table` (or hand-vendor like UI-D's popover/skeleton — registry `add` may not be reachable;
   `@base-ui/react` is the import). Entry points: file "…" menu (`ChangedFileList`, extend the existing `onBlame`
   menu) + diff toolbar (next to "Blame"). New store overlay slice mirrors `blameTarget`. AC-13(08), REQ-FH-001..005.
2. **UI-F (kdiff3 client) + UI-G (companion agent) = DEFERRED/optional per D17** — skip by default.
3. **P4 close-out:** self-review pass, then `DECISIONS.md` **D17** (the batched P4 entry) + **backfill the
   missing P3 D16** (sync-streaming; `branches.ts` forward-references it) — both in one edit (P4-PLAN
   "DECISIONS to record").

## Run / verify
- **Gate:** `pnpm gate` (license-audit → lint → format:check → typecheck → build → test → coverage → depcheck).
- **Run app:** `pnpm -r build` then
  `CBRANCH_CLIENT_DIR=$PWD/packages/ui/build/client pnpm --filter @cbranch/web-server start` → http://127.0.0.1:7420.

## First action on resume
1. `pnpm gate` — confirm green at `66fabc3` (head of `feat/p4`, UI-D blame view).
2. `git status` — a concurrent agent has uncommitted hydration/theme WIP (`root.tsx` `suppressHydrationWarning`,
   `vite.config.ts` comment, sometimes a `__repro_hydrate.cjs`). **NOT mine — never stage it**; stage UI-E files
   explicitly. `CONTINUATION.md` may also be a pending `docs:` change.
3. Start **UI-E** (File history). Run the adversarial review Workflow before committing.
