import { RepoId } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import {
  buildLogQuery,
  clearFilter,
  describeFilters,
  emptyFilters,
  hasActiveFilters,
} from "./filters";

const repoId = RepoId.make("repo-1");

describe("buildLogQuery (P1-FILT-1..6; spec 05 §2.4)", () => {
  test("the default scope is all refs with no other constraints", () => {
    const q = buildLogQuery(repoId, emptyFilters);
    expect(q.refScope).toBe("all");
    expect(q.path).toBeUndefined();
    expect(q.author).toBeUndefined();
    expect(q.grep).toBeUndefined();
    expect(q.since).toBeUndefined();
    expect(q.until).toBeUndefined();
    expect(q.refPattern).toBeUndefined();
  });

  test("present fields map through and blanks are omitted (DM-003)", () => {
    const q = buildLogQuery(repoId, {
      ...emptyFilters,
      refScope: "all",
      path: " src/ ",
      author: "ada",
      grep: "",
      since: "2024-01-01",
    });
    expect(q.refScope).toBe("all");
    expect(q.path).toBe("src/");
    expect(q.author).toBe("ada");
    expect(q.grep).toBeUndefined();
    expect(q.since).toBe("2024-01-01");
  });

  test("a ref pattern is only emitted in pattern scope", () => {
    expect(
      buildLogQuery(repoId, {
        ...emptyFilters,
        refPattern: "refs/heads/*",
      }).refPattern,
    ).toBeUndefined();
    expect(
      buildLogQuery(repoId, {
        ...emptyFilters,
        refScope: "pattern",
        refPattern: "refs/heads/*",
      }).refPattern,
    ).toBe("refs/heads/*");
  });
});

describe("describeFilters / hasActiveFilters (P1-FILT-6)", () => {
  test("no chips and not active for the default set", () => {
    expect(describeFilters(emptyFilters)).toEqual([]);
    expect(hasActiveFilters(emptyFilters)).toBe(false);
  });

  test("one chip per active constraint; narrowing to the current branch is a constraint", () => {
    const filters = {
      ...emptyFilters,
      refScope: "current" as const,
      author: "ada",
      path: "src",
    };
    const labels = describeFilters(filters).map((c) => c.label);
    expect(labels).toContain("refs: current branch");
    expect(labels).toContain("author: ada");
    expect(labels).toContain("path: src");
    expect(hasActiveFilters(filters)).toBe(true);
  });

  test("the default all-refs scope is not itself a chip", () => {
    expect(
      describeFilters({ ...emptyFilters, refScope: "all" }).map((c) => c.label),
    ).not.toContain("refs: all");
  });
});

describe("clearFilter (P1-FILT-6)", () => {
  test("clearing a text field blanks it", () => {
    expect(
      clearFilter({ ...emptyFilters, author: "ada" }, "author").author,
    ).toBe("");
  });

  test("clearing the ref scope returns to the all-refs default + blank pattern", () => {
    const cleared = clearFilter(
      { ...emptyFilters, refScope: "pattern", refPattern: "x" },
      "refPattern",
    );
    expect(cleared.refScope).toBe("all");
    expect(cleared.refPattern).toBe("");
  });
});
