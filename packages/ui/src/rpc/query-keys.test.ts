import { DiffSpec, LogQuery, Oid, RepoId } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import { domainKey, queryKeys, repoScopeKey } from "./query-keys";

const repoId = RepoId.make("repo-1");

describe("query keys (D9 / spec 15 §2)", () => {
  test("repoScopeKey is the [repoId] reconnect resnapshot target", () => {
    expect(repoScopeKey(repoId)).toEqual([repoId]);
  });

  test("domainKey maps a changed domain to [repoId, domain]", () => {
    expect(domainKey(repoId, "commits")).toEqual([repoId, "commits"]);
    expect(domainKey(repoId, "inProgress")).toEqual([repoId, "inProgress"]);
  });

  test("repoState sits under the inProgress domain so repo.state invalidates with it", () => {
    expect(queryKeys.repoState(repoId)[1]).toBe("inProgress");
  });

  test("log key is under the commits domain and carries the query", () => {
    const query = new LogQuery({ repoId, limit: 500 });
    const key = queryKeys.log(query);
    expect(key[1]).toBe("commits");
    expect(key[3]).toBe(query);
  });

  test("commit detail/diff and blobs are content-addressed (non-domain, never invalidated)", () => {
    const oid = Oid.make("abc123");
    expect(queryKeys.commitDetail(repoId, oid)).toEqual([
      repoId,
      "commit",
      oid,
      "detail",
    ]);
    const spec = new DiffSpec({
      repoId,
      target: "abc123",
      cached: false,
      whitespace: "show",
      context: 3,
      renames: true,
      combined: false,
    });
    expect(queryKeys.commitDiff(spec)).toEqual([
      repoId,
      "commit",
      "abc123",
      "diff",
      { base: "^1", whitespace: "show", context: 3, combined: false },
    ]);
    expect(queryKeys.fileContentAtRev(repoId, "abc123", "src/a.ts")).toEqual([
      repoId,
      "blob",
      "abc123",
      "src/a.ts",
    ]);
  });
});
