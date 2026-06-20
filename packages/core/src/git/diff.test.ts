import { describe, expect, test } from "vitest";

import {
  buildDiffFiles,
  mapStatusLetter,
  parseNameStatus,
  parseNumstat,
  parsePatch,
} from "./diff";

describe("mapStatusLetter", () => {
  test("maps every git status letter to a ChangeCode", () => {
    expect(mapStatusLetter("A")).toBe("added");
    expect(mapStatusLetter("M")).toBe("modified");
    expect(mapStatusLetter("D")).toBe("deleted");
    expect(mapStatusLetter("R")).toBe("renamed");
    expect(mapStatusLetter("C")).toBe("copied");
    expect(mapStatusLetter("T")).toBe("typeChanged");
    expect(mapStatusLetter("U")).toBe("updatedButUnmerged");
    expect(mapStatusLetter("?")).toBe("modified"); // unknown ⇒ modified default
  });
});

describe("parseNameStatus (-z)", () => {
  test("parses plain M/A/D records", () => {
    const buf = Buffer.from("M\0a.txt\0A\0b.txt\0D\0keep.txt\0", "utf8");
    expect(parseNameStatus(buf)).toEqual([
      { status: "modified", oldPath: "a.txt", newPath: "a.txt" },
      { status: "added", oldPath: "b.txt", newPath: "b.txt" },
      { status: "deleted", oldPath: "keep.txt", newPath: "keep.txt" },
    ]);
  });

  test("parses rename (3-token) records with both paths", () => {
    const buf = Buffer.from(
      "R100\0b.txt\0b2.txt\0A\0bin.dat\0R100\0a.txt\0renamed.txt\0",
      "utf8",
    );
    expect(parseNameStatus(buf)).toEqual([
      { status: "renamed", oldPath: "b.txt", newPath: "b2.txt" },
      { status: "added", oldPath: "bin.dat", newPath: "bin.dat" },
      { status: "renamed", oldPath: "a.txt", newPath: "renamed.txt" },
    ]);
  });
});

describe("parseNumstat (-z)", () => {
  test("parses plain counts", () => {
    const buf = Buffer.from(
      ["2\t1\ta.txt", "1\t0\tb.txt", "0\t1\tkeep.txt", ""].join("\0"),
      "utf8",
    );
    const out = parseNumstat(buf);
    expect(out).toEqual([
      { additions: 2, deletions: 1, oldPath: "a.txt", newPath: "a.txt" },
      { additions: 1, deletions: 0, oldPath: "b.txt", newPath: "b.txt" },
      { additions: 0, deletions: 1, oldPath: "keep.txt", newPath: "keep.txt" },
    ]);
  });

  test("parses rename (split path) and binary (-/-) records", () => {
    const buf = Buffer.from("0\t0\t\0b.txt\0b2.txt\0-\t-\tbin.dat\0", "utf8");
    expect(parseNumstat(buf)).toEqual([
      { additions: 0, deletions: 0, oldPath: "b.txt", newPath: "b2.txt" },
      {
        additions: null,
        deletions: null,
        oldPath: "bin.dat",
        newPath: "bin.dat",
      },
    ]);
  });
});

describe("parsePatch", () => {
  test("parses hunks with addressable old/new line numbers + index oids", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 83db48f..e0c9b5e 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-line2",
      "+CHANGED",
      " line3",
      "+line4",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.oldOid).toBe("83db48f");
    expect(file.newOid).toBe("e0c9b5e");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(
      hunk.lines.map((l) => [l.kind, l.oldLineNo, l.newLineNo, l.content]),
    ).toEqual([
      ["context", 1, 1, "line1"],
      ["delete", 2, undefined, "line2"],
      ["add", undefined, 2, "CHANGED"],
      ["context", 3, 3, "line3"],
      ["add", undefined, 4, "line4"],
    ]);
  });

  test("detects binary and added/deleted file modes", () => {
    const patch = [
      "diff --git a/bin.dat b/bin.dat",
      "new file mode 100644",
      "index 0000000..46e18fe",
      "Binary files /dev/null and b/bin.dat differ",
      "diff --git a/keep.txt b/keep.txt",
      "deleted file mode 100644",
      "index 2fa992c..0000000",
      "--- a/keep.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-keep",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const files = parsePatch(patch);
    expect(files).toHaveLength(2);
    expect(files[0]!.isBinary).toBe(true);
    expect(files[0]!.newMode).toBe("100644");
    expect(files[1]!.oldMode).toBe("100644");
    const last = files[1]!.hunks[0]!.lines;
    expect(last[0]!.kind).toBe("delete");
    expect(last[1]!.kind).toBe("noNewlineAtEof");
  });
});

describe("buildDiffFiles", () => {
  test("zips name-status + numstat + patch by order; binary ⇒ null counts + empty hunks", () => {
    const nameStatus = parseNameStatus(
      Buffer.from("M\0a.txt\0A\0bin.dat\0", "utf8"),
    );
    const numstat = parseNumstat(
      Buffer.from("2\t1\ta.txt\0-\t-\tbin.dat\0", "utf8"),
    );
    const patch = parsePatch(
      [
        "diff --git a/a.txt b/a.txt",
        "index 1111111..2222222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "diff --git a/bin.dat b/bin.dat",
        "new file mode 100644",
        "index 0000000..3333333",
        "Binary files /dev/null and b/bin.dat differ",
        "",
      ].join("\n"),
    );
    const files = buildDiffFiles(nameStatus, numstat, patch);
    expect(files).toHaveLength(2);
    expect(files[0]!.status).toBe("modified");
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);
    expect(files[0]!.oldOid).toBe("1111111");
    expect(files[0]!.hunks).toHaveLength(1);

    expect(files[1]!.status).toBe("added");
    expect(files[1]!.isBinary).toBe(true);
    expect(files[1]!.additions).toBeNull();
    expect(files[1]!.deletions).toBeNull();
    expect(files[1]!.hunks).toHaveLength(0);
    expect(files[1]!.oldOid).toBeUndefined(); // all-zero oid ⇒ absent
  });
});
