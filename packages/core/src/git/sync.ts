// Streaming sync: fetch, pull, push, and push-delete (docs/spec/07 REQ-P3-SY-*).
//
// Each sync operation runs git as a child process (batch mode) and parses stdout/stderr
// into SyncEvent items emitted as an Effect Stream. Real-time streaming is deferred; this
// MVP collects all output then emits parsed events.

import {
  type GitError,
  Oid,
  SyncProgressEvent,
  SyncRefUpdate,
} from "@cbranch/rpc-contract";
import { type SyncEvent } from "@cbranch/rpc-contract";
import { Effect, Stream } from "effect";

import { classifyExit } from "./errors";
import { assertNoLeadingDash, decodeUtf8, runGit, runGitOk } from "./run-git";

// ─── ref-update line parser ───────────────────────────────────────────────────
// Matches lines like:
//   " * [new branch]      main -> origin/main"
//   "   a1b2c3..e5f6g7  feat -> origin/feat"
//   " - [deleted]         origin/gone"
const REF_UPDATE_RE =
  /^\s*(?:[+ *t!=-])\s+(.+?)\s{2,}([\w./-]+)\s+->\s+([\w./-]+)\s*(?:\((.*?)\))?$/;
// Matches a sha range in summary: "abc1234..def5678"
const OID_RANGE_RE = /^([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/;

function parseEvents(stdout: Buffer, stderr: Buffer): SyncEvent[] {
  const events: SyncEvent[] = [];
  const combined = decodeUtf8(stdout) + decodeUtf8(stderr);

  for (const raw of combined.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;

    const m = REF_UPDATE_RE.exec(line);
    if (m) {
      const summary = (m[1] ?? "").trim();
      const localRef = m[2] ?? "";
      const remoteRef = m[3] ?? "";
      const rangeMatch = OID_RANGE_RE.exec(summary);
      const fromOid = rangeMatch ? (rangeMatch[1] as Oid) : undefined;
      const toOid = rangeMatch ? (rangeMatch[2] as Oid) : undefined;
      events.push(
        new SyncRefUpdate({
          _tag: "refUpdate",
          summary,
          localRef,
          remoteRef,
          fromOid,
          toOid,
        }),
      );
    } else {
      // Skip git header lines like "From <url>" and "To <url>"
      if (/^(?:From|To)\s+\S/.test(line)) continue;
      events.push(new SyncProgressEvent({ _tag: "progress", text: line }));
    }
  }

  return events;
}

function makeStream(
  eff: Effect.Effect<SyncEvent[], GitError>,
): Stream.Stream<SyncEvent, GitError> {
  return Stream.unwrap(
    Effect.map(eff, (events) => Stream.fromIterable(events)),
  );
}

// REQ-P3-SY-001/002/003
export const fetchStream = (
  cwd: string,
  remote?: string,
  all?: boolean,
  prune?: boolean,
  tags?: boolean,
  env?: NodeJS.ProcessEnv,
): Stream.Stream<SyncEvent, GitError> =>
  makeStream(
    Effect.gen(function* () {
      const args: string[] = ["fetch", "--progress"];
      if (all) {
        args.push("--all");
      } else if (remote) {
        const safeRemote = yield* assertNoLeadingDash(remote, "remote");
        args.push(safeRemote);
      }
      if (prune) args.push("--prune");
      if (tags) args.push("--tags");

      const raw = yield* runGit({ cwd, args, env, read: false });
      if (raw.exitCode !== 0) {
        return yield* Effect.fail(
          classifyExit(raw.exitCode, decodeUtf8(raw.stderr)),
        );
      }
      return parseEvents(raw.stdout, raw.stderr);
    }),
  );

// REQ-P3-SY-010/011
export const pullStream = (
  cwd: string,
  mode: "ff-only" | "rebase" | "merge",
  autostash?: boolean,
  env?: NodeJS.ProcessEnv,
): Stream.Stream<SyncEvent, GitError> =>
  makeStream(
    Effect.gen(function* () {
      const args: string[] = ["pull", "--progress"];
      if (mode === "ff-only") args.push("--ff-only");
      else if (mode === "rebase") args.push("--rebase");
      else args.push("--no-rebase");
      if (autostash) args.push("--autostash");

      const raw = yield* runGit({ cwd, args, env, read: false });
      if (raw.exitCode !== 0) {
        return yield* Effect.fail(
          classifyExit(raw.exitCode, decodeUtf8(raw.stderr)),
        );
      }
      return parseEvents(raw.stdout, raw.stderr);
    }),
  );

// REQ-P3-SY-020/021/022/023
export const pushStream = (
  cwd: string,
  remote: string,
  branch?: string,
  setUpstream?: boolean,
  forceWithLease?: boolean,
  tags?: boolean,
  env?: NodeJS.ProcessEnv,
): Stream.Stream<SyncEvent, GitError> =>
  makeStream(
    Effect.gen(function* () {
      const safeRemote = yield* assertNoLeadingDash(remote, "remote");
      const args: string[] = ["push", "--progress", safeRemote];
      if (branch) {
        const safeBranch = yield* assertNoLeadingDash(branch, "branch");
        args.push(safeBranch);
      }
      if (setUpstream) args.push("--set-upstream");
      if (forceWithLease) args.push("--force-with-lease");
      if (tags) args.push("--tags");

      const raw = yield* runGit({ cwd, args, env, read: false });
      if (raw.exitCode !== 0) {
        return yield* Effect.fail(
          classifyExit(raw.exitCode, decodeUtf8(raw.stderr)),
        );
      }
      return parseEvents(raw.stdout, raw.stderr);
    }),
  );

// REQ-P3-SY-024
export const pushDeleteRemoteRef = (
  cwd: string,
  remote: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const safeRemote = yield* assertNoLeadingDash(remote, "remote");
    const safeRef = yield* assertNoLeadingDash(ref, "ref");
    yield* runGitOk({
      cwd,
      args: ["push", safeRemote, "--delete", safeRef],
      env,
      read: false,
    });
  });
