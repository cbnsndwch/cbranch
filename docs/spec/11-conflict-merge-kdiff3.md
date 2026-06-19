# Conflict Resolution, 3-way Merge Editor & kdiff3 Integration

## Purpose

When a Git operation (merge, pull, rebase, cherry-pick, revert, stash apply) leaves the working tree with conflicting changes, cbranch must let the user understand and resolve every conflict and mark each path as resolved, then continue or complete the in-progress operation. This section specifies two complementary resolution surfaces:

1. **The built-in 3-way merge editor** — an always-available, zero-install, fully in-browser editor that shows the common ancestor (base), the current branch result (ours), and the incoming change (theirs), lets the user accept hunks from either side or both, freely edit the merged result, and save the result so it is written to the working tree and staged. This is the default and requires nothing installed on the client beyond a browser.

2. **External tool (kdiff3) integration** — an optional path for users who prefer the kdiff3 desktop merge tool. Because the cbranch service runs on the remote host while the user sits at a client machine connected over an SSH tunnel, the external tool cannot run on the host (no display). cbranch therefore relays the three blob contents to a small, token-authenticated **companion agent** bound to `127.0.0.1` on the *client* machine, which writes temp files, launches kdiff3, waits for it to exit, and returns the merged text. The browser sends that text back to the service, which writes it into the working tree and stages it.

The VSCode-extension variant does not ship a companion agent; it invokes the editor's own built-in 3-way merge editor command, which renders on the client over Remote-SSH.

This document covers the observable behavior, the exact Git subcommands cbranch runs and the output it parses, the security requirements for the companion agent, acceptance criteria, and edge cases. It does not prescribe any particular merge or diff algorithm; where an outcome is required, the implementer may choose any correct algorithm or any permissively licensed library.

## User stories

- As a developer who just ran a pull that conflicted, I want to see exactly which files conflict and open each one in a side-by-side view so I can choose the right content quickly.
- As a developer resolving a conflict, I want to accept the incoming version of one hunk, keep my version of another, and hand-edit a third, then save once and have the file staged automatically.
- As a developer who is sure one whole file should take one side, I want a single action to take "ours" or "theirs" for the entire file without opening the editor.
- As a developer who trusts kdiff3, I want to launch it on my own laptop for a specific conflicted file, resolve there, and have the result flow back into the repo on the remote host without manually copying files.
- As a developer in VSCode Remote-SSH, I want conflicts to open in the editor's native 3-way merge editor instead of a browser tab.
- As a developer who started a merge I no longer want, I want to abort the whole operation and return the repository to its prior state.

## Functional requirements

Each requirement is testable and observable. Identifiers are stable.

### Conflict discovery & state

- **REQ-CONFLICT-001** When the repository is in a state with at least one unmerged path, cbranch MUST present a dedicated "Conflicts" view listing every conflicted path, grouped by the operation in progress (merge, rebase, cherry-pick, revert, stash apply) when that state is detectable.
- **REQ-CONFLICT-002** For each conflicted path cbranch MUST display its conflict type derived from which index stages are present: stage 1 = base, stage 2 = ours, stage 3 = theirs. The displayed type MUST distinguish at minimum: both-modified (stages 1, 2, 3), added-by-us / added-by-them (one of stages 2 or 3 with no stage 1), deleted-by-us / deleted-by-them (stage 1 plus exactly one of stage 2 or 3), and both-added (stages 2 and 3 with no stage 1).
- **REQ-CONFLICT-003** cbranch MUST show the count of remaining unresolved paths and update it whenever a path becomes resolved or returns to conflicted.
- **REQ-CONFLICT-004** cbranch MUST detect and surface the in-progress operation (e.g., presence of an active merge, rebase, cherry-pick, or revert sequence) and offer the appropriate continuation actions: continue/commit, skip (where the operation supports skipping), and abort.
- **REQ-CONFLICT-005** A path MUST be treated as resolved only after it has been added to the index in a non-conflicted state (no remaining stage-1/2/3 entries for that path). cbranch MUST re-verify resolution from Git state, not infer it solely from UI actions.

### Built-in 3-way merge editor

- **REQ-MERGE-010** Selecting a conflicted text path MUST open the 3-way merge editor with three labeled regions: **Base** (common ancestor), **Result** (the editable working merge), and **Incoming** (theirs). The current-branch side (ours) MUST also be available for comparison; the layout MUST make all three contributing versions (base, ours, theirs) inspectable while the Result region is the single editable target.
- **REQ-MERGE-011** The editor MUST load base content from index stage 1, ours from stage 2, and theirs from stage 3. When a stage is absent (e.g., added-by-them has no base), the editor MUST represent that side as empty/absent rather than failing.
- **REQ-MERGE-012** The editor MUST compute and display conflict regions ("hunks") between the sides. For each hunk the editor MUST offer per-hunk actions: **Accept Ours**, **Accept Theirs**, **Accept Both** (ours then theirs), and **Accept Both (reversed)** (theirs then ours). The required outcome is that applying an action inserts the corresponding side(s)' lines into the Result at that hunk's location; the diff/merge algorithm is unspecified.
- **REQ-MERGE-013** The Result region MUST be freely editable as plain text at all times, independent of and after any per-hunk actions.
- **REQ-MERGE-014** The editor MUST provide navigation to jump to the next and previous unresolved conflict hunk and MUST indicate how many hunks remain unaddressed in the current file.
- **REQ-MERGE-015** The editor MUST initialize the Result region with a sensible starting point that preserves the non-conflicting context lines shared by ours and theirs and clearly delimits the conflicting regions awaiting a decision. cbranch MUST NOT require the user to retype non-conflicting content.
- **REQ-MERGE-016** Saving the merge editor MUST write the exact Result text to the working-tree file and then stage that path (mark resolved). After a successful save, the path MUST no longer appear as unresolved (see REQ-CONFLICT-005).
- **REQ-MERGE-017** The editor MUST warn before saving if the Result still contains conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`, or `|||||||`), and MUST require explicit confirmation to save anyway. Saving with markers present MUST still be possible (user override) but MUST be flagged.
- **REQ-MERGE-018** The editor MUST support discarding unsaved Result edits (revert to the last loaded/saved state) without affecting other files.
- **REQ-MERGE-019** Syntax highlighting MUST be applied to all regions based on the file path's language when a highlighter is available; highlighting MUST never alter the bytes written on save.
- **REQ-MERGE-020** For files detected as binary or exceeding a configurable size threshold, cbranch MUST NOT open the text merge editor and MUST instead offer whole-file resolution actions (take ours / take theirs) and, where applicable, the external-tool path. Binary detection and the threshold MUST be surfaced to the user with an explanatory message.

### Whole-file (no-editor) resolution

- **REQ-WHOLE-030** For any conflicted path, cbranch MUST offer "Take ours (current branch)" and "Take theirs (incoming)" actions that resolve the entire file to one side and stage it, without opening the editor.
- **REQ-WHOLE-031** For deleted-by-us / deleted-by-them conflicts, cbranch MUST offer both "Keep the file (use the existing side's content)" and "Accept the deletion (remove the file)" and MUST stage the corresponding result.
- **REQ-WHOLE-032** Whole-file actions MUST be available individually per path and as a bulk action over a multi-selection of conflicted paths.

### Continuation, abort, and commit

- **REQ-CONT-040** When all paths are resolved, cbranch MUST enable the continuation action appropriate to the in-progress operation (commit the merge, continue the rebase, continue the cherry-pick/revert sequence).
- **REQ-CONT-041** cbranch MUST allow aborting the in-progress operation at any time, returning the repository to the state before the operation began, and MUST clearly warn that in-progress resolutions will be lost.
- **REQ-CONT-042** For merges, cbranch MUST prefill the merge commit message (the standard auto-generated message) and allow editing it before committing.
- **REQ-CONT-043** cbranch MUST refuse to run a continuation while any path remains unresolved and MUST clearly indicate which paths still block continuation.

### External tool (kdiff3) over the companion agent

- **REQ-KDIFF-050** cbranch MUST offer, per conflicted text path, an "Open in kdiff3" action that is available only when a reachable, authenticated companion agent has been detected on the client (see REQ-AGENT-*). When no agent is reachable, the action MUST be hidden or disabled with an explanatory tooltip, and the built-in editor MUST remain fully usable.
- **REQ-KDIFF-051** When invoked, cbranch MUST obtain the three blob contents (base = stage 1, local/ours = stage 2, remote/theirs = stage 3) from the service, relay them through the browser to the companion agent, and request a merge. Absent stages MUST be sent as empty content with an explicit "absent" flag so the agent can supply an empty temp file.
- **REQ-KDIFF-052** The companion agent MUST write the received contents to files inside a sandboxed temp directory and launch kdiff3 with base, local, and remote inputs and an output target for the merged result, then wait for the process to exit.
- **REQ-KDIFF-053** On kdiff3 exit with a success status and an output file present, the agent MUST return the merged file's text to the browser. cbranch MUST then send that text to the service, which writes it to the working-tree path and stages it (identical post-condition to REQ-MERGE-016).
- **REQ-KDIFF-054** On kdiff3 exit with a non-success status (user cancelled / saved no result), cbranch MUST leave the path unresolved and MUST show a non-destructive message; no working-tree write occurs.
- **REQ-KDIFF-055** The companion agent MUST delete temp files for a merge request after returning the result or after a bounded timeout, whichever comes first. Temp content MUST NOT persist beyond the session.
- **REQ-KDIFF-056** cbranch MUST enforce a configurable timeout for the whole external-merge round trip; on timeout it MUST leave the path unresolved and inform the user, and the agent MUST clean up.
- **REQ-KDIFF-057** The path encoding MUST be preserved end-to-end: blob bytes extracted from Git MUST be transported without lossy transformation, and the merged bytes returned MUST be written to the working tree unchanged.

### Companion agent discovery & security

- **REQ-AGENT-060** The companion agent MUST bind only to the loopback interface (`127.0.0.1`) on the client machine and MUST NOT listen on any externally routable address.
- **REQ-AGENT-061** Every request to the agent MUST carry a per-session shared bearer token; the agent MUST reject any request lacking the correct token. The token MUST be established out of band for the session (e.g., shown by the agent and entered into / configured for cbranch) and MUST NOT be guessable.
- **REQ-AGENT-062** The agent MUST enforce an Origin allowlist and reject requests whose Origin is not on the allowlist, to mitigate requests initiated by arbitrary web pages on the client.
- **REQ-AGENT-063** The agent MUST use a single pinned, preconfigured merge-tool executable path. The web page / service MUST NOT be able to specify, override, or influence which binary is launched or its argument template beyond supplying the three input contents and receiving the output.
- **REQ-AGENT-064** The agent MUST confine all temp files to a sandboxed temp directory it owns and MUST NOT read or write outside that directory in response to a merge request. File names inside the sandbox MUST NOT be derived from untrusted path strings in a way that permits traversal.
- **REQ-AGENT-065** The agent MUST validate request size limits and reject oversized payloads to avoid resource exhaustion.
- **REQ-AGENT-066** All communication between browser and agent over loopback MUST still require the token and Origin checks even though it is local; the token MUST never be logged.
- **REQ-AGENT-067** cbranch MUST treat the agent as untrusted-by-default until the token handshake succeeds, and MUST degrade gracefully (built-in editor only) when the agent is absent, unreachable, or rejects the handshake.

### VSCode-extension variant

- **REQ-VSCODE-070** In the VSCode-extension build, the "resolve conflict" action for a text path MUST invoke the editor's built-in 3-way merge editor command for that file rather than opening the browser merge editor or using the companion agent.
- **REQ-VSCODE-071** The extension variant MUST NOT ship or depend on the companion agent; over Remote-SSH the built-in merge editor renders on the client while the file lives on the host.
- **REQ-VSCODE-072** After the user completes resolution in the editor's merge editor and the file no longer has unmerged stages, the extension MUST reflect the path as resolved using the same Git-state verification as REQ-CONFLICT-005.

## Git operations

cbranch runs the host `git` binary (the single `GitEngine` backend) for network sync, for operations that mutate in-progress states (merge/rebase/cherry-pick/revert continuation and abort), and for reading conflict state and blob stages via the commands below. The observable parsed output is what this section pins.

### Detecting conflicted paths and types

- `git status --porcelain=v2 --branch -z`
  - cbranch parses the porcelain v2 records. **Unmerged** entries begin with `u` and include the conflict stage mode information and the path; cbranch uses these to enumerate conflicted paths and to derive type. The two-character XY field of unmerged records encodes which sides changed (e.g., both-modified, added-by-them, deleted-by-us, both-added). NUL (`-z`) record separation is used to handle paths with special characters safely.
- `git ls-files -u -z`
  - Lists unmerged index entries as one line per present stage. cbranch parses the stage number (1 = base, 2 = ours, 3 = theirs) and object id per path to determine precisely which stages exist for each conflicted path (the basis for REQ-CONFLICT-002). NUL separation handles unusual paths.

### Reading the three contributing versions

- `git show :1:PATH` — base (common ancestor) blob content.
- `git show :2:PATH` — ours (current branch) blob content.
- `git show :3:PATH` — theirs (incoming) blob content.
  - cbranch invokes these for the path under resolution to populate the merge editor regions and to source the three blobs for the companion agent. A non-zero exit for a given stage indicates that stage is absent for the path (e.g., no base in an add/add conflict); cbranch treats absence as empty content with an "absent" flag rather than an error.

### Whole-file resolution

- `git checkout --ours -- PATH` — set the working-tree file to the current-branch version.
- `git checkout --theirs -- PATH` — set the working-tree file to the incoming version.
- `git add -- PATH` — mark the path resolved (stage the resolved content). Used after whole-file checkout, after a built-in-editor save, and after an external-tool merge writes the working-tree file.
- `git rm -- PATH` — used to accept a deletion in deleted-by-us / deleted-by-them resolutions.

### Continuation and abort

- Merge: `git commit` (with the prefilled/edited message) to complete; `git merge --abort` to abort.
- Rebase: `git rebase --continue`, `git rebase --skip`, `git rebase --abort`.
- Cherry-pick: `git cherry-pick --continue`, `git cherry-pick --skip`, `git cherry-pick --abort`.
- Revert: `git revert --continue`, `git revert --skip`, `git revert --abort`.
  - Before any continuation, cbranch re-runs `git status --porcelain=v2 -z` and refuses to continue while unmerged entries remain (REQ-CONT-043).

### Writing a saved/merged result

cbranch writes the final text to the working-tree path on the host via the service's file access, then runs `git add -- PATH`. After staging, cbranch re-reads status to confirm the path is no longer unmerged (REQ-CONFLICT-005).

## UI/UX requirements

Expressed in terms of the cbranch UI toolkit (shadcn/ui `base-lyra` on Base UI, Tailwind v4, Lucide icons, virtualized lists). The built-in 3-way merge editor is the CodeMirror 6 + `@codemirror/merge` surface with Shiki highlighting (per `03-tech-stack.md` REQ-STACK-021/022). These are functional, not visual-design, requirements.

- **REQ-UX-080** The Conflicts view MUST present the unresolved-path list using a virtualized list so that repositories with many conflicts remain responsive. Each row MUST show the path, a conflict-type badge (shadcn `Badge`), and a per-row action menu (`DropdownMenu`) exposing Resolve in editor, Take ours, Take theirs, and (when available) Open in kdiff3.
- **REQ-UX-081** A persistent header/summary MUST show the in-progress operation and remaining unresolved count, with primary actions (Continue/Commit, Abort) as shadcn `Button`s; the continuation button MUST be disabled while any path is unresolved, with a tooltip explaining why.
- **REQ-UX-082** The built-in 3-way merge editor MUST be presented as a focused workspace (full-pane or large `Dialog`/`Sheet`) with the three regions clearly labeled "Base", "Result", "Incoming" and ours reachable for comparison. Per-hunk action controls MUST appear inline at each hunk (buttons for Accept Ours / Accept Theirs / Accept Both).
- **REQ-UX-083** Conflict-hunk navigation (next/previous) MUST be available via on-screen controls and keyboard shortcuts, and the editor MUST indicate the current hunk index and total.
- **REQ-UX-084** Save MUST be a clearly labeled primary action; when the Result still contains conflict markers, the Save action MUST trigger a confirmation (`AlertDialog`) per REQ-MERGE-017.
- **REQ-UX-085** Destructive or override actions (Abort operation, Save with markers, bulk Take ours/theirs, Accept deletion) MUST require confirmation via `AlertDialog` and MUST state the consequence.
- **REQ-UX-086** Long-running external-merge round trips MUST show progress/pending state and allow cancellation; on cancel the UI MUST return the path to unresolved without writing.
- **REQ-UX-087** Errors (agent unreachable, kdiff3 nonzero exit, timeout, write failure) MUST be surfaced as non-blocking toasts/inline messages with actionable text, never silent.
- **REQ-UX-088** The command palette (cmdk) MUST expose conflict actions: open next conflict, take ours, take theirs, continue operation, abort operation.
- **REQ-UX-089** All actions that change Git state MUST reflect updated conflict counts and the list within the same interaction without requiring a manual refresh.

## Acceptance criteria

- **AC-1** Given a repository with a both-modified text conflict, when the user opens the file in the built-in merge editor, accepts theirs for one hunk and ours for another, edits a third hunk by hand, and saves, then the working-tree file contains exactly the Result text, the path is staged, and it disappears from the unresolved list.
- **AC-2** Given a both-modified conflict, when the user chooses "Take theirs" without opening the editor, then the working-tree file equals the incoming version and the path is staged and resolved.
- **AC-3** Given an add/add conflict (no base), when the user opens the merge editor, then the Base region is shown as empty/absent and the editor does not error; saving still stages the result.
- **AC-4** Given all conflicts resolved during a merge, when the user clicks Continue/Commit with an edited message, then a merge commit is created and the repository leaves the conflicted state.
- **AC-5** Given any in-progress operation, when the user clicks Abort and confirms, then the repository returns to its pre-operation state and the Conflicts view is empty.
- **AC-6** Given a reachable, authenticated companion agent and kdiff3 installed on the client, when the user opens a conflicted file in kdiff3, resolves it, and saves in kdiff3, then the merged text is written to the host working tree and staged, and the path is resolved.
- **AC-7** Given the companion agent is not running, when the user views a conflict, then "Open in kdiff3" is hidden or disabled with an explanation and the built-in editor remains fully functional.
- **AC-8** Given a request to the companion agent with a missing or wrong token, then the agent rejects it and no temp files are created and no executable is launched.
- **AC-9** Given a request to the companion agent with a disallowed Origin, then the agent rejects it.
- **AC-10** Given kdiff3 is closed without saving (nonzero exit), then the path remains unresolved, no working-tree write occurs, and the user is informed.
- **AC-11** Given the external-merge round trip exceeds the configured timeout, then the path remains unresolved, the user is informed, and the agent cleans up its temp files.
- **AC-12** Given a Result that still contains conflict markers, when the user attempts to save, then a confirmation is required; proceeding writes the markers and a follow-up indicates the file likely still needs attention.
- **AC-13** Given a binary or oversized conflicted file, then the text merge editor does not open and whole-file resolution actions are offered with an explanation.
- **AC-14** (VSCode variant) Given a text conflict, when the user resolves it, then the editor's built-in 3-way merge editor opens, the companion agent is not used, and on completion the path is reported resolved via Git-state verification.
- **AC-15** Given paths containing spaces, unicode, or other special characters, then they are correctly enumerated, opened, resolved, and staged (verified via NUL-separated parsing).

## Edge cases & error handling

- **Conflict markers already in source files**: A repository may legitimately contain literal `<<<<<<<`-style lines in non-conflicted files. The marker warning (REQ-MERGE-017) applies only to the merge editor's Result region for an actually-conflicted file, not to general editing.
- **CRLF / line-ending and BOM differences**: cbranch MUST preserve the byte content the user saves; it MUST NOT silently normalize line endings or strip/add a BOM when writing the resolved file. Where the repository's normalization settings would re-normalize on stage, that is Git's documented behavior and is out of cbranch's control, but cbranch's own write path MUST be byte-faithful.
- **No common ancestor / absent stages**: add/add, delete/modify, and modify/delete conflicts have missing stages; cbranch represents missing sides as absent and offers the appropriate whole-file actions (keep vs. accept deletion).
- **Path becomes resolved externally**: If the conflict state changes underneath cbranch (e.g., the user edited and staged via another tool), a refresh of `git status --porcelain=v2` MUST reconcile the list; cbranch MUST not show a stale "unresolved" entry after re-read.
- **Continuation while unresolved**: Attempting to continue with remaining unmerged entries MUST be blocked client-side (disabled action) and MUST also be safe if the underlying `git ... --continue` would reject it; cbranch surfaces the Git error verbatim if it occurs.
- **Submodule conflicts**: A conflicted submodule reference is not a text merge; cbranch MUST detect this and offer choosing ours/theirs commit (whole-"file" resolution) rather than opening the text editor.
- **Large numbers of conflicts**: The list MUST remain responsive via virtualization; bulk whole-file actions MUST be available to resolve many paths at once.
- **Companion agent failures**: Connection refused, token mismatch, Origin rejection, oversized payload, kdiff3 not installed at the pinned path, kdiff3 crash, nonzero exit, and round-trip timeout MUST each produce a distinct, actionable message and MUST never leave the working tree partially written.
- **Concurrency / locking**: All mutating resolution actions (checkout --ours/--theirs, add, rm, continue, abort, write-and-stage) MUST go through the per-repository serialization lock; after any host-git mutation the affected invalidation domains (`status`, `inProgress`) are emitted on the WebSocket invalidation bus (see `15-sync-protocol.md`) so the conflict list refetches fresh state.
- **Interrupted save**: If writing the resolved working-tree file fails (disk full, permissions), cbranch MUST NOT stage the path and MUST report the failure; the path remains unresolved.
- **Token leakage**: The session bearer token for the agent MUST never appear in logs, error messages, or telemetry.
- **Multiple browser sessions**: If two sessions act on the same repository, the serialization lock plus Git-state re-verification (REQ-CONFLICT-005) MUST prevent one session from reporting a path resolved that another has reverted.

## Out of scope

- The internal diff/merge/hunk-computation algorithm: any correct algorithm or permissively licensed library may be used; this spec pins only the observable outcomes.
- Configuration, packaging, distribution, and auto-update of the client-side companion agent and of kdiff3 itself (covered separately); this section specifies only the protocol and security contract cbranch relies on.
- Support for merge tools other than kdiff3 (the external-tool surface here is scoped to kdiff3; a generic tool-selection framework is future work).
- Three-way merging of binary assets within cbranch (handled via whole-file take-ours/take-theirs or an external tool that itself understands the format).
- Conflict-free merge/rebase/cherry-pick execution and their command flows (covered in the branches/sync and history-operations sections); this section begins once an operation has produced unmerged paths.
- Resolving conflicts arising from operations not listed in REQ-CONFLICT-001.
