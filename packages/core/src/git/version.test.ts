import { GitError } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  atLeast,
  classifyVersionOutput,
  detectGitVersion,
  type GitVersion,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
  parseGitVersion,
} from "./version";

describe("parseGitVersion", () => {
  test("parses a standard version line", () => {
    expect(parseGitVersion("git version 2.54.0")).toEqual({ raw: "git version 2.54.0", major: 2, minor: 54, patch: 0 });
  });

  test("parses a vendor-suffixed Windows version", () => {
    const v = parseGitVersion("git version 2.43.1.windows.1");
    expect(v).toMatchObject({ major: 2, minor: 43, patch: 1 });
  });

  test("returns null for unparseable output", () => {
    expect(parseGitVersion("not a version")).toBeNull();
  });
});

const v = (major: number, minor: number): GitVersion => ({ raw: "", major, minor, patch: 0 });

describe("atLeast", () => {
  test("true above and at the floor, false below", () => {
    expect(atLeast(v(2, 54), MIN_GIT_MAJOR, MIN_GIT_MINOR)).toBe(true);
    expect(atLeast(v(2, 37), 2, 37)).toBe(true);
    expect(atLeast(v(2, 36), 2, 37)).toBe(false);
    expect(atLeast(v(1, 99), 2, 37)).toBe(false);
  });
});

describe("classifyVersionOutput (NF-PKG-5 gate branches)", () => {
  test("non-zero exit → hostGitMissing", () => {
    const r = classifyVersionOutput(1, "");
    expect(r).toBeInstanceOf(GitError);
    expect((r as GitError).code).toBe("hostGitMissing");
  });

  test("unparseable stdout → hostGitMissing", () => {
    expect((classifyVersionOutput(0, "garbage") as GitError).code).toBe("hostGitMissing");
  });

  test("below floor → hostGitTooOld", () => {
    const r = classifyVersionOutput(0, "git version 2.30.0");
    expect(r).toBeInstanceOf(GitError);
    expect((r as GitError).code).toBe("hostGitTooOld");
  });

  test("at/above floor → GitVersion", () => {
    const r = classifyVersionOutput(0, "git version 2.40.1");
    expect(r).not.toBeInstanceOf(GitError);
    expect((r as GitVersion).minor).toBe(40);
  });
});

describe("detectGitVersion (real host git)", () => {
  test("succeeds and meets the 2.37 floor on this host", async () => {
    const detected = await run(detectGitVersion(process.cwd()));
    expect(atLeast(detected, MIN_GIT_MAJOR, MIN_GIT_MINOR)).toBe(true);
  });
});
