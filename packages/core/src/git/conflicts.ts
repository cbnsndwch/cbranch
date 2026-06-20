// Conflict enumeration + the three sides for a path (docs/spec/08 + 11; DECISIONS
// D17). Reads only — no lock. The authoritative source for which paths conflict and
// how is `git ls-files -u -z`: the set of present stages (1 = base, 2 = ours,
// 3 = theirs) uniquely determines all seven conflict classes, gives NUL-safe paths,
// and carries the per-stage mode (gitlink 160000 → submodule) and blob OID (read by
// OID through the cat-file pool for the binary sniff — never `:n:PATH`, which would
// embed a possibly-newline-bearing path into the pool's line protocol). The
// in-progress operation kind is detected by the caller (git-dir markers) and passed
// in, keeping this module free of a `repo/` import.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ConflictClassification,
  ConflictFile,
  ConflictListing,
  type GitError,
  type OperationKind,
  OperationProgress,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { type CatFilePool } from "./cat-file-pool";
import { decodeUtf8, runGitOk } from "./run-git";

const GITLINK_MODE = "160000";
// Sniff window: a NUL within the first chunk of a blob marks it binary (matches
// git's own "is this a binary file" heuristic closely enough for the editor gate).
const BINARY_SNIFF_BYTES = 8000;

/** Per-path unmerged stages parsed from `git ls-files -u -z`. */
interface UnmergedStage {
  readonly mode: string;
  readonly oid: string;
}
interface UnmergedEntry {
  base?: UnmergedStage;
  ours?: UnmergedStage;
  theirs?: UnmergedStage;
}

/**
 * Parse `git ls-files -u -z`. Each NUL-terminated record is
 * `<mode> <oid> <stage>\t<path>`; stage 1/2/3 maps to base/ours/theirs. Preserves
 * first-seen path order so the conflict list is stable.
 */
export const parseLsFilesUnmerged = (
  buf: Buffer,
): Map<string, UnmergedEntry> => {
  const out = new Map<string, UnmergedEntry>();
  for (const record of decodeUtf8(buf).split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const mode = meta[0];
    const oid = meta[1];
    const stage = meta[2];
    if (mode === undefined || oid === undefined || stage === undefined)
      continue;
    const entry = out.get(path) ?? {};
    if (stage === "1") entry.base = { mode, oid };
    else if (stage === "2") entry.ours = { mode, oid };
    else if (stage === "3") entry.theirs = { mode, oid };
    out.set(path, entry);
  }
  return out;
};

/** Derive the conflict class from which stages are present (REQ-CN-002). */
export const classifyConflict = (
  hasBase: boolean,
  hasOurs: boolean,
  hasTheirs: boolean,
): ConflictClassification => {
  if (hasBase && hasOurs && hasTheirs) return "bothModified";
  if (!hasBase && hasOurs && hasTheirs) return "bothAdded";
  if (hasBase && !hasOurs && !hasTheirs) return "bothDeleted";
  if (!hasBase && hasOurs && !hasTheirs) return "addedByUs";
  if (!hasBase && !hasOurs && hasTheirs) return "addedByThem";
  if (hasBase && hasOurs && !hasTheirs) return "deletedByThem";
  // hasBase && !hasOurs && hasTheirs
  return "deletedByUs";
};

/** Read a small integer from a git-dir state file, or `undefined`. */
const readNum = (...segments: string[]): number | undefined => {
  try {
    const n = parseInt(readFileSync(join(...segments), "utf8").trim(), 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Best-effort progress for a rebase ("commit X of Y") from the machine-readable
 * counters git keeps in the git dir. Cherry-pick / revert sequencer progress is
 * deferred to S5 (no single "done" counter exists post-hoc).
 */
const readProgress = (
  gitDir: string,
  operation: OperationKind,
): OperationProgress | undefined => {
  if (operation !== "rebase") return undefined;
  const current = readNum(gitDir, "rebase-merge", "msgnum");
  const total = readNum(gitDir, "rebase-merge", "end");
  if (current !== undefined && total !== undefined)
    return new OperationProgress({ current, total });
  const next = readNum(gitDir, "rebase-apply", "next");
  const last = readNum(gitDir, "rebase-apply", "last");
  if (next !== undefined && last !== undefined)
    return new OperationProgress({ current: next, total: last });
  return undefined;
};

/** True when a present stage blob contains a NUL within the sniff window. */
const sniffBinary = (
  pool: CatFilePool,
  oid: string,
): Effect.Effect<boolean, GitError> =>
  Effect.map(pool.readObject(oid), (obj) => {
    if (obj === null) return false;
    const end = Math.min(obj.data.length, BINARY_SNIFF_BYTES);
    return obj.data.subarray(0, end).includes(0);
  });

/**
 * conflict.list — the in-progress operation summary plus every conflicted path with
 * its classification, submodule/binary flags, and stage presence. READ, no lock.
 */
export const conflictList = (
  cwd: string,
  gitDir: string,
  operation: OperationKind,
  pool: CatFilePool,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<ConflictListing, GitError> =>
  Effect.gen(function* () {
    const unmerged = yield* Effect.map(
      runGitOk({ cwd, args: ["ls-files", "-u", "-z"], env }),
      (r) => parseLsFilesUnmerged(r.stdout),
    );

    const conflicted: ConflictFile[] = [];
    for (const [path, entry] of unmerged) {
      const hasBase = entry.base !== undefined;
      const hasOurs = entry.ours !== undefined;
      const hasTheirs = entry.theirs !== undefined;
      const present = entry.ours ?? entry.theirs ?? entry.base;
      const isSubmodule =
        entry.base?.mode === GITLINK_MODE ||
        entry.ours?.mode === GITLINK_MODE ||
        entry.theirs?.mode === GITLINK_MODE;
      const isBinary =
        !isSubmodule && present !== undefined
          ? yield* sniffBinary(pool, present.oid)
          : false;
      conflicted.push(
        new ConflictFile({
          path,
          classification: classifyConflict(hasBase, hasOurs, hasTheirs),
          hasBase,
          hasOurs,
          hasTheirs,
          isBinary,
          isSubmodule,
        }),
      );
    }

    const conflictedCount = conflicted.length;
    const isResumable =
      operation === "merge" ||
      operation === "rebase" ||
      operation === "cherryPick" ||
      operation === "revert";

    return new ConflictListing({
      operation,
      progress: readProgress(gitDir, operation),
      conflicted,
      conflictedCount,
      canContinue: isResumable && conflictedCount === 0,
      canSkip: operation === "rebase",
    });
  });
