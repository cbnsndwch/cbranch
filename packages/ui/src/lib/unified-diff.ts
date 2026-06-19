// Reconstruct a unified-diff patch string from our structured DiffFile (REQ-STACK-020:
// react-diff-view is fed by parsed unified-diff patch text). The server already returns
// parsed hunks; this turns them back into the canonical `git diff` text that
// react-diff-view's `parseDiff` consumes.
//
// TOOLING NOTE: source written through the editor JSON-decodes, so a literal backslash or
// "\n" in a string literal would corrupt this file. The newline and the "No newline at end
// of file" marker are therefore built from char codes, never typed as escapes.

import { type DiffFile } from "@cbranch/rpc-contract";

const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const NO_NEWLINE_MARKER = `${BACKSLASH} No newline at end of file`;

const lineMarker = (kind: string): string => (kind === "add" ? "+" : kind === "delete" ? "-" : " ");

/** Serialize a single {@link DiffFile} into a unified-diff patch string. */
export const fileToUnifiedDiff = (file: DiffFile): string => {
  const oldPath = file.oldPath || file.newPath;
  const newPath = file.newPath || file.oldPath;
  const added = file.status === "added";
  const deleted = file.status === "deleted";

  const out: string[] = [`diff --git a/${oldPath} b/${newPath}`];
  out.push(`--- ${added ? "/dev/null" : `a/${oldPath}`}`);
  out.push(`+++ ${deleted ? "/dev/null" : `b/${newPath}`}`);

  for (const hunk of file.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.kind === "noNewlineAtEof") {
        out.push(NO_NEWLINE_MARKER);
        continue;
      }
      out.push(`${lineMarker(line.kind)}${line.content}`);
    }
  }

  return out.join(NL);
};
