// Submodules (docs/spec/09 REQ-P5-SM-001..006; DECISIONS D18).
//
// Listing is an **index-cross-read**, not `submodule status`-only: the authoritative
// path set + `recordedOid` come from the stage-0 gitlink (mode `160000`) in
// `git ls-files --stage -z` (the NUL-safe path source — `submodule status` has no
// `-z`), the live `status`/`checkedOutOid`/`describe` from the line-based
// `git submodule status`, and `name`/`url`/`branch` from `.gitmodules`. The three are
// joined by PATH; status lines that don't match a known gitlink path are dropped. A
// CONFLICTED submodule (`U`) has only stages 1/2/3 (base/ours/theirs) and no stage-0
// gitlink, so `recordedOid` is left ABSENT and the status is `conflicted` straight from
// the index — never a stage-1/2/3 oid picked arbitrarily. Mutations hold the repo lock;
// the list is a lockless read.

import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type GitError,
  Oid,
  SubmoduleInfo,
  type SubmoduleStatus,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { classifyNodeError } from "./errors";
import {
  assertNoLeadingDash,
  decodeUtf8,
  isHexOid,
  runGit,
  runGitOk,
} from "./run-git";

const GITLINK_MODE = "160000";

interface GitlinkEntry {
  /** The stage-0 gitlink oid (the superproject's recorded commit); absent if conflicted. */
  stage0Oid?: string;
  /** True when the index carries stage 1/2/3 entries (a merge-conflicted gitlink). */
  hasConflictStages: boolean;
}

/**
 * Parse `git ls-files --stage -z` into the gitlink (mode `160000`) entries keyed by
 * path. Each NUL-terminated record is `<mode> <oid> <stage>\t<path>`. Non-gitlink rows
 * (regular files) are dropped; a path that appears only at stages 1/2/3 (no stage 0) is
 * a conflicted submodule and gets no `stage0Oid`.
 */
export const parseGitlinks = (stdout: string): Map<string, GitlinkEntry> => {
  const out = new Map<string, GitlinkEntry>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const [mode, oid, stage] = meta;
    if (mode !== GITLINK_MODE || oid === undefined || stage === undefined)
      continue;
    const entry = out.get(path) ?? { hasConflictStages: false };
    if (stage === "0") entry.stage0Oid = oid;
    else entry.hasConflictStages = true;
    out.set(path, entry);
  }
  return out;
};

interface SubmoduleStatusLine {
  /** git's leading marker: ` ` up-to-date, `-` uninitialized, `+` out-of-sync, `U` conflict. */
  prefix: string;
  /** The reported oid (checked-out for ` `/`+`, recorded for `-`); undefined if unparseable. */
  sha?: string;
  describe?: string;
}

/**
 * Parse the line-based `git submodule status` output, keyed by path. Each line is
 * `<prefix><sha> <path>[ (<describe>)]` with NO `-z`, so paths-with-spaces are
 * disambiguated against the known gitlink paths (longest exact/`<path> (`-prefixed
 * match wins); unmatched lines are dropped.
 */
export const parseSubmoduleStatus = (
  stdout: string,
  knownPaths: Iterable<string>,
): Map<string, SubmoduleStatusLine> => {
  // Longest paths first so a path that is a prefix of another can't shadow it.
  const paths = [...knownPaths].sort((a, b) => b.length - a.length);
  const out = new Map<string, SubmoduleStatusLine>();
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const prefix = line[0] ?? "";
    const rest = line.slice(1);
    const sp = rest.indexOf(" ");
    if (sp < 0) continue;
    const shaToken = rest.slice(0, sp);
    const region = rest.slice(sp + 1);
    const sha = isHexOid(shaToken) ? shaToken : undefined;
    const match = paths.find(
      (p) => region === p || region.startsWith(`${p} (`),
    );
    if (match === undefined) continue;
    const tail = region.slice(match.length).trim();
    const describe =
      tail.startsWith("(") && tail.endsWith(")")
        ? tail.slice(1, -1)
        : undefined;
    out.set(match, { prefix, sha, describe });
  }
  return out;
};

interface GitmodulesEntry {
  name?: string;
  url?: string;
  branch?: string;
}

/**
 * Parse `git config -f .gitmodules -z --list` (NUL records, `key\nvalue`) into a map
 * keyed by the submodule's `path` value, carrying `name`/`url`/`branch`. Submodule
 * names may contain dots, so the field is split off the LAST `.` of the key.
 */
export const parseGitmodules = (
  stdout: string,
): Map<string, GitmodulesEntry> => {
  const byName = new Map<
    string,
    { path?: string; url?: string; branch?: string }
  >();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const nl = record.indexOf("\n");
    const key = nl < 0 ? record : record.slice(0, nl);
    const value = nl < 0 ? "" : record.slice(nl + 1);
    if (!key.startsWith("submodule.")) continue;
    const remainder = key.slice("submodule.".length);
    const lastDot = remainder.lastIndexOf(".");
    if (lastDot < 0) continue;
    const name = remainder.slice(0, lastDot);
    const field = remainder.slice(lastDot + 1);
    const entry = byName.get(name) ?? {};
    if (field === "path") entry.path = value;
    else if (field === "url") entry.url = value;
    else if (field === "branch") entry.branch = value;
    byName.set(name, entry);
  }
  // Re-key by the submodule's worktree path (the join key for the index cross-read).
  const byPath = new Map<string, GitmodulesEntry>();
  for (const [name, entry] of byName) {
    if (entry.path === undefined) continue;
    byPath.set(entry.path, { name, url: entry.url, branch: entry.branch });
  }
  return byPath;
};

const deriveStatus = (
  conflicted: boolean,
  prefix: string | undefined,
): SubmoduleStatus => {
  if (conflicted) return "conflicted";
  switch (prefix) {
    case "-":
      return "uninitialized";
    case "+":
      return "outOfSync";
    case "U":
      return "conflicted";
    case " ":
      return "upToDate";
    default:
      // A gitlink with no matching `submodule status` line (e.g. not in .gitmodules):
      // treat as uninitialized, the safe machine default.
      return "uninitialized";
  }
};

/**
 * Join the three machine sources into the {@link SubmoduleInfo} array, sorted by path
 * for determinism. `recordedOid` from the stage-0 gitlink (absent when conflicted);
 * `checkedOutOid` only for `upToDate`/`outOfSync` rows (absent for uninitialized, whose
 * `submodule status` oid is the recorded, not checked-out, commit).
 */
export const combineSubmodules = (
  stageStdout: string,
  statusStdout: string,
  gitmodulesStdout: string,
  repoCwd: string,
): SubmoduleInfo[] => {
  const gitlinks = parseGitlinks(stageStdout);
  const statuses = parseSubmoduleStatus(statusStdout, gitlinks.keys());
  const modules = parseGitmodules(gitmodulesStdout);

  return [...gitlinks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, gl]) => {
      const conflicted = gl.stage0Oid === undefined && gl.hasConflictStages;
      const st = statuses.get(path);
      const mod = modules.get(path);
      const status = deriveStatus(conflicted, st?.prefix);
      const checkedOut =
        (status === "upToDate" || status === "outOfSync") &&
        st?.sha !== undefined &&
        isHexOid(st.sha)
          ? st.sha
          : undefined;
      return new SubmoduleInfo({
        path,
        name: mod?.name,
        absPath: join(repoCwd, path),
        recordedOid:
          gl.stage0Oid !== undefined ? Oid.make(gl.stage0Oid) : undefined,
        checkedOutOid:
          checkedOut !== undefined ? Oid.make(checkedOut) : undefined,
        status,
        describe: st?.describe,
        url: mod?.url,
        branch: mod?.branch,
      });
    });
};

export const submoduleList = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<readonly SubmoduleInfo[], GitError> =>
  Effect.gen(function* () {
    // ls-files is authoritative (gitlink paths + recorded oids); it must succeed.
    const stage = yield* runGitOk({
      cwd,
      args: ["ls-files", "--stage", "-z"],
      env,
    });
    // `submodule status` / `.gitmodules` are best-effort enrichers: a repo with no
    // submodules has no .gitmodules (config exit 1) and empty status — both DATA.
    const status = yield* runGit({ cwd, args: ["submodule", "status"], env });
    const modules = yield* runGit({
      cwd,
      args: ["config", "-f", ".gitmodules", "-z", "--list"],
      env,
    });
    return combineSubmodules(
      decodeUtf8(stage.stdout),
      status.exitCode === 0 ? decodeUtf8(status.stdout) : "",
      modules.exitCode === 0 ? decodeUtf8(modules.stdout) : "",
      cwd,
    );
  });

// ── argument builders (pure; exported for argv coverage) ─────────────────────

export const submoduleUpdateArgs = (opts: {
  paths?: ReadonlyArray<string>;
  init?: boolean;
  recursive?: boolean;
  force?: boolean;
}): string[] => {
  const args = ["submodule", "update"];
  if (opts.init === true) args.push("--init");
  if (opts.recursive === true) args.push("--recursive");
  if (opts.force === true) args.push("--force");
  if (opts.paths !== undefined && opts.paths.length > 0)
    args.push("--", ...opts.paths);
  return args;
};

export const submoduleSyncArgs = (opts: {
  paths?: ReadonlyArray<string>;
  recursive?: boolean;
}): string[] => {
  const args = ["submodule", "sync"];
  if (opts.recursive === true) args.push("--recursive");
  if (opts.paths !== undefined && opts.paths.length > 0)
    args.push("--", ...opts.paths);
  return args;
};

export const submoduleAddArgs = (
  url: string,
  path: string,
  branch?: string,
): string[] => {
  const args = ["submodule", "add"];
  if (branch !== undefined && branch !== "") args.push("-b", branch);
  args.push("--", url, path);
  return args;
};

// ── mutations (✎; hold the repo lock at the engine layer) ────────────────────

export const submoduleUpdate = (
  cwd: string,
  opts: {
    paths?: ReadonlyArray<string>;
    init?: boolean;
    recursive?: boolean;
    force?: boolean;
  },
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runGitOk({ cwd, args: submoduleUpdateArgs(opts), env, read: false }).pipe(
    Effect.asVoid,
  );

export const submoduleSync = (
  cwd: string,
  opts: { paths?: ReadonlyArray<string>; recursive?: boolean },
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  runGitOk({ cwd, args: submoduleSyncArgs(opts), env, read: false }).pipe(
    Effect.asVoid,
  );

export const submoduleAdd = (
  cwd: string,
  url: string,
  path: string,
  branch?: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    // url/path/branch precede the `--` (url/path) or are option-adjacent (branch),
    // so a leading dash would be read as a git option (NF-SEC-6).
    yield* assertNoLeadingDash(url, "submodule url");
    yield* assertNoLeadingDash(path, "submodule path");
    if (branch !== undefined && branch !== "")
      yield* assertNoLeadingDash(branch, "submodule branch");
    yield* runGitOk({
      cwd,
      args: submoduleAddArgs(url, path, branch),
      env,
      read: false,
    });
  });

/**
 * Remove a submodule as ONE guarded op (REQ-P5-SM-005): `deinit -f` (unregister +
 * empty the working tree) → `rm -f` (drop the gitlink + the `.gitmodules` stanza) →
 * best-effort removal of the cached git dir at `<commonDir>/modules/<path>`. Partial
 * removal is impossible — git refuses on a dirty superproject before any tree is
 * touched (→ `gitFailed`). A cleanup failure after the tracking is gone surfaces as
 * `fsError`/`permissionDenied` (the submodule IS removed; only its cached objects linger).
 */
export const submoduleRemove = (
  cwd: string,
  commonDir: string,
  path: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    yield* runGitOk({
      cwd,
      args: ["submodule", "deinit", "-f", "--", path],
      env,
      read: false,
    });
    yield* runGitOk({ cwd, args: ["rm", "-f", "--", path], env, read: false });
    yield* Effect.tryPromise({
      try: () =>
        rm(join(commonDir, "modules", path), {
          recursive: true,
          force: true,
        }),
      catch: classifyNodeError,
    });
  });
