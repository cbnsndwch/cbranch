// Remote management (docs/spec/07 REQ-P3-RE-*)

import { type GitError, RemoteInfo } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { assertNoLeadingDash, decodeUtf8, runGitOk } from "./run-git";

// Parse `git remote -v` output into RemoteInfo list.
// Each unique remote name appears twice (fetch and push URL); we deduplicate.
function parseRemoteVerbose(stdout: string): RemoteInfo[] {
  const map = new Map<string, { fetchUrl: string; pushUrl?: string }>();
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Format: "<name>\t<url> (fetch|push)"
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    const spaceBeforeParen = rest.lastIndexOf(" (");
    if (spaceBeforeParen < 0) continue;
    const url = rest.slice(0, spaceBeforeParen);
    const kind = rest.slice(spaceBeforeParen + 2, -1); // strip " (" and ")"
    const entry = map.get(name) ?? { fetchUrl: url };
    if (kind === "fetch") entry.fetchUrl = url;
    else if (kind === "push") entry.pushUrl = url;
    map.set(name, entry);
  }
  return [...map.entries()].map(([name, { fetchUrl, pushUrl }]) => new RemoteInfo({ name, fetchUrl, pushUrl }));
}

export const remoteList = (cwd: string, env?: NodeJS.ProcessEnv): Effect.Effect<readonly RemoteInfo[], GitError> =>
  Effect.gen(function* () {
    const result = yield* runGitOk({ cwd, args: ["remote", "-v"], env });
    return parseRemoteVerbose(decodeUtf8(result.stdout));
  });

export const remoteAdd = (
  cwd: string,
  name: string,
  url: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "remote name");
    yield* runGitOk({ cwd, args: ["remote", "add", safeName, url], env, read: false });
  });

export const remoteSetUrl = (
  cwd: string,
  name: string,
  url: string,
  push?: boolean,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "remote name");
    const args = ["remote", "set-url", safeName, url];
    if (push) args.splice(2, 0, "--push"); // insert --push before name
    yield* runGitOk({ cwd, args, env, read: false });
  });

export const remoteRename = (
  cwd: string,
  oldName: string,
  newName: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeOld = yield* assertNoLeadingDash(oldName, "remote name");
    const safeNew = yield* assertNoLeadingDash(newName, "new remote name");
    yield* runGitOk({ cwd, args: ["remote", "rename", safeOld, safeNew], env, read: false });
  });

export const remoteRemove = (cwd: string, name: string, env?: NodeJS.ProcessEnv): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeName = yield* assertNoLeadingDash(name, "remote name");
    yield* runGitOk({ cwd, args: ["remote", "remove", safeName], env, read: false });
  });
