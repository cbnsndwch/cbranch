// HTTP side-channel for large blobs (docs/spec/14 §3.7; DECISIONS D4; NF-LIMIT-3,
// NF-SEC-5/6/11).
//
// `file.contentAtRev` returns a `DownloadDescriptor` (instead of inlining) when a
// blob exceeds the 10 MB RPC cap; the descriptor points the client at
// `GET /sidechannel/blob?repoId=&rev=&path=`, served here. The bytes are read THROUGH
// the `GitEngine`'s `cat-file` pool (REQ-ARCH-010 — the web-server never spawns git
// itself), so the same object-read path and `repoId` resolution back the RPC and the
// download. The `Origin`/`Host` perimeter check runs ahead of this route as global
// middleware (NF-SEC-3), so the handler only validates its inputs.
//
// Containment (NF-SEC-5/6): the `<rev>:<path>` spec is handed to the `cat-file
// --batch` process, whose protocol is newline-delimited — an unescaped LF/CR/NUL in
// `rev`/`path` could smuggle a second batch request, so both are rejected, as are
// absolute paths and `..` traversal segments.

import { basename, extname } from "node:path";

import { GitEngine } from "@cbranch/core";
import { RepoId } from "@cbranch/rpc-contract";
import { Http } from "@cbranch/rpc-contract/effect-rpc-adapter";
import { Effect } from "effect";

export const SIDE_CHANNEL_PATH = "/sidechannel/blob";

// A backslash, derived without a backslash escape literal (keeps this source free of
// fragile escape sequences). Used to normalize Windows-style separators to "/".
const BACKSLASH = String.fromCharCode(92);

/** True if the value contains a character that could corrupt the `cat-file` batch line. */
const hasUnsafeChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c === 0 || c === 10 || c === 13) return true; // NUL, LF, CR
  }
  return false;
};

/**
 * Validate a revision token (oid / ref / `<rev>`): non-empty and free of the control
 * characters that could inject an extra `cat-file` batch request (NF-SEC-6).
 */
export const safeRev = (rev: string): string | null => (rev !== "" && !hasUnsafeChars(rev) ? rev : null);

/**
 * Contain a repo-relative blob path (NF-SEC-5): reject empty, absolute, control-char,
 * and any `.`/`..` traversal segment. Returns the normalized forward-slash path git
 * expects in `<rev>:<path>`, or `null` if unsafe.
 */
export const containBlobPath = (raw: string): string | null => {
  if (raw === "" || hasUnsafeChars(raw)) return null;
  let normalized = raw.split(BACKSLASH).join("/");
  while (normalized.startsWith("/")) normalized = normalized.slice(1);
  if (normalized === "") return null;
  const segments = normalized.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) return null;
  return segments.join("/");
};

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/**
 * A conservative content type for a downloaded blob. Unknown types fall back to
 * `application/octet-stream`; together with `Content-Disposition: attachment` this
 * prevents user content being executed as script in the SPA origin (NF-SEC-11).
 */
export const guessContentType = (path: string): string =>
  MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";

/**
 * The `GET /sidechannel/blob` route layer. Streams the bytes of `<rev>:<path>` from
 * the repo's object database via the engine's `cat-file` pool. Maps a missing object
 * or any `GitError` to `404` (no detail leakage), bad inputs to `400`.
 */
export const sideChannelRoute = Http.HttpRouter.add("GET", SIDE_CHANNEL_PATH, (request) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost");
    const repoIdRaw = url.searchParams.get("repoId");
    const revRaw = url.searchParams.get("rev");
    const pathRaw = url.searchParams.get("path");
    if (repoIdRaw === null || revRaw === null || pathRaw === null) {
      return Http.HttpServerResponse.text("missing repoId/rev/path", { status: 400 });
    }
    const rev = safeRev(revRaw);
    const path = containBlobPath(pathRaw);
    if (rev === null || path === null) {
      return Http.HttpServerResponse.text("invalid rev/path", { status: 400 });
    }

    const engine = yield* GitEngine;
    const bytes = yield* engine.readObject(RepoId.make(repoIdRaw), `${rev}:${path}`).pipe(
      Effect.map((obj) => obj?.data ?? null),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (bytes === null) {
      return Http.HttpServerResponse.text("not found", { status: 404 });
    }
    return Http.HttpServerResponse.uint8Array(bytes, {
      status: 200,
      contentType: guessContentType(path),
      headers: {
        "content-disposition": `attachment; filename="${basename(path)}"`,
        "cache-control": "no-store",
      },
    });
  }),
);
