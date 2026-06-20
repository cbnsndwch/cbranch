import { DiffFile } from "@cbranch/rpc-contract";
import { parseDiff } from "react-diff-view";
import { describe, expect, test } from "vitest";

import { fileToUnifiedDiff } from "./unified-diff";

const NL = String.fromCharCode(10);

const mkFile = (over: Partial<DiffFile> & { newPath: string }): DiffFile =>
  new DiffFile({
    oldPath: over.oldPath ?? over.newPath,
    newPath: over.newPath,
    status: over.status ?? "modified",
    isBinary: false,
    additions: over.additions ?? 1,
    deletions: over.deletions ?? 1,
    hunks: over.hunks ?? [],
  });

describe("fileToUnifiedDiff (REQ-STACK-020)", () => {
  test("emits git headers and a hunk that react-diff-view can parse", () => {
    const file = mkFile({
      newPath: "src/a.ts",
      hunks: [
        {
          header: "@@ -1,2 +1,3 @@",
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          lines: [
            { kind: "context", content: "keep" },
            { kind: "delete", content: "old" },
            { kind: "add", content: "new1" },
            { kind: "add", content: "new2" },
          ],
        },
      ],
    });
    const text = fileToUnifiedDiff(file);
    expect(text.startsWith("diff --git a/src/a.ts b/src/a.ts")).toBe(true);
    expect(text).toContain(`${NL}-old`);
    expect(text).toContain(`${NL}+new1`);
    expect(text).toContain(" keep");

    const [parsed] = parseDiff(text);
    expect(parsed).toBeTruthy();
    expect(parsed!.hunks).toHaveLength(1);
    const changes = parsed!.hunks[0]!.changes;
    expect(changes.filter((c) => c.type === "insert")).toHaveLength(2);
    expect(changes.filter((c) => c.type === "delete")).toHaveLength(1);
  });

  test("added/deleted files use /dev/null on the right side", () => {
    expect(
      fileToUnifiedDiff(mkFile({ newPath: "n.ts", status: "added" })),
    ).toContain("--- /dev/null");
    expect(
      fileToUnifiedDiff(mkFile({ newPath: "g.ts", status: "deleted" })),
    ).toContain("+++ /dev/null");
  });

  test("a no-newline-at-eof line emits the marker", () => {
    const file = mkFile({
      newPath: "x",
      hunks: [
        {
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "add", content: "z" },
            { kind: "noNewlineAtEof", content: "" },
          ],
        },
      ],
    });
    expect(fileToUnifiedDiff(file)).toContain("No newline at end of file");
  });
});
