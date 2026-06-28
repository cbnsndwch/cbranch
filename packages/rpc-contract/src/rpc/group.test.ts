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
  BranchInfo,
  BranchListing,
  BranchUpstream,
  MergeResult,
  RemoteInfo,
  StashEntry,
  SyncProgressEvent,
  TagInfo,
  WorktreeInfo,
} from "../schemas/branches";
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
import {
  BlameCommit,
  BlameData,
  BlameLine,
  BlameResult,
  BlameTooLarge,
  ConflictFile,
  ConflictListing,
  ConflictSides,
  ConflictStage,
  FileHistoryEntry,
  FileHistoryPage,
  SequencerResult,
} from "../schemas/phase4";
import {
  ArchiveDescriptor,
  ArchiveFormat,
  BisectStatus,
  CleanEntry,
  CleanPreview,
  CleanResult,
  GcPrune,
  GcResult,
  ReflogEntry,
  ReflogPage,
  SubmoduleInfo,
  SubmoduleStatus,
} from "../schemas/phase5";
import { Oid, RepoId } from "../schemas/primitives";
import { LogQuery } from "../schemas/queries";
import {
  CommitCreated,
  CommitMessage,
  WorkingTreeStatus,
} from "../schemas/working-tree";
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

// --- P3 sample data ---
const branchUpstream = new BranchUpstream({
  ref: "refs/remotes/origin/main",
  name: "origin/main",
  ahead: 0,
  behind: 0,
});
const branchInfo = new BranchInfo({
  name: "main",
  fullRef: "refs/heads/main",
  tipOid: oid1,
  tipSubject: "init",
  isCurrent: true,
  upstream: branchUpstream,
  isRemote: false,
});
const branchListing = new BranchListing({
  localBranches: [branchInfo],
  remoteBranches: [],
  currentBranch: "main",
});
const mergeResult = new MergeResult({ mode: "fastForward", newTipOid: oid1 });
const syncProgress = new SyncProgressEvent({
  _tag: "progress",
  text: "Fetching origin",
});
const remoteInfo = new RemoteInfo({
  name: "origin",
  fetchUrl: "https://example.com/repo.git",
});
const worktreeInfo = new WorktreeInfo({
  path: "/srv/repo",
  headOid: oid1,
  branch: "main",
  isMain: true,
  isBare: false,
  isDetached: false,
  isLocked: false,
  isPrunable: false,
});
const stashEntry = new StashEntry({
  index: 0,
  ref: "stash@{0}",
  message: "WIP",
  branch: "main",
  headOid: oid1,
  subject: "WIP on main",
});
const tagInfo = new TagInfo({
  name: "v1.0.0",
  fullRef: "refs/tags/v1.0.0",
  objectOid: oid1,
  targetOid: oid1,
  isAnnotated: false,
});

// --- P4 sample data ---
const conflictStage = (present: boolean) =>
  new ConflictStage({
    present,
    isBinary: false,
    encoding: "utf8",
    content: present ? "hello\n" : "",
    oid: present ? oid1 : undefined,
    size: present ? 6 : 0,
  });
const conflictListing = new ConflictListing({
  operation: "merge",
  conflicted: [
    new ConflictFile({
      path: "a.txt",
      classification: "bothModified",
      hasBase: true,
      hasOurs: true,
      hasTheirs: true,
      isBinary: false,
      isSubmodule: false,
    }),
  ],
  conflictedCount: 1,
  canContinue: false,
  canSkip: false,
});
const conflictSides = new ConflictSides({
  path: "a.txt",
  classification: "bothModified",
  isBinary: false,
  isSubmodule: false,
  base: conflictStage(true),
  ours: conflictStage(true),
  theirs: conflictStage(true),
  merged: conflictStage(true),
  mergeable: true,
});
const sequencerResult = new SequencerResult({
  outcome: "completed",
  operation: "cherryPick",
  committed: 1,
  newCommitOid: oid1,
});
const blameData = new BlameData({
  path: "a.txt",
  rev: "HEAD",
  commits: [
    new BlameCommit({
      oid: oid1,
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.io",
      authorTime: 1_700_000_000,
      authorTzMinutes: -300,
      summary: "init",
      filename: "a.txt",
    }),
  ],
  lines: [
    new BlameLine({
      ownerOid: oid1,
      finalLineNo: 1,
      origLineNo: 1,
      content: "hello",
    }),
  ],
});
const fileHistoryPage = new FileHistoryPage({
  entries: [
    new FileHistoryEntry({
      oid: oid1,
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.io",
      authorDate: "2023-11-14T22:13:20-05:00",
      subject: "init",
      path: "a.txt",
      status: "modified",
    }),
  ],
});

// --- P5 sample data ---
const gcResult = new GcResult({
  stdout: "Counting objects: 12, done.\n",
  stderr: "",
});
const cleanPreview = new CleanPreview({
  entries: [
    new CleanEntry({ path: "build.log", isDirectory: false }),
    new CleanEntry({ path: "dist/", isDirectory: true }),
  ],
});
const cleanResult = new CleanResult({ removed: 2 });
const archiveDescriptor = new ArchiveDescriptor({
  url: "/sidechannel/archive?repoId=x&treeish=HEAD&format=zip",
  filename: "cbranch-HEAD.zip",
  contentType: "application/zip",
  format: "zip",
});
const reflogPage = new ReflogPage({
  entries: [
    new ReflogEntry({
      selector: "HEAD@{0}",
      oid: oid1,
      action: "commit",
      message: "init",
    }),
  ],
  nextCursor: "cursor-1",
});
const bisectStatus = new BisectStatus({
  state: "bisecting",
  current: commitSummary("midpoint"),
  badTerm: "bad",
  goodTerm: "good",
  revisionsRemaining: 3,
  stepsRemaining: 2,
});
const submodules = [
  // outOfSync: recorded ≠ checked-out, both present.
  new SubmoduleInfo({
    path: "vendor/lib",
    name: "vendor/lib",
    absPath: "/srv/repo/vendor/lib",
    recordedOid: oid1,
    checkedOutOid: oid2,
    status: "outOfSync",
    describe: "v1.2.3-4-gdeadbee",
    url: "https://example.com/lib.git",
    branch: "main",
  }),
  // uninitialized: no checked-out commit.
  new SubmoduleInfo({
    path: "vendor/uninit",
    name: "vendor/uninit",
    absPath: "/srv/repo/vendor/uninit",
    recordedOid: oid1,
    status: "uninitialized",
    url: "https://example.com/uninit.git",
  }),
];

// --- stub handlers: schema-valid data, plus payload-driven error injection ---
const handlers = CbranchRpcs.toLayer({
  RepoOpen: ({ path }) =>
    path === ""
      ? Effect.fail(
          new GitError({
            code: "repoNotFound",
            message: "no repository at path",
          }),
        )
      : Effect.succeed(repoHandle),
  RepoRecentList: () => Effect.succeed([recentRepo]),
  RepoRecentRemove: () => Effect.void,
  RepoState: () => Effect.succeed(repoState),
  RepoSubscribe: () =>
    Stream.make(
      new InvalidationEvent({ repoId, domains: ["status", "commits", "refs"] }),
    ),
  LogStream: ({ limit }) =>
    limit < 0
      ? Stream.fail(
          new GitError({ code: "gitFailed", message: "limit must be >= 0" }),
        )
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

  // ── P2: stage & commit (S1 plumbing; schema-valid stubs, no git logic) ───────
  StatusGet: () =>
    Effect.succeed(new WorkingTreeStatus({ entries: [], hasConflicts: false })),
  StageFiles: () => Effect.void,
  UnstageFiles: () => Effect.void,
  DiscardFiles: () => Effect.void,
  DeleteUntracked: () => Effect.void,
  ResetTo: () => Effect.void,
  StageHunks: () => Effect.void,
  UnstageHunks: () => Effect.void,
  DiscardHunks: () => Effect.void,
  CommitCreate: ({ subject }) =>
    Effect.succeed(
      new CommitCreated({ oid: oid1, shortOid: "1111111", subject }),
    ),
  CommitLastMessage: () =>
    Effect.succeed(
      new CommitMessage({ subject: "init", body: "", raw: "init" }),
    ),

  // ── P3: branches ────────────────────────────────────────────────────────────
  BranchList: () => Effect.succeed(branchListing),
  BranchCreate: () => Effect.succeed(branchInfo),
  BranchSwitch: () => Effect.void,
  BranchCheckoutDetached: () => Effect.void,
  BranchRename: () => Effect.void,
  BranchDelete: () => Effect.void,
  BranchSetUpstream: () => Effect.void,

  // ── P3: merge ───────────────────────────────────────────────────────────────
  MergeCreate: () => Effect.succeed(mergeResult),
  MergeAbort: () => Effect.void,

  // ── P3: sync (streaming) ────────────────────────────────────────────────────
  FetchStream: () => Stream.make(syncProgress),
  PullStream: () => Stream.make(syncProgress),
  PushStream: () => Stream.make(syncProgress),
  PushDeleteRemoteRef: () => Effect.void,

  // ── P3: remotes ─────────────────────────────────────────────────────────────
  RemoteList: () => Effect.succeed([remoteInfo]),
  RemoteAdd: () => Effect.void,
  RemoteSetUrl: () => Effect.void,
  RemoteRename: () => Effect.void,
  RemoteRemove: () => Effect.void,

  // ── P3: worktrees ───────────────────────────────────────────────────────────
  WorktreeList: () => Effect.succeed([worktreeInfo]),
  WorktreeAdd: () => Effect.succeed(worktreeInfo),
  WorktreeRemove: () => Effect.void,
  WorktreePrune: () => Effect.void,
  WorktreeSwitch: () => Effect.void,

  // ── P3: stash ───────────────────────────────────────────────────────────────
  StashPush: () => Effect.succeed(stashEntry),
  StashList: () => Effect.succeed([stashEntry]),
  StashShow: () => Effect.succeed([textDiffFile]),
  StashApply: () => Effect.void,
  StashPop: () => Effect.void,
  StashDrop: () => Effect.void,
  StashClear: () => Effect.void,

  // ── P3: tags ─────────────────────────────────────────────────────────────────
  TagList: () => Effect.succeed([tagInfo]),
  TagCreate: () => Effect.succeed(tagInfo),
  TagDelete: () => Effect.void,
  TagPush: () => Effect.void,
  TagDeleteRemote: () => Effect.void,

  // ── P4: conflicts / sequencer / blame / file history ──────────────────────────
  ConflictList: () => Effect.succeed(conflictListing),
  ConflictSides: () => Effect.succeed(conflictSides),
  ConflictResolve: () => Effect.void,
  ConflictSaveMerged: () => Effect.void,
  ConflictMarkResolved: () => Effect.void,
  ConflictMarkUnresolved: () => Effect.void,
  CherryPick: () => Effect.succeed(sequencerResult),
  Revert: () => Effect.succeed(sequencerResult),
  OpContinue: () => Effect.succeed(sequencerResult),
  OpAbort: () => Effect.void,
  OpSkip: () => Effect.succeed(sequencerResult),
  Blame: ({ force }) =>
    force === true
      ? Effect.succeed(blameData)
      : Effect.succeed(
          new BlameTooLarge({
            path: "a.txt",
            rev: "HEAD",
            byteSize: 20_000_000,
            lineCount: 0,
          }),
        ),
  FileHistory: () => Effect.succeed(fileHistoryPage),

  // ── P5: repository maintenance (gc) ───────────────────────────────────────────
  RepoGc: () => Effect.succeed(gcResult),

  // ── P5: clean working directory ───────────────────────────────────────────────
  CleanPreview: () => Effect.succeed(cleanPreview),
  Clean: () => Effect.succeed(cleanResult),

  // ── P5: archive export ────────────────────────────────────────────────────────
  ArchivePrepare: () => Effect.succeed(archiveDescriptor),

  // ── P5: reflog viewer ─────────────────────────────────────────────────────────
  ReflogList: () => Effect.succeed(reflogPage),

  // ── P5: bisect ────────────────────────────────────────────────────────────────
  BisectStart: () => Effect.succeed(bisectStatus),
  BisectMark: () => Effect.succeed(bisectStatus),
  BisectReset: () => Effect.void,
  BisectStatus: () => Effect.succeed(bisectStatus),

  // ── P5: submodules ──────────────────────────────────────────────────────────────
  SubmoduleList: () => Effect.succeed(submodules),
  SubmoduleUpdate: () => Effect.void,
  SubmoduleSync: () => Effect.void,
  SubmoduleAdd: () => Effect.void,
  SubmoduleRemove: () => Effect.void,
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
      const summaries = yield* Stream.runCollect(
        client.LogStream({ repoId, limit: 10 }),
      );

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
      const workingDiff = yield* client.DiffWorkingFile({
        repoId,
        path: "a.txt",
        staged: false,
      });

      // 10. file.contentAtRev (unary union: inline FileContent vs DownloadDescriptor)
      const inline = yield* client.FileContentAtRev({
        repoId,
        path: "a.txt",
        rev: "HEAD",
      });
      const descriptor = yield* client.FileContentAtRev({
        repoId,
        path: "huge.bin",
        rev: "HEAD",
      });

      return {
        handle,
        recents,
        removed,
        state,
        events,
        summaries,
        detail,
        diffFiles,
        workingDiff,
        inline,
        descriptor,
      };
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
      return yield* Effect.flip(
        Stream.runCollect(client.LogStream({ repoId, limit: -1 })),
      );
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const error = await Effect.runPromise(program);

    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe("gitFailed");
  });

  test("a malformed RPC payload is rejected (failure), never a crash", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      // repoId must be a string; feeding a number must be rejected by the boundary.
      return yield* Effect.exit(
        client.RepoState({ repoId: 123 as unknown as RepoId }),
      );
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const exit = await Effect.runPromise(program);

    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("payload Schemas validate at the boundary (RPC-032)", () => {
  test("a malformed LogQuery decodes to a typed SchemaError failure, not a throw", () => {
    const exit = Schema.decodeUnknownExit(LogQuery)({
      repoId: 123,
      limit: "not-a-number",
    });

    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("a well-formed LogQuery decodes successfully", () => {
    const exit = Schema.decodeUnknownExit(LogQuery)({
      repoId: "abc",
      limit: 100,
      refScope: "all",
    });

    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe("CbranchRpcs P2 stage & commit method catalog (DECISIONS D1 wire tags)", () => {
  test.each([
    "StatusGet",
    "StageFiles",
    "UnstageFiles",
    "DiscardFiles",
    "DeleteUntracked",
    "ResetTo",
    "StageHunks",
    "UnstageHunks",
    "DiscardHunks",
    "CommitCreate",
    "CommitLastMessage",
  ])("exposes the %s wire tag", (tag) => {
    expect(CbranchRpcs.requests.has(tag)).toBe(true);
  });
});

describe("CbranchRpcs P3 branches/sync/remotes/worktrees/stash/tags method catalog (DECISIONS D1 wire tags)", () => {
  test.each([
    // branches
    "BranchList",
    "BranchCreate",
    "BranchSwitch",
    "BranchCheckoutDetached",
    "BranchRename",
    "BranchDelete",
    "BranchSetUpstream",
    // merge
    "MergeCreate",
    "MergeAbort",
    // sync
    "FetchStream",
    "PullStream",
    "PushStream",
    "PushDeleteRemoteRef",
    // remotes
    "RemoteList",
    "RemoteAdd",
    "RemoteSetUrl",
    "RemoteRename",
    "RemoteRemove",
    // worktrees
    "WorktreeList",
    "WorktreeAdd",
    "WorktreeRemove",
    "WorktreePrune",
    "WorktreeSwitch",
    // stash
    "StashPush",
    "StashList",
    "StashShow",
    "StashApply",
    "StashPop",
    "StashDrop",
    "StashClear",
    // tags
    "TagList",
    "TagCreate",
    "TagDelete",
    "TagPush",
    "TagDeleteRemote",
  ])("exposes the %s wire tag", (tag) => {
    expect(CbranchRpcs.requests.has(tag)).toBe(true);
  });
});

describe("CbranchRpcs P4 conflicts/sequencer/blame/file-history round-trip", () => {
  test("every P4 method round-trips schema-valid data", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);

      const conflicts = yield* client.ConflictList({ repoId });
      const sides = yield* client.ConflictSides({ repoId, path: "a.txt" });
      const resolved = yield* client.ConflictResolve({
        repoId,
        paths: ["a.txt"],
        resolution: "ours",
      });
      const saved = yield* client.ConflictSaveMerged({
        repoId,
        path: "a.txt",
        content: "merged\n",
        encoding: "utf8",
      });
      const marked = yield* client.ConflictMarkResolved({
        repoId,
        paths: ["a.txt"],
      });
      const unmarked = yield* client.ConflictMarkUnresolved({
        repoId,
        paths: ["a.txt"],
      });
      const picked = yield* client.CherryPick({ repoId, commits: [oid1] });
      const reverted = yield* client.Revert({ repoId, commits: [oid1] });
      const continued = yield* client.OpContinue({ repoId });
      const aborted = yield* client.OpAbort({ repoId });
      const skipped = yield* client.OpSkip({ repoId });
      const blameInline = yield* client.Blame({
        repoId,
        path: "a.txt",
        force: true,
      });
      const blameLarge = yield* client.Blame({ repoId, path: "a.txt" });
      const history = yield* client.FileHistory({
        repoId,
        path: "a.txt",
        limit: 50,
      });

      return {
        conflicts,
        sides,
        resolved,
        saved,
        marked,
        unmarked,
        picked,
        reverted,
        continued,
        aborted,
        skipped,
        blameInline,
        blameLarge,
        history,
      };
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const r = await Effect.runPromise(program);

    expect(r.conflicts.operation).toBe("merge");
    expect(r.conflicts.conflicted[0]?.classification).toBe("bothModified");
    expect(r.sides.base.present).toBe(true);
    expect(r.sides.mergeable).toBe(true);
    expect(r.resolved).toBeUndefined();
    expect(r.saved).toBeUndefined();
    expect(r.marked).toBeUndefined();
    expect(r.unmarked).toBeUndefined();
    expect(r.picked.outcome).toBe("completed");
    expect(r.reverted.operation).toBe("cherryPick");
    expect(r.continued.committed).toBe(1);
    expect(r.aborted).toBeUndefined();
    expect(r.skipped.newCommitOid).toBe(oid1);
    // BlameResult union decodes unambiguously on its disjoint required fields.
    expect("lines" in r.blameInline).toBe(true);
    if ("lines" in r.blameInline) {
      expect(r.blameInline.lines[0]?.content).toBe("hello");
    }
    expect("byteSize" in r.blameLarge).toBe(true);
    expect(r.history.entries[0]?.path).toBe("a.txt");
  });

  test("BlameResult decodes both arms unambiguously (RPC-032)", () => {
    const dataExit = Schema.decodeUnknownExit(BlameResult)({
      path: "a.txt",
      rev: "HEAD",
      commits: [],
      lines: [],
    });
    const largeExit = Schema.decodeUnknownExit(BlameResult)({
      path: "a.txt",
      rev: "HEAD",
      byteSize: 20_000_000,
      lineCount: 0,
    });

    expect(Exit.isSuccess(dataExit)).toBe(true);
    expect(Exit.isSuccess(largeExit)).toBe(true);
  });
});

describe("CbranchRpcs P4 conflicts/sequencer/blame/file-history method catalog (DECISIONS D1 wire tags)", () => {
  test.each([
    // conflicts
    "ConflictList",
    "ConflictSides",
    "ConflictResolve",
    "ConflictSaveMerged",
    "ConflictMarkResolved",
    "ConflictMarkUnresolved",
    // cherry-pick / revert + continuation
    "CherryPick",
    "Revert",
    "OpContinue",
    "OpAbort",
    "OpSkip",
    // blame & file history
    "Blame",
    "FileHistory",
  ])("exposes the %s wire tag", (tag) => {
    expect(CbranchRpcs.requests.has(tag)).toBe(true);
  });
});

describe("CbranchRpcs P5 power-features round-trip", () => {
  test("RepoGc round-trips a GcResult (display-only stdout/stderr)", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      return yield* client.RepoGc({ repoId, aggressive: true, prune: "now" });
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const result = await Effect.runPromise(program);

    expect(result.stdout).toContain("Counting objects");
    expect(result.stderr).toBe("");
  });

  test("GcPrune rejects an out-of-set literal (RPC-032)", () => {
    expect(Exit.isFailure(Schema.decodeUnknownExit(GcPrune)("sometimes"))).toBe(
      true,
    );
    expect(Exit.isSuccess(Schema.decodeUnknownExit(GcPrune)("now"))).toBe(true);
    expect(Exit.isSuccess(Schema.decodeUnknownExit(GcPrune)("default"))).toBe(
      true,
    );
  });

  test("CleanPreview + Clean round-trip (file + directory entries)", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      const preview = yield* client.CleanPreview({
        repoId,
        directories: true,
        ignored: false,
      });
      const result = yield* client.Clean({
        repoId,
        paths: ["build.log", "dist/"],
        directories: true,
        ignored: false,
      });
      return { preview, result };
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const { preview, result } = await Effect.runPromise(program);

    expect(preview.entries.map((e) => e.path)).toEqual(["build.log", "dist/"]);
    expect(preview.entries[1]?.isDirectory).toBe(true);
    expect(result.removed).toBe(2);
  });

  test("ArchivePrepare round-trips a descriptor; ArchiveFormat is closed", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      return yield* client.ArchivePrepare({
        repoId,
        treeish: "HEAD",
        format: "zip",
      });
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const descriptor = await Effect.runPromise(program);

    expect(descriptor.format).toBe("zip");
    expect(descriptor.url).toContain("/sidechannel/archive");
    expect(descriptor.filename).toBe("cbranch-HEAD.zip");
    expect(Exit.isFailure(Schema.decodeUnknownExit(ArchiveFormat)("rar"))).toBe(
      true,
    );
  });

  test("ReflogList round-trips a page with selector/action/message + cursor", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      return yield* client.ReflogList({ repoId, limit: 50 });
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const page = await Effect.runPromise(program);

    expect(page.entries[0]?.selector).toBe("HEAD@{0}");
    expect(page.entries[0]?.action).toBe("commit");
    expect(page.entries[0]?.oid).toBe(oid1);
    expect(page.nextCursor).toBe("cursor-1");
  });

  test("bisect quartet round-trips status (start/mark/status) + Void reset", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      const started = yield* client.BisectStart({ repoId });
      const marked = yield* client.BisectMark({ repoId, mark: "bad" });
      const reset = yield* client.BisectReset({ repoId });
      const status = yield* client.BisectStatus({ repoId });
      return { started, marked, reset, status };
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const r = await Effect.runPromise(program);

    expect(r.started.state).toBe("bisecting");
    expect(r.started.revisionsRemaining).toBe(3);
    expect(r.marked.current?.subject).toBe("midpoint");
    expect(r.reset).toBeUndefined();
    expect(r.status.goodTerm).toBe("good");
  });

  test("submodule methods round-trip a listing + Void mutations", async () => {
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CbranchRpcs);
      const list = yield* client.SubmoduleList({ repoId });
      const updated = yield* client.SubmoduleUpdate({
        repoId,
        paths: ["vendor/lib"],
        init: true,
        recursive: true,
        force: true,
      });
      const synced = yield* client.SubmoduleSync({ repoId });
      const added = yield* client.SubmoduleAdd({
        repoId,
        url: "https://example.com/lib.git",
        path: "vendor/lib",
      });
      const removed = yield* client.SubmoduleRemove({
        repoId,
        path: "vendor/lib",
      });
      return { list, updated, synced, added, removed };
    }).pipe(Effect.provide(handlers), Effect.scoped);

    const r = await Effect.runPromise(program);

    expect(r.list).toHaveLength(2);
    // outOfSync: recorded and checked-out both present and differ.
    expect(r.list[0]?.status).toBe("outOfSync");
    expect(r.list[0]?.recordedOid).toBe(oid1);
    expect(r.list[0]?.checkedOutOid).toBe(oid2);
    // uninitialized: no checked-out commit on the wire.
    expect(r.list[1]?.status).toBe("uninitialized");
    expect(r.list[1]?.checkedOutOid).toBeUndefined();
    expect(r.updated).toBeUndefined();
    expect(r.synced).toBeUndefined();
    expect(r.added).toBeUndefined();
    expect(r.removed).toBeUndefined();
  });

  test("SubmoduleStatus is a closed literal set (RPC-032)", () => {
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(SubmoduleStatus)("conflicted")),
    ).toBe(true);
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(SubmoduleStatus)("deleted")),
    ).toBe(true);
  });
});

// Per-feature P5 slices APPEND their tags to this catalog block (D18); gc opens it.
describe("CbranchRpcs P5 power-features method catalog (DECISIONS D1 wire tags)", () => {
  test.each([
    // maintenance (gc)
    "RepoGc",
    // clean
    "CleanPreview",
    "Clean",
    // archive
    "ArchivePrepare",
    // reflog
    "ReflogList",
    // bisect
    "BisectStart",
    "BisectMark",
    "BisectReset",
    "BisectStatus",
    // submodules
    "SubmoduleList",
    "SubmoduleUpdate",
    "SubmoduleSync",
    "SubmoduleAdd",
    "SubmoduleRemove",
  ])("exposes the %s wire tag", (tag) => {
    expect(CbranchRpcs.requests.has(tag)).toBe(true);
  });
});
