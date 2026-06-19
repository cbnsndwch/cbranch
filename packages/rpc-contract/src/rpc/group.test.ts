// Contract tests for the P1 method catalog (NF-TEST-5 / NF-TEST-6).
//
// Every method is exercised over the in-memory `RpcTest` client wired to stub
// handlers that return schema-valid sample data (NO git logic): unary results must
// decode, streams must yield the expected items, a handler-thrown `GitError` must
// surface as a typed error with the right `code`, and a malformed payload must be
// rejected (not crash). All `effect/unstable/*` access is via the quarantine adapter.

import { Effect, Exit, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { RpcTest } from "../effect-rpc-adapter";
import {
  CommitDetail,
  CommitSummary,
  DiffFile,
  DiffLine,
  DownloadDescriptor,
  FileContent,
  Hunk,
  RecentRepo,
  RepoHandle,
  RepoState,
  Signature,
} from "../schemas/domain";
import { GitError } from "../schemas/errors";
import { InvalidationEvent } from "../schemas/live";
import { Oid, RepoId } from "../schemas/primitives";
import { LogQuery } from "../schemas/queries";
import { CbranchRpcs } from "./group";

// --- schema-valid sample data (branded ids + one instance per success type) ---
const repoId = RepoId.make("a".repeat(64));
const oid1 = Oid.make("1".repeat(40));
const oid2 = Oid.make("2".repeat(40));

const signature = new Signature({
  name: "Ada Lovelace",
  email: "ada@example.io",
  when: { epochSeconds: 1_700_000_000, tzOffsetMinutes: -300 },
});

const repoState = new RepoState({
  headOid: oid1,
  currentBranch: "main",
  isDetached: false,
  inProgress: "none",
  isBare: false,
  isEmpty: false,
  repoRoot: "/srv/repo",
  gitDir: "/srv/repo/.git",
  defaultBranch: "main",
});

const repoHandle = new RepoHandle({
  repoId,
  root: "/srv/repo",
  gitDir: "/srv/repo/.git",
  commonDir: "/srv/repo/.git",
  state: repoState,
});

const recentRepo = new RecentRepo({
  path: "/srv/repo",
  name: "repo",
  repoId,
  lastOpenedAt: 1_700_000_000_000,
});

const commitSummary = (subject: string) =>
  new CommitSummary({
    oid: oid1,
    parents: [oid2],
    authorName: "Ada Lovelace",
    authorEmail: "ada@example.io",
    authorDate: "2023-11-14T22:13:20-05:00",
    committerDate: "2023-11-14T22:13:20-05:00",
    subject,
    refs: ["HEAD", "refs/heads/main"],
  });

const commitDetail = new CommitDetail({
  oid: oid1,
  parents: [oid2],
  tree: oid2,
  author: signature,
  committer: signature,
  subject: "init",
  body: "the body",
  messageRaw: "init\n\nthe body",
  stats: { filesChanged: 1, additions: 1, deletions: 0 },
});

const textDiffFile = new DiffFile({
  oldPath: "a.txt",
  newPath: "a.txt",
  status: "modified",
  isBinary: false,
  oldMode: "100644",
  newMode: "100644",
  oldOid: oid1,
  newOid: oid2,
  additions: 1,
  deletions: 0,
  hunks: [
    new Hunk({
      header: "@@ -1 +1,2 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: [new DiffLine({ kind: "add", content: "hello", newLineNo: 2 })],
    }),
  ],
});

const binaryDiffFile = new DiffFile({
  oldPath: "logo.png",
  newPath: "logo.png",
  status: "modified",
  isBinary: true,
  additions: null,
  deletions: null,
  hunks: [],
});

const fileContent = new FileContent({
  path: "a.txt",
  oid: oid1,
  size: 5,
  isBinary: false,
  encoding: "utf8",
  content: "hello",
});

// --- stub handlers: schema-valid data, plus payload-driven error injection ---
const handlers = CbranchRpcs.toLayer({
  RepoOpen: ({ path }) =>
    path === ""
      ? Effect.fail(new GitError({ code: "repoNotFound", message: "no repository at path" }))
      : Effect.succeed(repoHandle),
  RepoRecentList: () => Effect.succeed([recentRepo]),
  RepoRecentRemove: () => Effect.void,
  RepoState: () => Effect.succeed(repoState),
  RepoSubscribe: () => Stream.make(new InvalidationEvent({ repoId, domains: ["status", "commits", "refs"] })),
  LogStream: ({ limit }) =>
    limit < 0
      ? Stream.fail(new GitError({ code: "gitFailed", message: "limit must be >= 0" }))
      : Stream.fromIterable([commitSummary("first"), commitSummary("second")]),
  CommitDetail: () => Effect.succeed(commitDetail),
  CommitDiff: () => Effect.succeed([textDiffFile, binaryDiffFile]),
  DiffWorkingFile: () => Effect.succeed(textDiffFile),
  FileContentAtRev: ({ path }) =>
    path === "huge.bin"
      ? Effect.succeed(
          new DownloadDescriptor({
            url: "/sidechannel/blob?repoId=x&rev=HEAD&path=huge.bin",
            size: 50_000_000,
            contentType: "application/octet-stream",
            filename: "huge.bin",
          }),
        )
      : Effect.succeed(fileContent),
});

describe("CbranchRpcs P1 contract (in-memory RpcTest round-trip)", () => {
  test("every P1 method round-trips schema-valid data", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);

      // 1. repo.open (unary)
      const handle = yield* client.RepoOpen({ path: "/srv/repo" });

      // 2. repo.recentList (unary, array, empty payload)
      const recents = yield* client.RepoRecentList({});

      // 3. repo.recentRemove (unary, void)
      const removed = yield* client.RepoRecentRemove({ repoId });

      // 4. repo.state (unary)
      const state = yield* client.RepoState({ repoId });

      // 5. repo.subscribe (stream of InvalidationEvent)
      const events = yield* Stream.runCollect(client.RepoSubscribe({ repoId }));

      // 6. log.stream (stream of CommitSummary; honors limit)
      const summaries = yield* Stream.runCollect(client.LogStream({ repoId, limit: 10 }));

      // 7. commit.detail (unary)
      const detail = yield* client.CommitDetail({ repoId, oid: oid1 });

      // 8. commit.diff (unary, array; mixed text + binary)
      const diffFiles = yield* client.CommitDiff({
        repoId,
        target: oid1,
        cached: false,
        whitespace: "show",
        context: 3,
        renames: true,
        combined: false,
      });

      // 9. diff.workingFile (unary)
      const workingDiff = yield* client.DiffWorkingFile({ repoId, path: "a.txt", staged: false });

      // 10. file.contentAtRev (unary union: inline FileContent vs DownloadDescriptor)
      const inline = yield* client.FileContentAtRev({ repoId, path: "a.txt", rev: "HEAD" });
      const descriptor = yield* client.FileContentAtRev({ repoId, path: "huge.bin", rev: "HEAD" });

      return { handle, recents, removed, state, events, summaries, detail, diffFiles, workingDiff, inline, descriptor };
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const result = await Effect.runPromise(program);

    // 1.
    expect(result.handle.repoId).toBe(repoId);
    expect(result.handle.root).toBe("/srv/repo");
    expect(result.handle.state.inProgress).toBe("none");
    // 2.
    expect(result.recents).toHaveLength(1);
    expect(result.recents[0]?.name).toBe("repo");
    // 3.
    expect(result.removed).toBeUndefined();
    // 4.
    expect(result.state.currentBranch).toBe("main");
    expect(result.state.headOid).toBe(oid1);
    // 5.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.domains).toEqual(["status", "commits", "refs"]);
    // 6.
    expect(result.summaries.map((c) => c.subject)).toEqual(["first", "second"]);
    expect(result.summaries[0]?.parents).toEqual([oid2]);
    // 7.
    expect(result.detail.author.when.epochSeconds).toBe(1_700_000_000);
    expect(result.detail.stats.filesChanged).toBe(1);
    // 8.
    expect(result.diffFiles).toHaveLength(2);
    expect(result.diffFiles[0]?.hunks[0]?.lines[0]?.kind).toBe("add");
    expect(result.diffFiles[1]?.isBinary).toBe(true);
    expect(result.diffFiles[1]?.additions).toBeNull();
    // 9.
    expect(result.workingDiff.newPath).toBe("a.txt");
    // 10.
    expect("content" in result.inline).toBe(true);
    if ("content" in result.inline) {
      expect(result.inline.content).toBe("hello");
      expect(result.inline.encoding).toBe("utf8");
    }
    expect("url" in result.descriptor).toBe(true);
    if ("url" in result.descriptor) {
      expect(result.descriptor.filename).toBe("huge.bin");
    }
  });

  test("a handler GitError surfaces as a typed unary error with the right code", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      return yield* Effect.flip(client.RepoOpen({ path: "" }));
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const error = await Effect.runPromise(program);

    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe("repoNotFound");
    expect(error.message).toBe("no repository at path");
  });

  test("a handler GitError surfaces on the streaming per-item error channel", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      return yield* Effect.flip(Stream.runCollect(client.LogStream({ repoId, limit: -1 })));
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const error = await Effect.runPromise(program);

    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe("gitFailed");
  });

  test("a malformed RPC payload is rejected (failure), never a crash", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      // repoId must be a string; feeding a number must be rejected by the boundary.
      return yield* Effect.exit(client.RepoState({ repoId: 123 as unknown as RepoId }));
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const exit = await Effect.runPromise(program);

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("payload Schemas validate at the boundary (RPC-032)", () => {
  test("a malformed LogQuery decodes to a typed SchemaError failure, not a throw", () => {
    const exit = Schema.decodeUnknownExit(LogQuery)({ repoId: 123, limit: "not-a-number" });

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("a well-formed LogQuery decodes successfully", () => {
    const exit = Schema.decodeUnknownExit(LogQuery)({ repoId: "abc", limit: 100, refScope: "all" });

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
