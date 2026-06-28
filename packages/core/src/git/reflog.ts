// Reflog viewer (docs/spec/09 REQ-P5-RL-001..006; DECISIONS D18).
//
// ONE read method; the recovery writes (branch-from-entry, reset-to-entry) reuse the
// shipped `BranchCreate`/`ResetTo` with the entry's RESOLVED oid (never `HEAD@{n}`), so a
// gc'd/expired entry surfaces as a plain `gitFailed` + list refetch rather than a silent
// mis-target. Listing uses the machine form `git log -g -z --format=%H\x1f%gd\x1f%gs`
// (not the localized `git reflog show` text); `action` is the `%gs` label before the FIRST
// `:` (kept open — reflog tokens drift). Skip-based pagination reuses the history cursor
// codec. Lockless (READ); a ref with no reflog / unborn HEAD is the empty page, not an error.

import {
  type GitError,
  Oid,
  ReflogEntry,
  ReflogPage,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { cappedLimit, decodeLogCursor, encodeLogCursor } from "./history";
import { assertNoLeadingDash, decodeUtf8, isHexOid, runGit } from "./run-git";

const FS = "\x1f";

/** `git log -g -z --format=…` argv for a reflog window. Pure (testable). */
export const reflogArgs = (
  ref: string,
  cap: number,
  skip: number,
): ReadonlyArray<string> => [
  "log",
  "-g",
  "-z",
  `--format=%H${FS}%gd${FS}%gs`,
  `--max-count=${cap}`,
  ...(skip > 0 ? [`--skip=${skip}`] : []),
  ref,
];

/** Parse the NUL-separated `%H\x1f%gd\x1f%gs` records into entries (bad records skipped). */
export const parseReflog = (stdout: string): ReadonlyArray<ReflogEntry> => {
  const entries: ReflogEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const fields = record.split(FS);
    if (fields.length < 3) continue;
    const oidRaw = fields[0]!.trim();
    if (!isHexOid(oidRaw)) continue;
    const selector = fields[1]!;
    const gs = fields[2]!;
    const colon = gs.indexOf(":");
    const action = (colon >= 0 ? gs.slice(0, colon) : gs).trim();
    const message = colon >= 0 ? gs.slice(colon + 1).trim() : "";
    entries.push(
      new ReflogEntry({ selector, oid: Oid.make(oidRaw), action, message }),
    );
  }
  return entries;
};

export const reflogList = (
  cwd: string,
  limit: number,
  ref?: string,
  cursor?: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<ReflogPage, GitError> =>
  Effect.gen(function* () {
    const safeRef = yield* assertNoLeadingDash(ref ?? "HEAD", "reflog ref");
    const cap = cappedLimit(limit);
    const skip = decodeLogCursor(cursor)?.skip ?? 0;
    const result = yield* runGit({
      cwd,
      args: reflogArgs(safeRef, cap, skip),
      env,
    });
    // No reflog / unborn HEAD / bad ref → the empty page (a machine outcome, not an error).
    if (result.exitCode !== 0) return new ReflogPage({ entries: [] });
    const entries = parseReflog(decodeUtf8(result.stdout));
    // A continuation cursor only when the window filled (more may remain).
    const nextCursor =
      entries.length === cap && entries.length > 0
        ? encodeLogCursor(
            skip + entries.length,
            entries[entries.length - 1]!.oid,
          )
        : undefined;
    return new ReflogPage({ entries, nextCursor });
  });
