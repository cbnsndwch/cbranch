// Error classification → the canonical `GitError` (docs/spec/14 §4; NF-ERR-1).
//
// Classification is DETERMINISTIC: it keys off process spawn error codes and the
// git exit status (NF-GIT-4), never off localized human stderr text (NF-GIT-3 /
// NF-ERR-1). The only thing we read out of stderr is a credential-SCRUBBED excerpt
// placed into `detail` for diagnostics (NF-SEC-9 / RPC-031); it never drives control
// flow. The closed `GitErrorCode` set is imported unchanged from the contract — this
// package never redefines it.

import { type GitErrorCode } from "@cbranch/rpc-contract";
import { GitError } from "@cbranch/rpc-contract";

/** Construct a `GitError` with a scrubbed, display-safe message. */
export const gitError = (
  code: GitErrorCode,
  message: string,
  detail?: unknown,
): GitError =>
  new GitError({
    code,
    message: scrubSecrets(message),
    detail: detail === undefined ? undefined : scrubDetail(detail),
  });

/**
 * Redact credentials embedded in remote URLs and common token shapes before any
 * text reaches a log or a user-facing message (NF-LOG-3 / NF-LOG-4 / NF-SEC-9).
 * Pattern-based and locale-independent.
 */
export const scrubSecrets = (input: string): string => {
  let out = input;
  // userinfo in URLs: scheme://user:secret@host  →  scheme://user:***@host
  out = out.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+):[^/\s@]+@/g,
    "$1:***@",
  );
  // bare token userinfo: scheme://secret@host    →  scheme://***@host
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+@/g, "$1***@");
  return out;
};

const scrubDetail = (detail: unknown): unknown =>
  typeof detail === "string" ? scrubSecrets(detail) : detail;

/**
 * Map a Node spawn/`fs` error (the `error.code` is a STABLE machine token, not a
 * localized message) to a `GitError`. `ENOENT` for the `git` binary itself is the
 * caller's concern (→ `hostGitMissing`); here a generic `ENOENT` is an `fsError`.
 */
export const classifyNodeError = (err: unknown): GitError => {
  const code = nodeErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "EACCES":
    case "EPERM":
      return gitError("permissionDenied", message, { code });
    case "ENOTDIR":
    case "ENOENT":
      return gitError("fsError", message, { code });
    case "ABORT_ERR":
      return gitError("cancelled", "operation cancelled", { code });
    default:
      return gitError("fsError", message, { code });
  }
};

/** Spawn-time failure of the `git` binary lookup itself → `hostGitMissing`. */
export const classifyGitSpawnError = (err: unknown): GitError => {
  const code = nodeErrorCode(err);
  if (code === "ENOENT")
    return gitError(
      "hostGitMissing",
      "the host `git` executable was not found on PATH",
    );
  return classifyNodeError(err);
};

/**
 * Map a non-zero `git` exit to a `GitError`. Without a stable machine sentinel a
 * non-zero exit is the generic `gitFailed`; callers that KNOW the meaning of a
 * specific probe's failure (e.g. `open` treating a failed `--is-inside-work-tree`
 * as `notARepository`) classify contextually rather than parsing stderr here.
 */
export const classifyExit = (
  exitCode: number | null,
  stderr: string,
): GitError =>
  gitError(
    "gitFailed",
    `git exited with code ${exitCode ?? "null"}`,
    gitStderrExcerpt(stderr),
  );

/** A short, credential-scrubbed stderr excerpt for `detail` (never control flow). */
export const gitStderrExcerpt = (
  stderr: string,
): { readonly gitStderrExcerpt: string } | undefined => {
  const trimmed = stderr.trim();
  if (trimmed === "") return undefined;
  const excerpt =
    trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
  return { gitStderrExcerpt: scrubSecrets(excerpt) };
};

const nodeErrorCode = (err: unknown): string | undefined =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  typeof (err as { code: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
