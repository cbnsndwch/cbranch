import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { computeRepoId, isRepoId, normalizeAbsolute } from "./repo-id";

describe("computeRepoId (DECISIONS D2)", () => {
  test("is the SHA-256 hex of the common-dir's UTF-8 bytes", () => {
    const commonDir = "/srv/repo/.git";
    const expected = createHash("sha256").update(Buffer.from(commonDir, "utf8")).digest("hex");
    expect(computeRepoId(commonDir)).toBe(expected);
  });

  test("is a 64-char lowercase hex string", () => {
    expect(isRepoId(computeRepoId("/x/.git"))).toBe(true);
  });

  test("is stable across calls and distinct per common-dir", () => {
    expect(computeRepoId("/a/.git")).toBe(computeRepoId("/a/.git"));
    expect(computeRepoId("/a/.git")).not.toBe(computeRepoId("/b/.git"));
  });
});

describe("isRepoId", () => {
  test("accepts 64-hex, rejects others", () => {
    expect(isRepoId("a".repeat(64))).toBe(true);
    expect(isRepoId("A".repeat(64))).toBe(false); // lowercase only
    expect(isRepoId("a".repeat(63))).toBe(false);
    expect(isRepoId("zz")).toBe(false);
  });
});

describe("normalizeAbsolute", () => {
  test("resolves a relative path against the base", () => {
    const out = normalizeAbsolute("/base/dir", "../other");
    // realpath may fail for the non-existent path → falls back to a resolved absolute.
    expect(out.replace(/\\/g, "/")).toMatch(/\/base\/other$|^[A-Za-z]:\/base\/other$/);
  });
});
