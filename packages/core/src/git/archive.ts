// Archive export (docs/spec/09 REQ-P5-AR-001..005; DECISIONS D18).
//
// Two halves: `archivePrepare` (an RPC) validates the tree-ish via `rev-parse --verify`
// and sanitizes the optional prefix/sub-path, then mints an `ArchiveDescriptor` pointing
// at the streamed download route; `archiveStreamGit` (route-only, consumed by
// `GET /sidechannel/archive`) runs `git archive` through the raw-byte `streamGitBytes`
// runner (the line-buffered `streamGit` is LOSSY for binary). A shared format→ext→
// contentType table keeps the descriptor filename and the route Content-Disposition from
// drifting. Lockless (read). No partial download on a bad tree-ish — the route validates
// at prepare before emitting 200.

import {
  ArchiveDescriptor,
  type ArchiveFormat,
  type GitError,
  type RepoId,
} from "@cbranch/rpc-contract";
import { Effect, Stream } from "effect";

import { gitError } from "./errors";
import { assertNoLeadingDash, runGit, streamGitBytes } from "./run-git";

const BACKSLASH = String.fromCharCode(92);

const hasControl = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
};

interface FormatSpec {
  readonly gitFormat: string;
  readonly ext: string;
  readonly contentType: string;
}

/** Shared format → git `--format` / file extension / MIME table (single source of truth). */
export const ARCHIVE_FORMATS: Readonly<Record<ArchiveFormat, FormatSpec>> = {
  zip: { gitFormat: "zip", ext: "zip", contentType: "application/zip" },
  tar: { gitFormat: "tar", ext: "tar", contentType: "application/x-tar" },
  "tar.gz": {
    gitFormat: "tar.gz",
    ext: "tar.gz",
    contentType: "application/gzip",
  },
};

/**
 * Clean an archive `--prefix`: reject control chars, an absolute (leading-`/`) path, and
 * any `.`/`..` traversal segment; normalize to forward slashes WITH a single trailing
 * `/`. Returns `null` if unsafe.
 */
export const cleanPrefix = (raw: string): string | null => {
  if (hasControl(raw)) return null;
  const normalized = raw.split(BACKSLASH).join("/");
  if (normalized.startsWith("/")) return null;
  const segments = normalized.split("/").filter((s) => s !== "");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === ".." || s === ".")) return null;
  return `${segments.join("/")}/`;
};

/**
 * Contain an archive sub-path (a tree subdirectory): reject control chars, absolute, and
 * `.`/`..` segments; normalize to a forward-slash path (no trailing `/`). `null` if unsafe.
 */
export const cleanSubPath = (raw: string): string | null => {
  if (hasControl(raw)) return null;
  const normalized = raw.split(BACKSLASH).join("/");
  if (normalized.startsWith("/")) return null;
  const segments = normalized.split("/").filter((s) => s !== "");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === ".." || s === ".")) return null;
  return segments.join("/");
};

/** A download filename safe for `Content-Disposition` (no quotes/control/`/`). */
export const archiveFileName = (
  treeish: string,
  format: ArchiveFormat,
): string => {
  const base =
    treeish
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "archive";
  return `cbranch-${base}.${ARCHIVE_FORMATS[format].ext}`;
};

/** The side-channel URL the descriptor points at (the route re-validates every param). */
export const archiveSidechannelUrl = (
  repoId: RepoId,
  treeish: string,
  format: ArchiveFormat,
  prefix?: string,
  subPath?: string,
): string => {
  const params = [
    `repoId=${encodeURIComponent(repoId)}`,
    `treeish=${encodeURIComponent(treeish)}`,
    `format=${encodeURIComponent(format)}`,
  ];
  if (prefix !== undefined && prefix !== "")
    params.push(`prefix=${encodeURIComponent(prefix)}`);
  if (subPath !== undefined && subPath !== "")
    params.push(`subPath=${encodeURIComponent(subPath)}`);
  return `/sidechannel/archive?${params.join("&")}`;
};

/** `git archive` argv from a treeish + ALREADY-cleaned prefix/sub-path. Pure (testable). */
export const archiveArgs = (
  treeish: string,
  format: ArchiveFormat,
  cleanedPrefix: string | null,
  cleanedSubPath: string | null,
): ReadonlyArray<string> => [
  "archive",
  `--format=${ARCHIVE_FORMATS[format].gitFormat}`,
  ...(cleanedPrefix !== null ? [`--prefix=${cleanedPrefix}`] : []),
  treeish,
  ...(cleanedSubPath !== null ? ["--", cleanedSubPath] : []),
];

export const archivePrepare = (
  cwd: string,
  repoId: RepoId,
  treeish: string,
  format: ArchiveFormat,
  prefix?: string,
  subPath?: string,
): Effect.Effect<ArchiveDescriptor, GitError> =>
  Effect.gen(function* () {
    yield* assertNoLeadingDash(treeish, "archive tree-ish");
    if (prefix !== undefined && prefix !== "" && cleanPrefix(prefix) === null) {
      return yield* Effect.fail(
        gitError("invalidRefName", "invalid archive prefix"),
      );
    }
    if (
      subPath !== undefined &&
      subPath !== "" &&
      cleanSubPath(subPath) === null
    ) {
      return yield* Effect.fail(
        gitError("invalidRefName", "invalid archive sub-path"),
      );
    }
    // Validate the tree-ish resolves to a commit (exit code is DATA, not an error).
    const probe = yield* runGit({
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${treeish}^{commit}`],
    });
    if (probe.exitCode !== 0) {
      return yield* Effect.fail(
        gitError("gitFailed", `not a valid tree-ish: ${treeish}`),
      );
    }
    return new ArchiveDescriptor({
      url: archiveSidechannelUrl(repoId, treeish, format, prefix, subPath),
      filename: archiveFileName(treeish, format),
      contentType: ARCHIVE_FORMATS[format].contentType,
      format,
    });
  });

export const archiveStreamGit = (
  cwd: string,
  treeish: string,
  format: ArchiveFormat,
  prefix?: string,
  subPath?: string,
): Stream.Stream<Uint8Array, GitError> => {
  const cleanedPrefix =
    prefix !== undefined && prefix !== "" ? cleanPrefix(prefix) : null;
  const cleanedSubPath =
    subPath !== undefined && subPath !== "" ? cleanSubPath(subPath) : null;
  // Defense-in-depth: reject a leading-dash tree-ish here too (it sits before `--`),
  // mirroring archivePrepare — the route validates at prepare, but the stream may be
  // reached directly.
  return Stream.unwrap(
    Effect.map(assertNoLeadingDash(treeish, "archive tree-ish"), () =>
      streamGitBytes({
        cwd,
        args: archiveArgs(treeish, format, cleanedPrefix, cleanedSubPath),
        read: false,
      }),
    ),
  );
};
