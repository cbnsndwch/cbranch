// P2 working-tree (stage & commit) success/payload Schemas (docs/spec/06-phase2;
// 14 §5/§7). Authored to match the P1 domain.ts convention: each named record is a
// `Schema.Class` (the class name doubles as the exported wire type), optionals are
// present-with-value or absent (DM-003), and the shared scalars (`RepoId`, `Oid`,
// `ChangeCode`) are reused from their existing homes rather than redefined.

import { Schema } from "effect";

import { ChangeCode } from "./domain";
import { Oid, RepoId } from "./primitives";

/**
 * A single working-tree status row (porcelain v2). `staged`/`unstaged` carry the
 * per-side {@link ChangeCode} (the index↔HEAD and worktree↔index halves of an XY
 * pair); `origPath`/`similarity` are present only for renames/copies; the `*Mode`
 * fields are the octal file modes git reports per side.
 */
export class StatusEntry extends Schema.Class<StatusEntry>("StatusEntry")({
  path: Schema.String,
  origPath: Schema.optional(Schema.String),
  staged: ChangeCode,
  unstaged: ChangeCode,
  isConflicted: Schema.Boolean,
  isUntracked: Schema.Boolean,
  isIgnored: Schema.Boolean,
  similarity: Schema.optional(Schema.Number),
  isSubmodule: Schema.Boolean,
  stagedMode: Schema.optional(Schema.String),
  worktreeMode: Schema.optional(Schema.String),
}) {}

/**
 * The branch header of a status read (porcelain v2 `--branch`). All fields are
 * optional: a detached or unborn HEAD has no `head`/`oid`, and a branch with no
 * upstream has no `upstream`/`ahead`/`behind`.
 */
export class StatusBranch extends Schema.Class<StatusBranch>("StatusBranch")({
  head: Schema.optional(Schema.String),
  upstream: Schema.optional(Schema.String),
  ahead: Schema.optional(Schema.Number),
  behind: Schema.optional(Schema.Number),
  oid: Schema.optional(Oid),
}) {}

/**
 * The full working-tree status snapshot (`status.get`, 14 §7). `hasConflicts` is the
 * pre-computed gate the UI uses to block committing while a merge is unresolved.
 */
export class WorkingTreeStatus extends Schema.Class<WorkingTreeStatus>(
  "WorkingTreeStatus",
)({
  entries: Schema.Array(StatusEntry),
  branch: Schema.optional(StatusBranch),
  hasConflicts: Schema.Boolean,
}) {}

/**
 * A per-hunk selection for partial staging. The four span numbers identify the hunk
 * within the file's working diff; `selectedLines` holds the indices (into the hunk's
 * line array) of the chosen +/- lines — an empty array means the WHOLE hunk.
 */
export class HunkSelection extends Schema.Class<HunkSelection>("HunkSelection")(
  {
    oldStart: Schema.Number,
    oldLines: Schema.Number,
    newStart: Schema.Number,
    newLines: Schema.Number,
    selectedLines: Schema.Array(Schema.Number),
  },
) {}

/**
 * A structured partial-stage selection for one file (DECISIONS → D15): the client
 * ships the SELECTION, never a raw patch — only the server, holding git's normalized
 * content, can slice a byte-faithful minimal patch (REQ-P2-HUNK-004, AC-10).
 */
export class PatchSelection extends Schema.Class<PatchSelection>(
  "PatchSelection",
)({
  repoId: RepoId,
  path: Schema.String,
  hunks: Schema.Array(HunkSelection),
}) {}

/**
 * The input to `commit.create` (14 §7). `sign`/`authorOverride` are optional
 * structured extras; the flags (`amend`/`signoff`/`allowEmpty`/`noVerify`) are always
 * present so the server never guesses a default. `resetAuthor` is honored only with
 * `amend` (`git commit --amend --reset-author`); absent ⇒ keep the original author.
 */
export class CommitInput extends Schema.Class<CommitInput>("CommitInput")({
  repoId: RepoId,
  subject: Schema.String,
  body: Schema.optional(Schema.String),
  amend: Schema.Boolean,
  resetAuthor: Schema.optional(Schema.Boolean),
  signoff: Schema.Boolean,
  sign: Schema.optional(
    Schema.Struct({
      format: Schema.Literals(["gpg", "ssh"]),
      keyId: Schema.optional(Schema.String),
    }),
  ),
  authorOverride: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      email: Schema.String,
    }),
  ),
  allowEmpty: Schema.Boolean,
  noVerify: Schema.Boolean,
}) {}

/**
 * The result of a successful `commit.create`: the new commit's full {@link Oid}, its
 * abbreviated form, and the committed subject line.
 */
export class CommitCreated extends Schema.Class<CommitCreated>("CommitCreated")(
  {
    oid: Oid,
    shortOid: Schema.String,
    subject: Schema.String,
  },
) {}

/**
 * A commit's message split for reuse (`commit.lastMessage`, MSG-001): `subject` +
 * `body` parsed apart, plus the verbatim `raw` text (the message editor seeds from
 * `raw` to preserve trailers/whitespace exactly).
 */
export class CommitMessage extends Schema.Class<CommitMessage>("CommitMessage")(
  {
    subject: Schema.String,
    body: Schema.String,
    raw: Schema.String,
  },
) {}
