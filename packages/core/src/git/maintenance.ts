// `git gc` repository maintenance (docs/spec/09 REQ-P5-GC-001..004; DECISIONS D18).
//
// One mutating run, held under the per-repo lock for its whole duration by the engine
// (REQ-P5-GC-003). The summary is captured for DISPLAY only (`GcResult`) — never
// parsed: a non-zero exit is the authoritative failure (`gitFailed`, via `runGitOk`),
// not stderr text (NF-GIT-3/NF-GIT-4). `read:false` so the read-mode `-c color.ui=false
// -c core.quotePath=false --no-optional-locks` overrides never ride this mutation.

import { GcResult, type GcPrune, type GitError } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { decodeUtf8, runGitOk } from "./run-git";

/**
 * Build the `git gc` argv from the toggles. Pure (testable without spawning git).
 * `aggressive` adds `--aggressive`; `prune === "now"` adds `--prune=now` (an explicit
 * opt-in), while `"default"`/absent omits `--prune`, keeping git's default 2-week
 * expiry. No `--quiet` — the summary is the point of the action.
 */
export const gcArgs = (
  aggressive?: boolean,
  prune?: GcPrune,
): ReadonlyArray<string> => [
  "gc",
  ...(aggressive === true ? ["--aggressive"] : []),
  ...(prune === "now" ? ["--prune=now"] : []),
];

/** Run `git gc` and capture its output (REQ-P5-GC-001..003). */
export const gc = (
  cwd: string,
  aggressive?: boolean,
  prune?: GcPrune,
): Effect.Effect<GcResult, GitError> =>
  Effect.map(
    runGitOk({ cwd, args: gcArgs(aggressive, prune), read: false }),
    (r) =>
      new GcResult({
        stdout: decodeUtf8(r.stdout),
        stderr: decodeUtf8(r.stderr),
      }),
  );
