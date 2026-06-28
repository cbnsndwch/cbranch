// Git config read/write (docs/spec/09-phase5-power.md REQ-P5-CFG-001..004; D18, S7).
//
// Two configs are NEVER crossed (REQ-P5-CFG-005): git config lives in git config files
// (this module); cbranch's own app settings live in the host `config.json`
// (`config/config-store.ts`). This module ONLY touches git config.
//
// Reads pass `read: false` deliberately (the ONE exception to the "reads pass
// READ_FLAGS" rule): the injected `-c color.ui=false -c core.quotePath=false` overrides
// would otherwise surface as phantom `command`-scope rows and mask the real effective
// value. `GIT_OPTIONAL_LOCKS=0` still rides the non-interactive env, and config output
// needs no color / quotePath / optional-lock handling.

import {
  type ConfigScope,
  type GitError,
  GitConfigEntry,
  GitConfigValue,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { classifyExit, gitError } from "./errors";
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";

/** The scopes git reports via `--show-scope`; the parser tolerates exactly these. */
const KNOWN_SCOPES: ReadonlySet<string> = new Set([
  "system",
  "global",
  "local",
  "worktree",
  "command",
]);

/** The only scopes a write may target (REQ-P5-CFG-002); `system`/`worktree` are refused. */
const WRITABLE_SCOPES: ReadonlySet<string> = new Set(["global", "local"]);

/** Argv for the on-disk listing: scope + origin, NUL-framed, no READ_FLAGS injection. */
export const configListArgs = (): string[] => [
  "config",
  "--list",
  "--show-origin",
  "--show-scope",
  "-z",
];

/** The `--<scope>` read flag, or `null` for an effective/merged read (or `command`). */
const scopeReadFlag = (scope?: ConfigScope): string | null => {
  switch (scope) {
    case "system":
      return "--system";
    case "global":
      return "--global";
    case "local":
      return "--local";
    case "worktree":
      return "--worktree";
    default:
      return null;
  }
};

/** Argv for a single-key read: scoped (`--global --get`) or effective (`--get`). */
export const configGetArgs = (key: string, scope?: ConfigScope): string[] => {
  const flag = scopeReadFlag(scope);
  return flag ? ["config", flag, "--get", key] : ["config", "--get", key];
};

/** Argv for a write: `config --<scope> <key> <value>` (value is positional, never a flag). */
export const configSetArgs = (
  key: string,
  value: string,
  scope: ConfigScope,
): string[] => ["config", `--${scope}`, key, value];

/** Argv for an unset: `config --<scope> --unset <key>`. */
export const configUnsetArgs = (key: string, scope: ConfigScope): string[] => [
  "config",
  `--${scope}`,
  "--unset",
  key,
];

/**
 * Parse `git config --list --show-origin --show-scope -z` into one row per stored value.
 * The output is NUL-framed and grouped by THREE fields per entry:
 * `scope\0origin\0key\nvalue\0` — split key/value on the FIRST `\n` (a value may itself
 * contain `\n`, preserved by the NUL framing). A trailing NUL leaves an empty final
 * field (dropped); a short final group is tolerated; unknown scopes are skipped.
 */
export const parseConfigList = (stdout: string): GitConfigEntry[] => {
  const fields = stdout.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  const out: GitConfigEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const scope = fields[i];
    const origin = fields[i + 1];
    const keyValue = fields[i + 2];
    if (scope === undefined || origin === undefined || keyValue === undefined)
      continue;
    if (!KNOWN_SCOPES.has(scope)) continue;
    const nl = keyValue.indexOf("\n");
    const key = nl < 0 ? keyValue : keyValue.slice(0, nl);
    const value = nl < 0 ? "" : keyValue.slice(nl + 1);
    out.push(
      new GitConfigEntry({ key, value, scope: scope as ConfigScope, origin }),
    );
  }
  return out;
};

/** Strip exactly one trailing `\n` git appends to a `--get` value. */
const stripOneTrailingNewline = (s: string): string =>
  s.endsWith("\n") ? s.slice(0, -1) : s;

/** READ — every on-disk entry with scope + origin (REQ-P5-CFG-001). */
export const configList = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<readonly GitConfigEntry[], GitError> =>
  Effect.map(
    runGitOk({ cwd, args: configListArgs(), env, read: false }),
    (result) => parseConfigList(decodeUtf8(result.stdout)),
  );

/** READ — a single key (REQ-P5-CFG-003). exit 1 = unset → `present:false` (DATA). */
export const configGet = (
  cwd: string,
  key: string,
  scope?: ConfigScope,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<GitConfigValue, GitError> =>
  Effect.flatMap(assertNoLeadingDash(key, "config key"), () =>
    Effect.flatMap(
      runGit({ cwd, args: configGetArgs(key, scope), env, read: false }),
      (result) => {
        const base = scope === undefined ? { key } : { key, scope };
        if (result.exitCode === 0)
          return Effect.succeed(
            new GitConfigValue({
              ...base,
              present: true,
              value: stripOneTrailingNewline(decodeUtf8(result.stdout)),
            }),
          );
        if (result.exitCode === 1)
          return Effect.succeed(
            new GitConfigValue({ ...base, present: false }),
          );
        return Effect.fail(
          classifyExit(result.exitCode, decodeUtf8(result.stderr)),
        );
      },
    ),
  );

/** ✎ — set a key at a writable scope (REQ-P5-CFG-002/004); refuses non-writable scopes. */
export const configSet = (
  cwd: string,
  key: string,
  value: string,
  scope: ConfigScope,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  WRITABLE_SCOPES.has(scope)
    ? Effect.flatMap(assertNoLeadingDash(key, "config key"), () =>
        Effect.asVoid(
          runGitOk({
            cwd,
            args: configSetArgs(key, value, scope),
            env,
            read: false,
          }),
        ),
      )
    : Effect.fail(
        gitError(
          "permissionDenied",
          `refusing to write git config in the ${scope} scope (only global and local are writable)`,
        ),
      );

/** ✎ — unset a key (REQ-P5-CFG-004). exit 5 = already-absent → idempotent success. */
export const configUnset = (
  cwd: string,
  key: string,
  scope: ConfigScope,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  WRITABLE_SCOPES.has(scope)
    ? Effect.flatMap(assertNoLeadingDash(key, "config key"), () =>
        Effect.flatMap(
          runGit({ cwd, args: configUnsetArgs(key, scope), env, read: false }),
          (result) =>
            result.exitCode === 0 || result.exitCode === 5
              ? Effect.void
              : Effect.fail(
                  classifyExit(result.exitCode, decodeUtf8(result.stderr)),
                ),
        ),
      )
    : Effect.fail(
        gitError(
          "permissionDenied",
          `refusing to unset git config in the ${scope} scope (only global and local are writable)`,
        ),
      );
