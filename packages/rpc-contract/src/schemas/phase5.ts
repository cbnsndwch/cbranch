// P5 success schemas: power features — repository maintenance (gc), clean, archive,
// reflog, bisect, submodules, settings/config, interactive rebase.
// (docs/spec/09-phase5-power.md; DECISIONS D18.) Every record is a `Schema.Class` so
// the class name doubles as the exported wire type; closed enumerations are
// `Schema.Literals`. Each P5 feature slice APPENDS its schemas to this one file — one
// consolidated set, no duplication (D18); reuse `Oid`/`RepoId` from `primitives` and
// `CommitSummary` from `domain` rather than re-declaring.

import { Schema } from 'effect';

import { CommitSummary } from './domain';
import { OperationProgress } from './phase4';
import { Oid } from './primitives';

// ─── S1: repository maintenance (gc) ─────────────────────────────────────────────

/**
 * The `git gc` prune behavior (REQ-P5-GC-002). `"now"` maps to `--prune=now` (a
 * deliberate Select opt-in); `"default"` omits `--prune`, keeping git's default
 * expiry. gc removes no tracked content, so neither needs an extra confirmation.
 */
export const GcPrune = Schema.Literals(['default', 'now']);
export type GcPrune = typeof GcPrune.Type;

/**
 * The captured output of a `git gc` run (REQ-P5-GC-003). Both fields are the host
 * git stdout/stderr surfaced for DISPLAY only — never parsed for control flow (a
 * non-zero exit is the authoritative failure, mapped to `gitFailed`).
 */
export class GcResult extends Schema.Class<GcResult>('GcResult')({
    stdout: Schema.String,
    stderr: Schema.String,
}) {}

// ─── S2: clean working directory ─────────────────────────────────────────────────

/**
 * One entry git would remove (REQ-P5-CL-001). `isDirectory` is derived from git's
 * trailing `/`, which the `path` retains so the destructive run can pass it back as a
 * pathspec unchanged.
 */
export class CleanEntry extends Schema.Class<CleanEntry>('CleanEntry')({
    path: Schema.String,
    isDirectory: Schema.Boolean,
}) {}

/** The dry-run preview: exactly what a clean with the same options would remove. */
export class CleanPreview extends Schema.Class<CleanPreview>('CleanPreview')({
    entries: Schema.Array(CleanEntry),
}) {}

/** The destructive clean outcome: the count of previewed entries removed (REQ-P5-CL-005). */
export class CleanResult extends Schema.Class<CleanResult>('CleanResult')({
    removed: Schema.Number,
}) {}

// ─── S3: archive export ──────────────────────────────────────────────────────────

/** A host-git archive format (REQ-P5-AR-002). `tar.gz` is the supported compressed tar. */
export const ArchiveFormat = Schema.Literals(['zip', 'tar', 'tar.gz']);
export type ArchiveFormat = typeof ArchiveFormat.Type;

/**
 * A server-minted pointer to a streamed archive download (REQ-P5-AR-004). A sibling of
 * {@link DownloadDescriptor} but **without `size`** — an archive's byte length is
 * unknowable before it streams (D18); the UI reports the size from the downloaded blob.
 * The bytes travel over the HTTP side-channel (`GET /sidechannel/archive`), never the
 * WS/NDJSON bus.
 */
export class ArchiveDescriptor extends Schema.Class<ArchiveDescriptor>(
    'ArchiveDescriptor',
)({
    url: Schema.String,
    filename: Schema.String,
    contentType: Schema.String,
    format: ArchiveFormat,
}) {}

// ─── S4: reflog viewer ───────────────────────────────────────────────────────────

/**
 * One reflog entry (REQ-P5-RL-001). `action` is the `%gs` label before the first `:`
 * (kept an OPEN `Schema.String` — reflog action tokens drift across git versions);
 * `message` is the remainder. `oid` is the entry's RESOLVED commit (writes target it,
 * not `HEAD@{n}`, to dodge the prune/expire reparse race).
 */
export class ReflogEntry extends Schema.Class<ReflogEntry>('ReflogEntry')({
    selector: Schema.String,
    oid: Oid,
    action: Schema.String,
    message: Schema.String,
}) {}

/** A reflog page; `nextCursor` reuses the history skip-cursor codec (present iff a full window). */
export class ReflogPage extends Schema.Class<ReflogPage>('ReflogPage')({
    entries: Schema.Array(ReflogEntry),
    nextCursor: Schema.optional(Schema.String),
}) {}

// ─── S5: bisect ──────────────────────────────────────────────────────────────────

/** A bisect mark verb (REQ-P5-BS-003). Custom terms are out of scope. */
export const BisectMark = Schema.Literals(['good', 'bad', 'skip']);
export type BisectMark = typeof BisectMark.Type;

/**
 * The bisect session state — DATA, not error codes: `concluded` (first-bad found) and
 * `unbisectable` (skips can't isolate) are non-error outcomes carried here (D18).
 */
export const BisectState = Schema.Literals([
    'inactive',
    'bisecting',
    'concluded',
    'unbisectable',
]);
export type BisectState = typeof BisectState.Type;

/**
 * Machine-derived bisect status (REQ-P5-BS-002/004). `current`/`firstBad` reuse
 * {@link CommitSummary} (no new commit schema). `revisionsRemaining`/`stepsRemaining` are
 * git's reported estimates; `candidates` is the ambiguous remaining set when
 * `unbisectable`; `startPoint` is the original HEAD restored on reset.
 */
export class BisectStatus extends Schema.Class<BisectStatus>('BisectStatus')({
    state: BisectState,
    current: Schema.optional(CommitSummary),
    badTerm: Schema.String,
    goodTerm: Schema.String,
    revisionsRemaining: Schema.optional(Schema.Number),
    stepsRemaining: Schema.optional(Schema.Number),
    firstBad: Schema.optional(CommitSummary),
    candidates: Schema.optional(Schema.Array(Oid)),
    startPoint: Schema.optional(Schema.String),
}) {}

// ─── S6: submodules ────────────────────────────────────────────────────────────

/**
 * A submodule's working state (REQ-P5-SM-001), machine-derived from `git submodule
 * status`'s leading prefix crossed with the index gitlink: `upToDate` (` `),
 * `uninitialized` (`-`), `outOfSync` (`+`, checked-out ≠ recorded), `conflicted`
 * (`U` / a merge-conflicted index entry with no stage-0 gitlink).
 */
export const SubmoduleStatus = Schema.Literals([
    'uninitialized',
    'upToDate',
    'outOfSync',
    'conflicted',
]);
export type SubmoduleStatus = typeof SubmoduleStatus.Type;

/**
 * One submodule (REQ-P5-SM-001). `recordedOid` is the superproject's stage-0 gitlink
 * (mode `160000`) — ABSENT for a `conflicted` entry, which carries only stages 1/2/3
 * (base/ours/theirs) and no stage-0 gitlink (D18). `checkedOutOid` is the actually
 * checked-out commit from `submodule status`, absent when `uninitialized`. `name`/`url`/
 * `branch` come from `.gitmodules`; `absPath` is the host-resolved working path the
 * "Open" action reuses via `RepoOpen`.
 */
export class SubmoduleInfo extends Schema.Class<SubmoduleInfo>('SubmoduleInfo')(
    {
        path: Schema.String,
        name: Schema.optional(Schema.String),
        absPath: Schema.String,
        recordedOid: Schema.optional(Oid),
        checkedOutOid: Schema.optional(Oid),
        status: SubmoduleStatus,
        describe: Schema.optional(Schema.String),
        url: Schema.optional(Schema.String),
        branch: Schema.optional(Schema.String),
    },
) {}

// ─── S7: settings & git config ─────────────────────────────────────────────────

/**
 * A git config scope as reported by `--show-scope` (REQ-P5-CFG-001) — the READ side,
 * so all five of git's scopes appear: `system`/`global`/`local`/`worktree`, plus
 * `command` for `-c key=value` overrides (which cbranch's config reads deliberately
 * suppress via `read:false`, but the parser still tolerates).
 */
export const ConfigScope = Schema.Literals([
    'system',
    'global',
    'local',
    'worktree',
    'command',
]);
export type ConfigScope = typeof ConfigScope.Type;

/**
 * The WRITE side (REQ-P5-CFG-002): only `global` and `local` are writable in v1 —
 * `system` is read-only in the picker AND refused by the engine; `worktree` is
 * deferred. A narrower literal so an unwritable scope can never reach a write method.
 */
export const WritableScope = Schema.Literals(['global', 'local']);
export type WritableScope = typeof WritableScope.Type;

/**
 * The app theme preference (REQ-P5-CFG-006) — an APP setting (host `config.json`),
 * NEVER written into git config (REQ-P5-CFG-005). Mirrors the UI `theme.ts` `ThemePref`
 * and the host `Config.theme` verbatim.
 */
export const ThemePref = Schema.Literals(['light', 'dark', 'system']);
export type ThemePref = typeof ThemePref.Type;

/**
 * One on-disk git config entry (REQ-P5-CFG-001) — one row per stored value, so a
 * multi-valued key yields multiple entries; the effective value is resolved client-side
 * by scope precedence. `origin` is git's `--show-origin` file path (DISPLAY).
 */
export class GitConfigEntry extends Schema.Class<GitConfigEntry>(
    'GitConfigEntry',
)({
    key: Schema.String,
    value: Schema.String,
    scope: ConfigScope,
    origin: Schema.String,
}) {}

/**
 * A single-key config read (REQ-P5-CFG-003). `present:false` is DATA (git exit 1 — the
 * key is unset), not an error. `scope` is set only on a SCOPED read (`--get` at a given
 * scope); on an effective/merged read it is absent. `value` is absent when `!present`.
 */
export class GitConfigValue extends Schema.Class<GitConfigValue>(
    'GitConfigValue',
)({
    key: Schema.String,
    scope: Schema.optional(ConfigScope),
    present: Schema.Boolean,
    value: Schema.optional(Schema.String),
}) {}

/**
 * One app-level keybinding (REQ-P5-CFG-006) — `commandId` is a menu-model id, `chord`
 * the bound key chord. The wire form is an array; the host stores it as a native
 * `Record<commandId, chord>` (user OVERRIDES only; defaults live client-side).
 */
export class KeyBinding extends Schema.Class<KeyBinding>('KeyBinding')({
    commandId: Schema.String,
    chord: Schema.String,
}) {}

/**
 * cbranch's own app settings (REQ-P5-CFG-006), persisted to the host `config.json`,
 * NEVER to git config (REQ-P5-CFG-005). `keybindings` carries user overrides only.
 */
export class AppSettings extends Schema.Class<AppSettings>('AppSettings')({
    theme: ThemePref,
    locale: Schema.String,
    keybindings: Schema.Array(KeyBinding),
}) {}

// ─── S8: interactive rebase ──────────────────────────────────────────────────────

/**
 * A todo-row action (REQ-P5-IR-003). Exactly one per row; the default is `pick`.
 * `drop` omits the commit from the replay; `reword`/`squash` carry a UI-authored
 * message (never an interactive editor); `fixup` discards the commit's own message.
 */
export const RebaseAction = Schema.Literals([
    'pick',
    'reword',
    'edit',
    'squash',
    'fixup',
    'drop',
]);
export type RebaseAction = typeof RebaseAction.Type;

/**
 * Why an in-progress rebase has stopped (REQ-P5-IR-009) — DATA totalized from machine
 * state, never localized stderr: `conflict` (unmerged index entries), `edit` (an `edit`
 * action paused), `execFailed` (the stopped `done` step is a failed `exec`-amend — steer
 * to Abort, not a plain Continue that would skip the amend), `none` (no rebase in
 * progress, OR a conflict-free resumable pause such as a `break` row or an apply-backend
 * stop, which the UI resumes with a plain Continue/Skip).
 */
export const RebaseStopReason = Schema.Literals([
    'none',
    'conflict',
    'edit',
    'execFailed',
]);
export type RebaseStopReason = typeof RebaseStopReason.Type;

/**
 * One commit in the rebase range as shown in the todo editor (REQ-P5-IR-002), oldest
 * first. Adds `body` over {@link CommitSummary} so the editor can seed a `squash`
 * default message from the concatenated bodies; `subject`/author identify the row.
 */
export class RebaseTodoCommit extends Schema.Class<RebaseTodoCommit>(
    'RebaseTodoCommit',
)({
    oid: Oid,
    authorName: Schema.String,
    authorEmail: Schema.String,
    authorDate: Schema.String,
    subject: Schema.String,
    body: Schema.String,
}) {}

/**
 * The computed rebase range (REQ-P5-IR-001/002): the commits in `<upstream>..HEAD`
 * (optionally replayed `--onto` a different base), oldest-first. `commits:[]` means an
 * empty range (nothing to rebase). DISPLAY input to the todo editor; not an operation.
 */
export class RebasePlan extends Schema.Class<RebasePlan>('RebasePlan')({
    upstream: Schema.String,
    onto: Schema.optional(Schema.String),
    commits: Schema.Array(RebaseTodoCommit),
}) {}

/**
 * One authored todo step (REQ-P5-IR-003/004) — the rows in the user's chosen replay
 * order. `message` carries the non-empty `reword` text or the combined `squash` message
 * (validated non-empty in-engine before the todo is written; never `--allow-empty-message`).
 */
export class RebaseStep extends Schema.Class<RebaseStep>('RebaseStep')({
    oid: Oid,
    action: RebaseAction,
    message: Schema.optional(Schema.String),
}) {}

/**
 * Machine-derived in-progress rebase status (REQ-P5-IR-009/011), backend-aware over
 * `rebase-merge/` (cbranch's `-i` merge backend) and `rebase-apply/` (an external
 * apply-backend rebase). `progress` reuses {@link OperationProgress} (step X of Y, see
 * D18) and is absent when no rebase is in progress; `stopReason` totalizes the stop;
 * `detail` carries the failing command on `execFailed`; `onto`/`headName` are the
 * replay target and the branch being rebased.
 */
export class RebaseStatus extends Schema.Class<RebaseStatus>('RebaseStatus')({
    inProgress: Schema.Boolean,
    stopReason: RebaseStopReason,
    progress: Schema.optional(OperationProgress),
    detail: Schema.optional(Schema.String),
    onto: Schema.optional(Schema.String),
    headName: Schema.optional(Schema.String),
}) {}
