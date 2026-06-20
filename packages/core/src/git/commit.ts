// Full commit object — `commit.detail` (docs/spec/05 §2.5; DM-010/011; DECISIONS D7).
//
// Returns the structured commit: author/committer {@link Signature}s (raw epoch +
// committed tz offset, NOT host-local — RPC-008), the split + raw message, optional
// encoding, tree, ordered parents, and aggregate stats. The scalar fields come from a
// single `git show -s --format=...` with `\x1f` separators; the multi-line body/raw
// message are read in their own `git show` calls (so an `\x1f` can never appear inside
// them); stats come from a `--numstat` diff against the first parent (empty tree for a
// root commit, `--root`).

import {
  type CommitDetail as CommitDetailType,
  type GitError,
  type Oid,
} from "@cbranch/rpc-contract";
import {
  CommitDetail,
  Oid as OidBrand,
  Signature,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { parseNumstat } from "./diff";
import { assertNoLeadingDash, decodeUtf8, runGitOk } from "./run-git";

const FS = "\x1f";

/** Scalar `git show -s` format: oid, parents, tree, author/committer identity + dates, encoding, subject. */
const DETAIL_FORMAT = [
  "%H", // 0 oid
  "%P", // 1 parents
  "%T", // 2 tree
  "%an", // 3 author name
  "%ae", // 4 author email
  "%at", // 5 author epoch seconds
  "%aI", // 6 author ISO (for tz offset)
  "%cn", // 7 committer name
  "%ce", // 8 committer email
  "%ct", // 9 committer epoch seconds
  "%cI", // 10 committer ISO (for tz offset)
  "%e", // 11 encoding (empty when absent)
  "%s", // 12 subject (single line)
].join(FS);

/**
 * Derive the committed tz offset (minutes east of UTC) from a strict-ISO git date —
 * `…Z` ⇒ 0, `…±HH:MM` ⇒ signed minutes. The instant itself is carried by `%at`/`%ct`.
 */
export const parseTzOffsetMinutes = (iso: string): number => {
  if (iso.endsWith("Z")) return 0;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso);
  if (m === null) return 0;
  const magnitude = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -magnitude : magnitude;
};

/**
 * Strip trailing newlines: git's `%b`/`%B` carry the message's own trailing newline
 * plus the terminator `git show --format` appends; neither is meaningful for display.
 */
const stripTrailingNewline = (s: string): string => s.replace(/\n+$/, "");

/** Aggregate `filesChanged/additions/deletions` for a commit (binary files add 0). */
const aggregateStats = (
  numstat: ReadonlyArray<{
    additions: number | null;
    deletions: number | null;
  }>,
): { filesChanged: number; additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const entry of numstat) {
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
  }
  return { filesChanged: numstat.length, additions, deletions };
};

/** Read the full {@link CommitDetail} for `oid` against `cwd`. */
export const commitDetail = (
  cwd: string,
  oid: Oid,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<CommitDetailType, GitError> =>
  Effect.gen(function* () {
    const rev = yield* assertNoLeadingDash(oid, "commit id");

    const scalars = yield* runGitOk({
      cwd,
      args: ["show", "-s", `--format=${DETAIL_FORMAT}`, rev],
      env,
    });
    const fields = stripTrailingNewline(decodeUtf8(scalars.stdout)).split(FS);
    const [
      fullOid,
      parentsRaw,
      tree,
      authorName,
      authorEmail,
      authorEpoch,
      authorIso,
      committerName,
      committerEmail,
      committerEpoch,
      committerIso,
      encoding,
      subject,
    ] = fields as string[];

    // Body + raw message are multi-line; read each on its own so no separator collides.
    const rawMessage = yield* runGitOk({
      cwd,
      args: ["show", "-s", "--format=%B", rev],
      env,
    });
    const bodyOut = yield* runGitOk({
      cwd,
      args: ["show", "-s", "--format=%b", rev],
      env,
    });

    // Stats vs first parent; `--root` makes a root commit diff against the empty tree.
    const numstatOut = yield* runGitOk({
      cwd,
      args: [
        "diff-tree",
        "-r",
        "-z",
        "--no-commit-id",
        "--numstat",
        "--root",
        rev,
      ],
      env,
    });
    const stats = aggregateStats(parseNumstat(numstatOut.stdout));

    const parents =
      (parentsRaw ?? "") === ""
        ? []
        : (parentsRaw as string).split(" ").filter((p) => p !== "");

    return new CommitDetail({
      oid: OidBrand.make(fullOid as string),
      parents: parents.map((p) => OidBrand.make(p)),
      tree: OidBrand.make(tree as string),
      author: new Signature({
        name: authorName as string,
        email: authorEmail as string,
        when: {
          epochSeconds: Number(authorEpoch),
          tzOffsetMinutes: parseTzOffsetMinutes(authorIso as string),
        },
      }),
      committer: new Signature({
        name: committerName as string,
        email: committerEmail as string,
        when: {
          epochSeconds: Number(committerEpoch),
          tzOffsetMinutes: parseTzOffsetMinutes(committerIso as string),
        },
      }),
      subject: subject ?? "",
      body: stripTrailingNewline(decodeUtf8(bodyOut.stdout)),
      messageRaw: stripTrailingNewline(decodeUtf8(rawMessage.stdout)),
      encoding:
        encoding === undefined || encoding === "" ? undefined : encoding,
      stats,
    });
  });
