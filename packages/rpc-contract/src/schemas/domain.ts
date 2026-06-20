// Authored P1 success Schemas (docs/spec/04-domain-model.md + 14-rpc-contract.md;
// DECISIONS D7 hands these off to the implementer to derive from the 04 + 14
// conventions). All are JSON-serializable with no `undefined`-only distinctions
// (DM-003): optional fields are present-with-value or absent. Each named record is a
// `Schema.Class` (matching the 14 §5 convention "author the rest to match"), so the
// class name doubles as the exported wire type.

import { Schema } from "effect";

import { Oid, RepoId } from "./primitives";

/**
 * Authorship/commit signature (DM-002). The instant is preserved as the raw
 * `epochSeconds` plus the committed `tzOffsetMinutes` — NOT converted to host local
 * time, and not a JS `Date` (RPC-008).
 */
export class Signature extends Schema.Class<Signature>("Signature")({
  name: Schema.String,
  email: Schema.String,
  when: Schema.Struct({
    epochSeconds: Schema.Number,
    tzOffsetMinutes: Schema.Number,
  }),
}) {}

/**
 * Per-file change classification, shared by working-tree status and diffs
 * (DM-051, VERBATIM members).
 */
export const ChangeCode = Schema.Literals([
  "unmodified",
  "modified",
  "added",
  "deleted",
  "renamed",
  "copied",
  "typeChanged",
  "updatedButUnmerged",
  "untracked",
  "ignored",
]);
export type ChangeCode = typeof ChangeCode.Type;

/**
 * A LIGHT log row (`log.stream`, 14 §5). Cheap to stream at 100k commits; the full
 * body/stats live on {@link CommitDetail}. Dates are the raw git date strings
 * (`authorDate`/`committerDate`), not the structured {@link Signature} instant.
 */
export class CommitSummary extends Schema.Class<CommitSummary>("CommitSummary")(
  {
    oid: Oid,
    parents: Schema.Array(Oid),
    authorName: Schema.String,
    authorEmail: Schema.String,
    authorDate: Schema.String,
    committerDate: Schema.String,
    subject: Schema.String,
    refs: Schema.Array(Schema.String),
  },
) {}

/**
 * The full commit (`commit.detail`, DM-010/011 + DECISIONS D7): structured
 * signatures, raw + split message, and aggregate stats.
 */
export class CommitDetail extends Schema.Class<CommitDetail>("CommitDetail")({
  oid: Oid,
  parents: Schema.Array(Oid),
  tree: Oid,
  author: Signature,
  committer: Signature,
  subject: Schema.String,
  body: Schema.String,
  messageRaw: Schema.String,
  encoding: Schema.optional(Schema.String),
  stats: Schema.Struct({
    filesChanged: Schema.Number,
    additions: Schema.Number,
    deletions: Schema.Number,
  }),
}) {}

/**
 * Aggregate repository snapshot read on open and after invalidation
 * (`repo.state`, DM-070 + 14 §8; field is `inProgress` per 14 §8, keeping the
 * `"none"` member from DM-070). `inProgress` is derived from git-dir markers
 * (MERGE_HEAD → merge, CHERRY_PICK_HEAD → cherryPick, REVERT_HEAD → revert,
 * rebase-merge//rebase-apply/ → rebase, BISECT_LOG → bisect, applypatch → am).
 */
export class RepoState extends Schema.Class<RepoState>("RepoState")({
  headOid: Schema.optional(Oid),
  currentBranch: Schema.optional(Schema.String),
  isDetached: Schema.Boolean,
  inProgress: Schema.Literals([
    "none",
    "merge",
    "rebase",
    "cherryPick",
    "revert",
    "bisect",
    "am",
  ]),
  isBare: Schema.Boolean,
  isEmpty: Schema.Boolean,
  repoRoot: Schema.String,
  gitDir: Schema.String,
  defaultBranch: Schema.optional(Schema.String),
}) {}

/**
 * The handle returned by `repo.open` (DECISIONS D7). `root` is the resolved
 * top-level working path; `commonDir` is the shared common git dir whose hash backs
 * {@link RepoId} (so sibling worktrees collapse to one repo).
 */
export class RepoHandle extends Schema.Class<RepoHandle>("RepoHandle")({
  repoId: RepoId,
  root: Schema.String,
  gitDir: Schema.String,
  commonDir: Schema.String,
  state: RepoState,
}) {}

/**
 * A recent-repos list entry (`repo.recentList`, NF-CFG-7 / DECISIONS D7). The list
 * is keyed by the resolved top-level working `path`.
 */
export class RecentRepo extends Schema.Class<RecentRepo>("RecentRepo")({
  path: Schema.String,
  name: Schema.String,
  repoId: RepoId,
  lastOpenedAt: Schema.Number,
}) {}

/**
 * A single addressable diff line (DM-062). `content` excludes the leading
 * +/-/space marker; `oldLineNo`/`newLineNo` are present per the line's side.
 */
export class DiffLine extends Schema.Class<DiffLine>("DiffLine")({
  kind: Schema.Literals(["context", "add", "delete", "noNewlineAtEof"]),
  content: Schema.String,
  oldLineNo: Schema.optional(Schema.Number),
  newLineNo: Schema.optional(Schema.Number),
}) {}

/**
 * A diff hunk (DM-061): the `@@ … @@` header, the four span numbers, and its lines.
 */
export class Hunk extends Schema.Class<Hunk>("Hunk")({
  header: Schema.String,
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
  lines: Schema.Array(DiffLine),
}) {}

/**
 * A per-file diff (`commit.diff` / `diff.workingFile`, DM-060 + DECISIONS D7).
 * For a binary file, `hunks` is empty; `additions`/`deletions` are `null` when
 * git's numstat reports `-` (hence `Schema.NullOr`).
 */
export class DiffFile extends Schema.Class<DiffFile>("DiffFile")({
  oldPath: Schema.String,
  newPath: Schema.String,
  status: ChangeCode,
  isBinary: Schema.Boolean,
  oldMode: Schema.optional(Schema.String),
  newMode: Schema.optional(Schema.String),
  oldOid: Schema.optional(Oid),
  newOid: Schema.optional(Oid),
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
  hunks: Schema.Array(Hunk),
}) {}

/**
 * Inline file content at a revision (`file.contentAtRev` small case, DECISIONS D7).
 * Binary content is carried as `base64` (never a lossy decoded string — ENC-003).
 */
export class FileContent extends Schema.Class<FileContent>("FileContent")({
  path: Schema.String,
  oid: Schema.optional(Oid),
  size: Schema.Number,
  isBinary: Schema.Boolean,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
}) {}

/**
 * A short-lived, perimeter-protected download pointer for content over the inline
 * size cap (NF-LIMIT-3 = 10 MB; 14 §3.7 / DECISIONS D4) — never bytes/base64.
 */
export class DownloadDescriptor extends Schema.Class<DownloadDescriptor>(
  "DownloadDescriptor",
)({
  url: Schema.String,
  size: Schema.Number,
  contentType: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
}) {}

/**
 * The `file.contentAtRev` result: inline {@link FileContent} (small) OR a
 * {@link DownloadDescriptor} (large → HTTP side-channel). The two are mutually
 * exclusive on their required fields (`content`/`encoding` vs `url`), so the union
 * decodes unambiguously.
 */
export const FileContentResult = Schema.Union([
  FileContent,
  DownloadDescriptor,
]);
export type FileContentResult = typeof FileContentResult.Type;
