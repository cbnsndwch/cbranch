import { StatusEntry, WorkingTreeStatus } from "@cbranch/rpc-contract";
import { describe, expect, test } from "vitest";

import {
  groupStatusEntries,
  hasStagedChanges,
  hasUnstagedChanges,
  isStagedChange,
  isUnstagedChange,
  statusLabel,
} from "./status";

const makeEntry = (overrides: Partial<StatusEntry>): StatusEntry =>
  new StatusEntry({
    path: "file.ts",
    staged: "unmodified",
    unstaged: "unmodified",
    isConflicted: false,
    isUntracked: false,
    isIgnored: false,
    isSubmodule: false,
    ...overrides,
  });

const makeStatus = (entries: StatusEntry[]): WorkingTreeStatus =>
  new WorkingTreeStatus({ entries, hasConflicts: false });

describe("isStagedChange", () => {
  test("returns true for staged modified", () => {
    expect(isStagedChange(makeEntry({ staged: "modified" }))).toBe(true);
  });
  test("returns true for staged added", () => {
    expect(isStagedChange(makeEntry({ staged: "added" }))).toBe(true);
  });
  test("returns false for unmodified staged side", () => {
    expect(isStagedChange(makeEntry({ staged: "unmodified" }))).toBe(false);
  });
});

describe("isUnstagedChange", () => {
  test("returns true for worktree modified", () => {
    expect(isUnstagedChange(makeEntry({ unstaged: "modified" }))).toBe(true);
  });
  test("returns true for untracked even with unmodified unstaged", () => {
    expect(isUnstagedChange(makeEntry({ unstaged: "unmodified", isUntracked: true }))).toBe(true);
  });
  test("returns false for clean entry", () => {
    expect(isUnstagedChange(makeEntry({}))).toBe(false);
  });
});

describe("groupStatusEntries", () => {
  test("staged entry appears only in staged group", () => {
    const e = makeEntry({ staged: "added" });
    const { staged, unstaged } = groupStatusEntries([e]);
    expect(staged).toContain(e);
    expect(unstaged).not.toContain(e);
  });

  test("unstaged entry appears only in unstaged group", () => {
    const e = makeEntry({ unstaged: "modified" });
    const { staged, unstaged } = groupStatusEntries([e]);
    expect(staged).not.toContain(e);
    expect(unstaged).toContain(e);
  });

  test("mixed-state entry appears in both groups", () => {
    const e = makeEntry({ staged: "modified", unstaged: "modified" });
    const { staged, unstaged } = groupStatusEntries([e]);
    expect(staged).toContain(e);
    expect(unstaged).toContain(e);
  });

  test("clean entry appears in neither group", () => {
    const e = makeEntry({});
    const { staged, unstaged } = groupStatusEntries([e]);
    expect(staged).not.toContain(e);
    expect(unstaged).not.toContain(e);
  });
});

describe("statusLabel", () => {
  test("modified returns 'modified'", () => {
    expect(statusLabel(makeEntry({ unstaged: "modified" }))).toBe("modified");
  });
  test("staged added returns 'new file'", () => {
    expect(statusLabel(makeEntry({ staged: "added" }))).toBe("new file");
  });
  test("deleted returns 'deleted'", () => {
    expect(statusLabel(makeEntry({ unstaged: "deleted" }))).toBe("deleted");
  });
  test("renamed with origPath returns 'renamed → origPath'", () => {
    expect(statusLabel(makeEntry({ staged: "renamed", origPath: "old.ts" }))).toBe("renamed → old.ts");
  });
  test("renamed without origPath falls back to path", () => {
    expect(statusLabel(makeEntry({ staged: "renamed", path: "new.ts" }))).toBe("renamed → new.ts");
  });
  test("conflict returns 'conflict'", () => {
    expect(statusLabel(makeEntry({ staged: "updatedButUnmerged" }))).toBe("conflict");
  });
  test("untracked returns 'untracked'", () => {
    expect(statusLabel(makeEntry({ unstaged: "untracked", isUntracked: true }))).toBe("untracked");
  });
  test("prefers staged side when staged change present", () => {
    // staged=added, unstaged=modified → should show "new file"
    expect(statusLabel(makeEntry({ staged: "added", unstaged: "modified" }))).toBe("new file");
  });
});

describe("hasStagedChanges / hasUnstagedChanges", () => {
  test("hasStagedChanges is true when at least one entry is staged", () => {
    const status = makeStatus([makeEntry({ staged: "modified" })]);
    expect(hasStagedChanges(status)).toBe(true);
  });
  test("hasStagedChanges is false when nothing staged", () => {
    const status = makeStatus([makeEntry({ unstaged: "modified" })]);
    expect(hasStagedChanges(status)).toBe(false);
  });
  test("hasUnstagedChanges is true for untracked", () => {
    const status = makeStatus([makeEntry({ isUntracked: true, unstaged: "untracked" })]);
    expect(hasUnstagedChanges(status)).toBe(true);
  });
  test("hasUnstagedChanges is false for clean status", () => {
    const status = makeStatus([makeEntry({})]);
    expect(hasUnstagedChanges(status)).toBe(false);
  });
});
