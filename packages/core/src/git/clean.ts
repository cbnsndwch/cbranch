// Clean working directory (docs/spec/09 REQ-P5-CL-001..005; DECISIONS D18).
//
// A NEW two-method flow (preview + run), DISTINCT from the shipped per-file
// `deleteUntracked` (left untouched). `git clean` has no porcelain/`-z` form, so the
// preview parses the fixed-C-locale `Would remove ` stdout prefix (deterministic under
// the `LC_ALL=C` non-interactive env; `core.quotePath=false` keeps non-ASCII raw, but
// git still C-quotes control bytes, so a leading-`"` path is C-unquoted). Exit status is
// authoritative. The destructive run is option-gated AND path-explicit — it removes
// exactly the previewed paths; **empty `paths` is a no-op (`removed:0`), NEVER a
// pathspec-less `git clean -f`** (which would wipe the whole worktree).

import {
  CleanEntry,
  CleanPreview,
  CleanResult,
  type GitError,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { decodeUtf8, runGitOk } from "./run-git";

const PREVIEW_PREFIX = "Would remove ";

/**
 * Decode git's C-style double-quoted path form (`"a\tb\303\251/"`). Git emits it for
 * paths containing control/special bytes even under `core.quotePath=false`. Handles the
 * named escapes plus 1–3 digit octal byte escapes; non-special chars pass through.
 */
const cUnquote = (quoted: string): string => {
  const body = quoted.slice(1, -1); // strip the surrounding quotes
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1] ?? "";
    const named: Record<string, string> = {
      a: "\x07",
      b: "\b",
      t: "\t",
      n: "\n",
      v: "\v",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    };
    if (next in named) {
      out += named[next];
      i += 1;
    } else if (next >= "0" && next <= "7") {
      const oct = (body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/) ?? [""])[0];
      out += String.fromCharCode(Number.parseInt(oct, 8));
      i += oct.length;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
};

const parsePath = (raw: string): string =>
  raw.startsWith('"') ? cUnquote(raw) : raw;

/** `git clean -n [-d] [-x]` argv (preview). Pure (testable). */
export const cleanPreviewArgs = (
  directories: boolean,
  ignored: boolean,
): ReadonlyArray<string> => [
  "clean",
  "-n",
  ...(directories ? ["-d"] : []),
  ...(ignored ? ["-x"] : []),
];

/** `git clean -f [-d] [-x] -- <paths>` argv (destructive). Pure (testable). */
export const cleanArgs = (
  paths: ReadonlyArray<string>,
  directories: boolean,
  ignored: boolean,
): ReadonlyArray<string> => [
  "clean",
  "-f",
  ...(directories ? ["-d"] : []),
  ...(ignored ? ["-x"] : []),
  "--",
  ...paths,
];

/** Parse the `Would remove …` lines; drop everything else (e.g. `Skipping repository …`). */
export const parseCleanPreview = (
  stdout: string,
): ReadonlyArray<CleanEntry> => {
  const entries: CleanEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(PREVIEW_PREFIX)) continue;
    const path = parsePath(line.slice(PREVIEW_PREFIX.length));
    entries.push(new CleanEntry({ path, isDirectory: path.endsWith("/") }));
  }
  return entries;
};

const REMOVED_PREFIX = "Removing ";

/**
 * Count git's `Removing …` lines — the paths it ACTUALLY removed. Mirrors
 * {@link parseCleanPreview}; the prefix is fixed under `LC_ALL=C`. Reporting this
 * instead of the requested `paths.length` keeps `removed` honest when git deletes
 * fewer than requested (a previewed path vanished before the run, or a non-UTF-8
 * pathspec matched nothing).
 */
export const countRemoved = (stdout: string): number => {
  let removed = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(REMOVED_PREFIX)) removed += 1;
  }
  return removed;
};

export const cleanPreview = (
  cwd: string,
  directories: boolean,
  ignored: boolean,
): Effect.Effect<CleanPreview, GitError> =>
  Effect.map(
    runGitOk({ cwd, args: cleanPreviewArgs(directories, ignored) }),
    (r) =>
      new CleanPreview({ entries: parseCleanPreview(decodeUtf8(r.stdout)) }),
  );

export const clean = (
  cwd: string,
  paths: ReadonlyArray<string>,
  directories: boolean,
  ignored: boolean,
): Effect.Effect<CleanResult, GitError> => {
  // Empty-pathspec catastrophe guard: a pathspec-less `git clean -f` wipes the whole
  // worktree, so an empty selection is a no-op, never a git invocation (REQ-P5-CL-003).
  if (paths.length === 0)
    return Effect.succeed(new CleanResult({ removed: 0 }));
  return Effect.map(
    runGitOk({
      cwd,
      args: cleanArgs(paths, directories, ignored),
      read: false,
    }),
    (r) => new CleanResult({ removed: countRemoved(decodeUtf8(r.stdout)) }),
  );
};
