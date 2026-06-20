import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";
import { parseStatusOutput, statusGet } from "./status";

const NUL = String.fromCharCode(0);

const buf = (s: string): Buffer => Buffer.from(s, "utf8");

describe("parseStatusOutput", () => {
  test("ordinary modified unstaged", () => {
    const out = parseStatusOutput(
      buf(
        "1 .M N... 100644 100644 100644 aabbccdd0000000000000000000000000000000000 aabbccdd0000000000000000000000000000000000 file.txt" +
          NUL,
      ),
    );
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e?.path).toBe("file.txt");
    expect(e?.staged).toBe("unmodified");
    expect(e?.unstaged).toBe("modified");
    expect(e?.isConflicted).toBe(false);
    expect(e?.isUntracked).toBe(false);
    expect(e?.isIgnored).toBe(false);
    expect(e?.isSubmodule).toBe(false);
  });

  test("ordinary staged+unstaged (mixed)", () => {
    const out = parseStatusOutput(
      buf(
        "1 MM N... 100644 100644 100644 aaa0000000000000000000000000000000000000000 bbb0000000000000000000000000000000000000000 mixed.txt" +
          NUL,
      ),
    );
    const e = out.entries[0];
    expect(e?.staged).toBe("modified");
    expect(e?.unstaged).toBe("modified");
  });

  test("staged rename with similarity", () => {
    const out = parseStatusOutput(
      buf(
        "2 R. N... 100644 100644 100644 aaa0000000000000000000000000000000000000000 bbb0000000000000000000000000000000000000000 R100 new.txt" +
          NUL +
          "old.txt" +
          NUL,
      ),
    );
    expect(out.entries).toHaveLength(1);
    const e = out.entries[0];
    expect(e?.path).toBe("new.txt");
    expect(e?.origPath).toBe("old.txt");
    expect(e?.staged).toBe("renamed");
    expect(e?.unstaged).toBe("unmodified");
    expect(e?.similarity).toBe(100);
  });

  test("conflicted entry sets isConflicted and hasConflicts", () => {
    const out = parseStatusOutput(buf("u UU N... 100644 100644 100644 100644 aaa bbb ccc ddd conflict.txt" + NUL));
    expect(out.hasConflicts).toBe(true);
    const e = out.entries[0];
    expect(e?.isConflicted).toBe(true);
    expect(e?.path).toBe("conflict.txt");
    expect(e?.staged).toBe("updatedButUnmerged");
    expect(e?.unstaged).toBe("updatedButUnmerged");
  });

  test("untracked entry", () => {
    const out = parseStatusOutput(buf("? untracked.txt" + NUL));
    const e = out.entries[0];
    expect(e?.path).toBe("untracked.txt");
    expect(e?.staged).toBe("unmodified");
    expect(e?.unstaged).toBe("untracked");
    expect(e?.isUntracked).toBe(true);
    expect(e?.isIgnored).toBe(false);
  });

  test("ignored entry", () => {
    const out = parseStatusOutput(buf("! ignored.log" + NUL));
    const e = out.entries[0];
    expect(e?.path).toBe("ignored.log");
    expect(e?.staged).toBe("unmodified");
    expect(e?.unstaged).toBe("ignored");
    expect(e?.isIgnored).toBe(true);
    expect(e?.isUntracked).toBe(false);
  });

  test("branch headers fully parsed", () => {
    const out = parseStatusOutput(
      buf(
        "# branch.oid abc123def4560000000000000000000000000000" +
          NUL +
          "# branch.head main" +
          NUL +
          "# branch.upstream origin/main" +
          NUL +
          "# branch.ab +2 -1" +
          NUL,
      ),
    );
    expect(out.branch).toBeDefined();
    expect(out.branch?.head).toBe("main");
    expect(out.branch?.oid).toBe("abc123def4560000000000000000000000000000");
    expect(out.branch?.upstream).toBe("origin/main");
    expect(out.branch?.ahead).toBe(2);
    expect(out.branch?.behind).toBe(1);
  });

  test("non-ASCII path (AC-9)", () => {
    const out = parseStatusOutput(buf("? café/héllo.txt" + NUL));
    expect(out.entries[0]?.path).toBe("café/héllo.txt");
  });

  test("path with spaces", () => {
    const out = parseStatusOutput(buf("1 .M N... 100644 100644 100644 aaa bbb my file with spaces.txt" + NUL));
    expect(out.entries[0]?.path).toBe("my file with spaces.txt");
  });

  test("submodule entry sets isSubmodule", () => {
    const out = parseStatusOutput(
      buf(
        "1 .M S... 100644 100644 100644 aaa0000000000000000000000000000000000000000 bbb0000000000000000000000000000000000000000 submod" +
          NUL,
      ),
    );
    expect(out.entries[0]?.isSubmodule).toBe(true);
  });

  test("initial repo (no HEAD) has no branch oid", () => {
    const out = parseStatusOutput(buf("# branch.oid (initial)" + NUL + "# branch.head main" + NUL));
    expect(out.branch?.oid).toBeUndefined();
    expect(out.branch?.head).toBe("main");
    expect(out.entries).toHaveLength(0);
  });

  test("hasConflicts is false when no conflicted entries", () => {
    const out = parseStatusOutput(buf("? untracked.txt" + NUL));
    expect(out.hasConflicts).toBe(false);
  });

  test("mode fields parsed — staged mode present, worktree mode 000000 becomes undefined", () => {
    const out = parseStatusOutput(
      buf(
        "1 A. N... 000000 100644 000000 0000000000000000000000000000000000000000 aaa0000000000000000000000000000000000000000 staged-new.txt" +
          NUL,
      ),
    );
    const e = out.entries[0];
    expect(e?.staged).toBe("added");
    expect(e?.stagedMode).toBe("100644");
    expect(e?.worktreeMode).toBeUndefined();
  });
});

describe("statusGet (integration)", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("AC-1 — returns live status from a real repo (modified + untracked)", async () => {
    const repo = await ws.createRepo("status-live");
    await repo.commit({ message: "init", files: { "a.txt": "original" } });
    await repo.writeFile("a.txt", "changed");
    await repo.writeFile("new.txt", "untracked");

    const result = await Effect.runPromise(statusGet(repo.dir));

    const modified = result.entries.find((e) => e.path === "a.txt");
    expect(modified).toBeDefined();
    expect(modified?.unstaged).toBe("modified");

    const untracked = result.entries.find((e) => e.path === "new.txt");
    expect(untracked).toBeDefined();
    expect(untracked?.isUntracked).toBe(true);

    expect(result.branch?.head).toBe("main");
    expect(result.hasConflicts).toBe(false);
  });
});
