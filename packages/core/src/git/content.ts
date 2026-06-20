// File content at a revision — `file.contentAtRev` (docs/spec/05 §2.6 / P1-DIFF-7;
// NF-LIMIT-3; ENC-003; DECISIONS D4).
//
// Reads `<rev>:<path>` through the repo's `cat-file --batch` pool. Content over the 10 MB
// inline cap is NOT inlined: it returns a {@link DownloadDescriptor} pointing at the
// relative HTTP side-channel route (the web-server serves + absolutizes it). Inline
// content is binary-classified by a NUL-byte heuristic and carried losslessly — `utf8`
// for text, `base64` for binary (never a lossy decoded string).

import { basename } from "node:path";

import {
  type FileContentResult,
  type GitError,
  type RepoId,
} from "@cbranch/rpc-contract";
import {
  DownloadDescriptor,
  FileContent,
  Oid as OidBrand,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { type CatFilePool } from "./cat-file-pool";
import { gitError } from "./errors";

/** Inline delivery cap (NF-LIMIT-3 = 10 MB); larger content goes to the side-channel. */
export const INLINE_CONTENT_CAP = 10 * 1024 * 1024;

/** Heuristic binary detection: a NUL byte in the leading window ⇒ binary (ENC-003). */
export const looksBinary = (data: Buffer): boolean => {
  const window = Math.min(data.length, 8000);
  for (let i = 0; i < window; i += 1) {
    if (data[i] === 0) return true;
  }
  return false;
};

/** Build the relative side-channel URL for over-cap blobs (DECISIONS D4). */
export const sidechannelBlobUrl = (
  repoId: RepoId,
  rev: string,
  path: string,
): string =>
  `/sidechannel/blob?repoId=${encodeURIComponent(repoId)}&rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}`;

/**
 * Resolve `<rev>:<path>` to inline {@link FileContent} or a {@link DownloadDescriptor}.
 * The metadata probe (`--batch-check`) decides inline-vs-side-channel before any bytes
 * are read, so an over-cap blob never enters memory as base64 (NF-PERF-8).
 */
export const fileContentAtRev = (
  pool: CatFilePool,
  repoId: RepoId,
  path: string,
  rev: string,
): Effect.Effect<FileContentResult, GitError> =>
  Effect.gen(function* () {
    const spec = `${rev}:${path}`;
    const info = yield* pool.objectInfo(spec);
    if (info === null) {
      return yield* Effect.fail(
        gitError("fsError", "no object exists at the requested revision/path"),
      );
    }

    if (info.size > INLINE_CONTENT_CAP) {
      return new DownloadDescriptor({
        url: sidechannelBlobUrl(repoId, rev, path),
        size: info.size,
        filename: basename(path) || undefined,
      });
    }

    const obj = yield* pool.readObject(spec);
    if (obj === null) {
      return yield* Effect.fail(
        gitError("fsError", "no object exists at the requested revision/path"),
      );
    }
    const isBinary = looksBinary(obj.data);
    return new FileContent({
      path,
      oid: OidBrand.make(info.oid),
      size: info.size,
      isBinary,
      encoding: isBinary ? "base64" : "utf8",
      content: obj.data.toString(isBinary ? "base64" : "utf8"),
    });
  });
