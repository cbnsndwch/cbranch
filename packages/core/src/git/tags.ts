// Tag operations (docs/spec/07 REQ-P3-TG-001..010).
//
// for-each-ref lists all tags; separate git-tag commands create, delete, and
// push them. The Unit Separator (ASCII 31) is the field delimiter — it cannot
// appear in ref names, so it is collision-safe.

import {
  type GitError,
  Oid,
  TagInfo,
  type TagType,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { gitError } from "./errors";
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";

// ASCII Unit Separator (0x1F) — cannot appear in tag names or ref names.
const SEP = String.fromCharCode(31);

// for-each-ref format (fields 0–7 separated by SEP):
// 0: refname (full, e.g. refs/tags/v1.0.0)
// 1: objecttype ("tag" for annotated, "commit" for lightweight)
// 2: objectname (tag object OID for annotated; commit OID for lightweight)
// 3: *objectname (peeled target commit OID for annotated; empty for lightweight)
// 4: contents:subject (tag message subject line)
// 5: taggername
// 6: taggeremail (may arrive with angle brackets: <email@example.com>)
// 7: taggerdate:unix (Unix timestamp; empty/0 for lightweight)
const FORMAT =
  "%(refname)" +
  SEP +
  "%(objecttype)" +
  SEP +
  "%(objectname)" +
  SEP +
  "%(*objectname)" +
  SEP +
  "%(contents:subject)" +
  SEP +
  "%(taggername)" +
  SEP +
  "%(taggeremail)" +
  SEP +
  "%(taggerdate:unix)";

const REFS_TAGS_PREFIX = "refs/tags/";

function parseLine(line: string): TagInfo | null {
  const parts = line.split(SEP);
  if (parts.length < 8) return null;

  const fullRef = parts[0] ?? "";
  const objecttype = parts[1] ?? "";
  const objectname = parts[2] ?? "";
  const peeledOid = parts[3] ?? "";
  const subject = parts[4] ?? "";
  const taggername = parts[5] ?? "";
  let taggeremail = parts[6] ?? "";
  const taggerdateRaw = parts[7] ?? "";

  if (!fullRef || !objectname) return null;

  // Strip angle brackets from email field (git may include them).
  if (taggeremail.startsWith("<") && taggeremail.endsWith(">")) {
    taggeremail = taggeremail.slice(1, -1);
  }

  const isAnnotated = objecttype === "tag";
  const objectOid = objectname as Oid;
  // For annotated tags the peeled OID is the target commit; for lightweight
  // the objectname already IS the commit OID.
  const targetOid = (isAnnotated && peeledOid ? peeledOid : objectname) as Oid;

  const name = fullRef.startsWith(REFS_TAGS_PREFIX)
    ? fullRef.slice(REFS_TAGS_PREFIX.length)
    : fullRef;

  const taggerDateParsed = taggerdateRaw ? parseInt(taggerdateRaw, 10) : 0;
  const taggerDate = taggerDateParsed > 0 ? taggerDateParsed : undefined;

  return new TagInfo({
    name,
    fullRef,
    objectOid,
    targetOid,
    isAnnotated,
    taggerName: taggername || undefined,
    taggerEmail: taggeremail || undefined,
    taggerDate,
    subject: subject || undefined,
  });
}

/** List all tags in the repository (REQ-P3-TG-001). */
export const tagList = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<readonly TagInfo[], GitError> =>
  Effect.gen(function* () {
    const result = yield* runGitOk({
      cwd,
      args: ["for-each-ref", "--format=" + FORMAT, "refs/tags"],
      env,
    });
    const output = decodeUtf8(result.stdout);
    const tags: TagInfo[] = [];
    for (const raw of output.split(String.fromCharCode(10))) {
      const line = raw.trimEnd();
      if (!line) continue;
      const tag = parseLine(line);
      if (tag !== null) tags.push(tag);
    }
    return tags;
  });

export interface TagCreateOptions {
  readonly target?: string;
  readonly tagType: TagType;
  readonly message?: string;
  readonly force?: boolean;
}

/** Create a tag (lightweight, annotated, or signed) and return its TagInfo (REQ-P3-TG-002). */
export const tagCreate = (
  cwd: string,
  name: string,
  opts: TagCreateOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<TagInfo, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "tag name");

    const args: string[] = ["tag"];
    if (opts.tagType === "annotated") {
      args.push("-a");
      args.push("-m", opts.message ?? safeName);
    } else if (opts.tagType === "signed") {
      args.push("-s");
      args.push("-m", opts.message ?? safeName);
    }
    if (opts.force === true) args.push("-f");
    args.push(safeName);
    if (opts.target !== undefined) args.push(opts.target);

    const raw = yield* runGit({ cwd, args, env, read: false });

    if (raw.exitCode !== 0) {
      const stderr = decodeUtf8(raw.stderr);
      if (stderr.includes("already exists")) {
        return yield* Effect.fail(
          gitError("refExists", "tag '" + safeName + "' already exists"),
        );
      }
      return yield* Effect.fail(
        gitError("gitFailed", "git tag failed: " + stderr.trim()),
      );
    }

    // Retrieve the newly created tag from the listing.
    const all = yield* tagList(cwd, env);
    const created = all.find((t) => t.name === safeName);
    if (!created) {
      return yield* Effect.fail(
        gitError(
          "gitFailed",
          "tag created but not found in listing: " + safeName,
        ),
      );
    }
    return created;
  });

/** Delete a local tag (REQ-P3-TG-003). */
export const tagDelete = (
  cwd: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "tag name");
    yield* runGitOk({ cwd, args: ["tag", "-d", safeName], env, read: false });
  });

export interface TagPushOptions {
  /** Tag name to push (mutually exclusive with `all`). */
  readonly name?: string;
  /** Push all local tags to the remote. */
  readonly all?: boolean;
}

/** Push a tag (or all tags) to a remote (REQ-P3-TG-004). */
export const tagPush = (
  cwd: string,
  remote: string,
  opts?: TagPushOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeRemote = yield* assertNoLeadingDash(remote, "remote name");
    const args: string[] = ["push"];
    if (opts?.all === true) {
      args.push("--tags", safeRemote);
    } else if (opts?.name !== undefined) {
      const safeName = yield* assertNoLeadingDash(opts.name, "tag name");
      args.push(safeRemote, "refs/tags/" + safeName);
    } else {
      args.push("--tags", safeRemote);
    }
    yield* runGitOk({ cwd, args, env, read: false });
  });

/** Delete a tag on a remote (REQ-P3-TG-005). */
export const tagDeleteRemote = (
  cwd: string,
  remote: string,
  name: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeRemote = yield* assertNoLeadingDash(remote, "remote name");
    const safeName = yield* assertNoLeadingDash(name, "tag name");
    yield* runGitOk({
      cwd,
      args: ["push", safeRemote, "--delete", "refs/tags/" + safeName],
      env,
      read: false,
    });
  });
