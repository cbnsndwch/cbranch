import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DiffFile,
  DiffLine,
  Hunk,
  HunkSelection,
  PatchSelection,
} from "@cbranch/rpc-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import { diffWorkingFile } from "./diff";
import { buildPatch, discardHunks, stageHunks, unstageHunks } from "./patch";

const makeHunk = (
  oldStart: number,
  newStart: number,
  lines: Array<{
    kind: "context" | "add" | "delete" | "noNewlineAtEof";
    content: string;
  }>,
): Hunk => {
  const diffLines = lines.map(
    (l) =>
      new DiffLine({
        kind: l.kind,
        content: l.content,
        oldLineNo: l.kind === "add" ? undefined : oldStart,
        newLineNo: l.kind === "delete" ? undefined : newStart,
      }),
  );
  return new Hunk({
    header: "@@ -" + oldStart + " +" + newStart + " @@",
    oldStart,
    oldLines: lines.filter((l) => l.kind !== "add").length,
    newStart,
    newLines: lines.filter((l) => l.kind !== "delete").length,
    lines: diffLines,
  });
};

const makeDiffFile = (
  path: string,
  status: "modified" | "added" | "deleted",
  hunks: Hunk[],
  opts?: { isBinary?: boolean; oldMode?: string; newMode?: string },
): DiffFile =>
  new DiffFile({
    oldPath: path,
    newPath: path,
    status,
    isBinary: opts?.isBinary ?? false,
    oldMode: opts?.oldMode,
    newMode: opts?.newMode,
    additions: null,
    deletions: null,
    hunks,
  });

// ── buildPatch unit tests ─────────────────────────────────────────────────────

describe("buildPatch", () => {
  test("select all lines (selectedLines empty)", () => {
    const hunk = makeHunk(1, 1, [
      { kind: "context", content: "ctx" },
      { kind: "delete", content: "old" },
      { kind: "add", content: "new" },
    ]);
    const df = makeDiffFile("a.txt", "modified", [hunk]);
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          selectedLines: [],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain(" ctx");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
    expect(patch).toContain("@@ -1,2 +1,2 @@");
  });

  test("select only add lines — deletes become context", () => {
    const hunk = makeHunk(1, 1, [
      { kind: "delete", content: "old" },
      { kind: "add", content: "new" },
    ]);
    const df = makeDiffFile("a.txt", "modified", [hunk]);
    // index 0=delete, index 1=add; select only index 1 (add)
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          selectedLines: [1],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).not.toContain("-old");
    expect(patch).toContain(" old"); // delete → context
    expect(patch).toContain("+new");
  });

  test("select only delete lines — adds are dropped", () => {
    const hunk = makeHunk(1, 1, [
      { kind: "delete", content: "old" },
      { kind: "add", content: "new" },
    ]);
    const df = makeDiffFile("a.txt", "modified", [hunk]);
    // select only index 0 (delete)
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          selectedLines: [0],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain("-old");
    expect(patch).not.toContain("+new");
    expect(patch).not.toContain(" new");
  });

  test("mixed selection — partial lines", () => {
    const hunk = makeHunk(1, 1, [
      { kind: "context", content: "ctx" },
      { kind: "add", content: "line1" },
      { kind: "add", content: "line2" },
    ]);
    const df = makeDiffFile("a.txt", "modified", [hunk]);
    // select only index 1 (add line1), not index 2 (add line2)
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 3,
          selectedLines: [1],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain("+line1");
    expect(patch).not.toContain("+line2");
    expect(patch).not.toContain(" line2");
  });

  test("new file patch — has new file mode and /dev/null", () => {
    const hunk = makeHunk(0, 1, [{ kind: "add", content: "hello" }]);
    const df = makeDiffFile("new.txt", "added", [hunk], { newMode: "100644" });
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "new.txt",
      hunks: [
        new HunkSelection({
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          selectedLines: [],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain("new file mode 100644");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/new.txt");
  });

  test("binary file throws", () => {
    const df = makeDiffFile("img.png", "modified", [], { isBinary: true });
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "img.png",
      hunks: [],
    });
    expect(() => buildPatch(df, sel)).toThrow("binary file");
  });

  test("context lines always appear regardless of selection", () => {
    const hunk = makeHunk(1, 1, [
      { kind: "context", content: "always" },
      { kind: "add", content: "optional" },
    ]);
    const df = makeDiffFile("a.txt", "modified", [hunk]);
    // select nothing (but selectedLines not empty means partial — select index 0 which is context, not add)
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          selectedLines: [0],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain(" always");
  });

  test("noNewlineAtEof always appears", () => {
    const hunk = makeHunk(1, 1, [
      { kind: "add", content: "last line no newline" },
      { kind: "noNewlineAtEof", content: "No newline at end of file" },
    ]);
    const df = makeDiffFile("a.txt", "modified", [hunk]);
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          selectedLines: [],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain("\\ No newline at end of file");
  });

  test("deleted file patch — has deleted file mode and /dev/null as target", () => {
    const hunk = makeHunk(1, 0, [{ kind: "delete", content: "goodbye" }]);
    const df = makeDiffFile("gone.txt", "deleted", [hunk], {
      oldMode: "100644",
    });
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "gone.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          selectedLines: [],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain("deleted file mode 100644");
    expect(patch).toContain("--- a/gone.txt");
    expect(patch).toContain("+++ /dev/null");
    expect(patch).toContain("-goodbye");
  });

  test("deleted file patch — no oldMode omits mode line", () => {
    const hunk = makeHunk(1, 0, [{ kind: "delete", content: "bye" }]);
    const df = makeDiffFile("gone.txt", "deleted", [hunk]);
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "gone.txt",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 0,
          newLines: 0,
          selectedLines: [],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).not.toContain("deleted file mode");
    expect(patch).toContain("+++ /dev/null");
  });

  test("mode change — emits old mode / new mode lines", () => {
    const hunk = makeHunk(1, 1, [{ kind: "context", content: "same" }]);
    const df = makeDiffFile("script.sh", "modified", [hunk], {
      oldMode: "100644",
      newMode: "100755",
    });
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "script.sh",
      hunks: [
        new HunkSelection({
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          selectedLines: [],
        }),
      ],
    });
    const patch = buildPatch(df, sel);
    expect(patch).toContain("old mode 100644");
    expect(patch).toContain("new mode 100755");
  });
});

// ── integration tests ─────────────────────────────────────────────────────────

describe("patch git operations", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  test("stageHunks stages selected hunk", async () => {
    const repo = await ws.createRepo("stage-hunks-basic");
    await repo.commit({
      message: "init",
      files: { "a.txt": "line1\nline2\nline3\n" },
    });
    await repo.writeFile("a.txt", "line1\nline2-modified\nline3\n");

    const diffFile = await run(diffWorkingFile(repo.dir, "a.txt", false));
    expect(diffFile.hunks.length).toBeGreaterThan(0);
    const h = diffFile.hunks[0]!;
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          selectedLines: [],
        }),
      ],
    });

    await run(stageHunks(repo.dir, sel));

    const cached = await repo.git(["diff", "--cached", "--name-only"]);
    expect(cached.stdout).toContain("a.txt");
  });

  test("stageHunks — partial: only selected lines staged", async () => {
    const repo = await ws.createRepo("stage-hunks-partial");
    // Two separate hunks by spacing changes far apart
    await repo.commit({
      message: "init",
      files: {
        "b.txt":
          "aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj\nkkk\nlll\nmmm\nnnn\nooo\nppp\n",
      },
    });
    // Modify line 1 and line 15 (far enough apart to be separate hunks)
    await repo.writeFile(
      "b.txt",
      "AAA\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj\nkkk\nlll\nmmm\nnnn\nOOO\nppp\n",
    );

    const diffFile = await run(diffWorkingFile(repo.dir, "b.txt", false));
    // There should be 2 hunks; stage only the first
    const h = diffFile.hunks[0]!;
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "b.txt",
      hunks: [
        new HunkSelection({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          selectedLines: [],
        }),
      ],
    });

    await run(stageHunks(repo.dir, sel));

    const cachedDiff = await repo.git(["diff", "--cached"]);
    expect(cachedDiff.stdout).toContain("+AAA");
    // The second change should not be staged
    expect(cachedDiff.stdout).not.toContain("+OOO");
  });

  test("unstageHunks removes staged changes", async () => {
    const repo = await ws.createRepo("unstage-hunks");
    await repo.commit({
      message: "init",
      files: { "a.txt": "line1\nline2\nline3\n" },
    });
    await repo.writeFile("a.txt", "line1\nline2-changed\nline3\n");
    await repo.stage("a.txt");

    const diffFile = await run(diffWorkingFile(repo.dir, "a.txt", true));
    const h = diffFile.hunks[0]!;
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          selectedLines: [],
        }),
      ],
    });

    await run(unstageHunks(repo.dir, sel));

    const cached = await repo.git(["diff", "--cached", "--name-only"]);
    expect(cached.stdout.trim()).toBe("");
  });

  test("discardHunks reverts worktree change", async () => {
    const repo = await ws.createRepo("discard-hunks");
    await repo.commit({ message: "init", files: { "a.txt": "original\n" } });
    await repo.writeFile("a.txt", "modified\n");

    const diffFile = await run(diffWorkingFile(repo.dir, "a.txt", false));
    const h = diffFile.hunks[0]!;
    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "a.txt",
      hunks: [
        new HunkSelection({
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          selectedLines: [],
        }),
      ],
    });

    await run(discardHunks(repo.dir, sel));

    const content = await readFile(join(repo.dir, "a.txt"), "utf8");
    expect(content).toBe("original\n");
  });

  test("stageHunks rejects binary files", async () => {
    const repo = await ws.createRepo("stage-hunks-binary");
    await repo.commit({ message: "init", files: { "file.bin": "text\n" } });
    // Write a binary-ish content (null byte makes git treat it as binary)
    const { writeFile: writeBinary } = await import("node:fs/promises");
    await writeBinary(
      join(repo.dir, "file.bin"),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    );

    const sel = new PatchSelection({
      repoId: "r" as never,
      path: "file.bin",
      hunks: [],
    });

    await expect(run(stageHunks(repo.dir, sel))).rejects.toThrow();
  });
});
