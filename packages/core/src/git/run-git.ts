// Host-`git` execution backend (docs/spec/02 REQ-ARCH-020/060..064; 14 §3.3).
//
// Every invocation:
//   • spawns `git` with an ARGUMENT ARRAY — never a shell string (NF-SEC-6 / NF-GIT-1),
//   • runs with the active repository as cwd,
//   • exports a non-interactive, locale-stable environment (14 §3.3 VERBATIM),
//   • is interruption-safe: cancelling the Effect kills + reaps the child (REQ-ARCH-061),
//   • captures stdout/stderr as BYTES (paths may be non-UTF-8 — ENC-001/004),
//   • treats the exit status as authoritative (NF-GIT-4).
//
// Reads additionally pass `--no-optional-locks` and `-c core.quotePath=false`
// (literal non-ASCII paths) and disable color (`-c color.ui=false`, universally safe
// across subcommands, satisfying "always --no-color" without breaking commands that
// reject the `--no-color` flag).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { type GitError } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { classifyExit, classifyGitSpawnError, gitError } from "./errors";

/** Result of a single host-`git` invocation. stdout/stderr are raw bytes. */
export interface GitResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface RunGitOptions {
  /** Working directory for the spawned process (the active repository). */
  readonly cwd: string;
  /** Argument vector (no shell). Caller-controlled; user values must be sanitized. */
  readonly args: ReadonlyArray<string>;
  /** Extra environment entries merged over the non-interactive base. */
  readonly env?: NodeJS.ProcessEnv;
  /** When true (default) prepend the read-mode flags (no-color, quotePath, no-optional-locks). */
  readonly read?: boolean;
  /** Optional data to write to the child's stdin before closing it (used by `git commit -F -`, `git apply -`). */
  readonly stdin?: Buffer;
}

/** Decode a captured buffer as UTF-8, replacing invalid sequences (ENC-002). */
export const decodeUtf8 = (buf: Buffer): string => buf.toString("utf8");

const READ_FLAGS = ["-c", "color.ui=false", "-c", "core.quotePath=false", "--no-optional-locks"] as const;

/**
 * The non-interactive, locale-stable environment for host-`git` (14 §3.3).
 *
 * `GIT_ASKPASS`/`GIT_CORE_ASKPASS` point at the Node binary with no script, so any
 * credential prompt invokes `node <prompt-text>` which exits non-zero immediately —
 * a dependency-free, cross-platform fail-fast askpass that never blocks and never
 * surfaces a credential.
 */
export const nonInteractiveEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  GIT_ASKPASS: process.execPath,
  GIT_CORE_ASKPASS: process.execPath,
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  // Locale stability so parsed control flow never depends on translated text (NF-GIT-3).
  LC_ALL: "C",
  LANG: "C",
  LANGUAGE: "",
  ...extra,
});

/**
 * Spawn `git`, capturing stdout/stderr as bytes. Succeeds with a {@link GitResult}
 * for ANY exit code (the caller decides whether a non-zero exit is an error — e.g.
 * `rev-parse --verify HEAD` returns non-zero on an unborn branch, which is DATA, not
 * a failure). Fails only when the process cannot be spawned/abort.
 */
export const runGit = (opts: RunGitOptions): Effect.Effect<GitResult, GitError> =>
  Effect.callback<GitResult, GitError>((resume, signal) => {
    const args = opts.read === false ? [...opts.args] : [...READ_FLAGS, ...opts.args];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn("git", args, {
        cwd: opts.cwd,
        env: nonInteractiveEnv(opts.env),
        windowsHide: true,
      });
    } catch (err) {
      resume(Effect.fail(classifyGitSpawnError(err)));
      return;
    }

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const onAbort = () => {
      if (!settled) child.kill("SIGKILL");
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resume(Effect.fail(classifyGitSpawnError(err)));
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resume(
        Effect.succeed({
          exitCode: code,
          signal: sig,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      );
    });

    // Cleanup effect: kill the child if the fiber is interrupted before close.
    return Effect.sync(() => {
      if (!settled) child.kill("SIGKILL");
    });
  });

/**
 * Like {@link runGit} but treats a non-zero exit as a failure, mapping it to the
 * generic `gitFailed` with a credential-scrubbed stderr excerpt. Use when a non-zero
 * exit genuinely means the command failed; use {@link runGit} when the exit code is
 * itself meaningful data.
 */
export const runGitOk = (opts: RunGitOptions): Effect.Effect<GitResult, GitError> =>
  Effect.flatMap(runGit(opts), (result) =>
    result.exitCode === 0
      ? Effect.succeed(result)
      : Effect.fail(classifyExit(result.exitCode, decodeUtf8(result.stderr))),
  );

// ── argument-safety helpers (NF-SEC-5/6) ────────────────────────────────────

/**
 * Reject a user-supplied value that would be parsed as a `git` option (leading `-`)
 * when it is used OUTSIDE a `--` separator (option-injection guard, NF-SEC-6). Values
 * placed after `--` (pathspecs) are safe and need not pass through this.
 */
export const assertNoLeadingDash = (value: string, what: string): Effect.Effect<string, GitError> =>
  value.startsWith("-")
    ? Effect.fail(gitError("invalidRefName", `refusing ${what} beginning with '-': would be read as a git option`))
    : Effect.succeed(value);

/** Validate that a string is a plausible object id (hex, 4–64 chars) before use. */
export const isHexOid = (value: string): boolean => /^[0-9a-fA-F]{4,64}$/.test(value);
