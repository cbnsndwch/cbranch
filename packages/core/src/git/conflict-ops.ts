// Conflict-resolution mutations (docs/spec/08 + 11; DECISIONS D17). Every method
// mutates the index/working tree and runs under the per-repo lock (held by the
// engine). The acting methods first re-verify the target is still unmerged, so a path
// resolved or changed outside cbranch fails safely instead of clobbering live state
// (REQ-EDGE-008). Paths flow through NUL/`--` end to end; the base side is read BY OID
// through the cat-file pool (never `:n:PATH`); the merged write is byte-faithful (no
// EOL/BOM normalization — REQ-MERGE-019 / REQ-KDIFF-057).

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ConflictResolution,
  type ContentEncoding,
  type GitError,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { type CatFilePool } from "./cat-file-pool";
import { parseLsFilesUnmerged } from "./conflicts";
import { gitError } from "./errors";
import { runGitOk } from "./run-git";

type UnmergedMap = ReturnType<typeof parseLsFilesUnmerged>;

/** Re-read unmerged stages; fail if any requested path is no longer conflicted. */
const requireUnmerged = (
  cwd: string,
  paths: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<UnmergedMap, GitError> =>
  Effect.flatMap(
    runGitOk({ cwd, args: ["ls-files", "-u", "-z", "--", ...paths], env }),
    (r) => {
      const map = parseLsFilesUnmerged(r.stdout);
      const missing = paths.filter((p) => !map.has(p));
      return missing.length > 0
        ? Effect.fail(
            gitError(
              "gitFailed",
              "path is no longer conflicted (resolved or changed outside cbranch)",
              { paths: missing },
            ),
          )
        : Effect.succeed(map);
    },
  );

const mutate = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.asVoid(runGitOk({ cwd, args, env, read: false }));

/** Byte-faithful working-tree write (no normalization), surfaced as fsError. */
const writeWorktreeFile = (
  cwd: string,
  path: string,
  bytes: Buffer,
): Effect.Effect<void, GitError> =>
  Effect.try({
    try: () => writeFileSync(join(cwd, path), bytes),
    catch: () =>
      gitError("fsError", "failed to write the working-tree file", { path }),
  });

/**
 * conflict.resolve — apply one whole-file resolution to every given path and stage
 * the result (REQ-CN-004/005, REQ-WHOLE-030/031). Bulk-capable: the server derives
 * each path's stages, so `base` reads the stage-1 blob by OID and `deleteFile` runs
 * `git rm`. Refuses if any path is no longer unmerged.
 */
export const conflictResolve = (
  cwd: string,
  paths: ReadonlyArray<string>,
  resolution: ConflictResolution,
  pool: CatFilePool,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    if (paths.length === 0) return;
    const map = yield* requireUnmerged(cwd, paths, env);
    const writable = [...paths];

    if (resolution === "ours" || resolution === "theirs") {
      const side = resolution === "ours" ? "--ours" : "--theirs";
      yield* mutate(cwd, ["checkout", side, "--", ...writable], env);
      yield* mutate(cwd, ["add", "--", ...writable], env);
      return;
    }
    if (resolution === "keepFile") {
      // The modified side is already in the working tree (modify/delete) — stage it.
      yield* mutate(cwd, ["add", "--", ...writable], env);
      return;
    }
    if (resolution === "deleteFile") {
      yield* mutate(cwd, ["rm", "--", ...writable], env);
      return;
    }
    // base: write each path's common-ancestor blob (read by OID), then stage it.
    for (const p of paths) {
      const base = map.get(p)?.base;
      if (base === undefined) {
        return yield* Effect.fail(
          gitError("gitFailed", "no common-ancestor (base) version to take", {
            path: p,
          }),
        );
      }
      const obj = yield* pool.readObject(base.oid);
      if (obj === null) {
        return yield* Effect.fail(
          gitError("gitFailed", "the base blob is unavailable", { path: p }),
        );
      }
      yield* writeWorktreeFile(cwd, p, obj.data);
      yield* mutate(cwd, ["add", "--", p], env);
    }
  });

/**
 * conflict.saveMerged — write the editor's exact Result bytes to the working tree
 * (byte-faithful) and stage the path, marking it resolved (REQ-MERGE-016).
 */
export const conflictSaveMerged = (
  cwd: string,
  path: string,
  content: string,
  encoding: ContentEncoding,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const bytes = Buffer.from(
      content,
      encoding === "base64" ? "base64" : "utf8",
    );
    yield* writeWorktreeFile(cwd, path, bytes);
    yield* mutate(cwd, ["add", "--", path], env);
  });

/** conflict.markResolved — stage the current working-tree content for each path. */
export const conflictMarkResolved = (
  cwd: string,
  paths: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  paths.length === 0 ? Effect.void : mutate(cwd, ["add", "--", ...paths], env);

/** conflict.markUnresolved — recreate the conflicted merge for each path. */
export const conflictMarkUnresolved = (
  cwd: string,
  paths: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  paths.length === 0
    ? Effect.void
    : mutate(cwd, ["checkout", "-m", "--", ...paths], env);
