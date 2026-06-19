// RPC handler bindings (docs/spec/14 §7; DECISIONS D1).
//
// Maps every method of the single `CbranchRpcs` catalog to the corresponding
// `GitEngine` operation. The handler keys are the on-wire PascalCase tags (D1);
// unary methods return an `Effect`, the two streaming methods (`RepoSubscribe`,
// `LogStream`) return a `Stream` (`Stream.unwrap` threads the `GitEngine` service in).
// Every handler calls THROUGH the engine and never touches git directly
// (REQ-ARCH-010); the produced layer requires `GitEngine` and provides the RPC
// handler context the server runtime consumes.

import { GitEngine } from "@cbranch/core";
import { CbranchRpcs } from "@cbranch/rpc-contract";
import { Effect, Stream } from "effect";

/** Layer providing the P1 RPC handlers; requires `GitEngine` (supplied by `gitEngineLayer`). */
export const handlersLayer = CbranchRpcs.toLayer({
  // ── repository & live state ────────────────────────────────────────────────
  RepoOpen: ({ path }) => Effect.flatMap(GitEngine, (engine) => engine.open(path)),
  RepoRecentList: () => Effect.flatMap(GitEngine, (engine) => engine.recentList()),
  RepoRecentRemove: ({ repoId }) => Effect.flatMap(GitEngine, (engine) => engine.recentRemove(repoId)),
  RepoState: ({ repoId }) => Effect.flatMap(GitEngine, (engine) => engine.state(repoId)),
  RepoSubscribe: ({ repoId }) => Stream.unwrap(Effect.map(GitEngine, (engine) => engine.subscribe(repoId))),

  // ── history & diff & content ───────────────────────────────────────────────
  LogStream: (query) => Stream.unwrap(Effect.map(GitEngine, (engine) => engine.logStream(query))),
  CommitDetail: ({ repoId, oid }) => Effect.flatMap(GitEngine, (engine) => engine.commitDetail(repoId, oid)),
  CommitDiff: (spec) => Effect.flatMap(GitEngine, (engine) => engine.commitDiff(spec)),
  DiffWorkingFile: ({ repoId, path, staged }) =>
    Effect.flatMap(GitEngine, (engine) => engine.diffWorkingFile(repoId, path, staged)),
  FileContentAtRev: ({ repoId, path, rev }) =>
    Effect.flatMap(GitEngine, (engine) => engine.fileContentAtRev(repoId, path, rev)),
});
