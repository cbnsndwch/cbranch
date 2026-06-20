import { type DiffFile, type PatchSelection } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { diffWorkingFile } from "./diff";
import { gitError } from "./errors";
import { runGit, runGitOk, decodeUtf8 } from "./run-git";

const BACKSLASH = String.fromCharCode(92);
const NL = "\n";

export const buildPatch = (
  diffFile: DiffFile,
  selection: PatchSelection,
): string => {
  if (diffFile.isBinary) throw new Error("binary file");

  const path = selection.path;
  const lines: string[] = [];

  lines.push("diff --git a/" + path + " b/" + path);

  if (diffFile.status === "added") {
    if (diffFile.newMode) lines.push("new file mode " + diffFile.newMode);
    lines.push("--- /dev/null");
    lines.push("+++ b/" + path);
  } else if (diffFile.status === "deleted") {
    if (diffFile.oldMode) lines.push("deleted file mode " + diffFile.oldMode);
    lines.push("--- a/" + path);
    lines.push("+++ /dev/null");
  } else {
    if (
      diffFile.oldMode &&
      diffFile.newMode &&
      diffFile.oldMode !== diffFile.newMode
    ) {
      lines.push("old mode " + diffFile.oldMode);
      lines.push("new mode " + diffFile.newMode);
    }
    lines.push("--- a/" + path);
    lines.push("+++ b/" + path);
  }

  for (const sel of selection.hunks) {
    const hunk = diffFile.hunks.find(
      (h) => h.oldStart === sel.oldStart && h.newStart === sel.newStart,
    );
    if (hunk === undefined) continue;

    const selectedSet = new Set(sel.selectedLines);
    const selectAll = sel.selectedLines.length === 0;

    const bodyLines: string[] = [];
    let oldCount = 0;
    let newCount = 0;

    for (let i = 0; i < hunk.lines.length; i++) {
      const dl = hunk.lines[i];
      if (dl === undefined) continue;

      if (dl.kind === "context") {
        bodyLines.push(" " + dl.content);
        oldCount += 1;
        newCount += 1;
      } else if (dl.kind === "noNewlineAtEof") {
        bodyLines.push(BACKSLASH + " No newline at end of file");
      } else if (dl.kind === "add") {
        if (selectAll || selectedSet.has(i)) {
          bodyLines.push("+" + dl.content);
          newCount += 1;
        }
        // unselected add: drop entirely
      } else if (dl.kind === "delete") {
        if (selectAll || selectedSet.has(i)) {
          bodyLines.push("-" + dl.content);
          oldCount += 1;
        } else {
          // unselected delete: convert to context
          bodyLines.push(" " + dl.content);
          oldCount += 1;
          newCount += 1;
        }
      }
    }

    lines.push(
      "@@ -" +
        hunk.oldStart +
        "," +
        oldCount +
        " +" +
        hunk.newStart +
        "," +
        newCount +
        " @@",
    );
    for (const bl of bodyLines) lines.push(bl);
  }

  return lines.join(NL) + NL;
};

const applyPatch = (
  cwd: string,
  patch: string,
  extraArgs: ReadonlyArray<string>,
): Effect.Effect<void, import("@cbranch/rpc-contract").GitError> =>
  Effect.gen(function* () {
    const stdin = Buffer.from(patch, "utf8");
    const checkResult = yield* runGit({
      cwd,
      args: ["apply", "--check", "--recount", ...extraArgs, "-"],
      read: false,
      stdin,
    });
    if (checkResult.exitCode !== 0) {
      return yield* Effect.fail(
        gitError(
          "gitFailed",
          "patch check failed: " + decodeUtf8(checkResult.stderr).slice(0, 200),
        ),
      );
    }
    yield* runGitOk({
      cwd,
      args: ["apply", "--recount", ...extraArgs, "-"],
      read: false,
      stdin,
    });
  });

export const stageHunks = (
  cwd: string,
  selection: PatchSelection,
): Effect.Effect<void, import("@cbranch/rpc-contract").GitError> =>
  Effect.gen(function* () {
    const diffFile = yield* diffWorkingFile(cwd, selection.path, false);
    if (diffFile.isBinary)
      return yield* Effect.fail(
        gitError("gitFailed", "cannot partial-stage binary file"),
      );
    yield* applyPatch(cwd, buildPatch(diffFile, selection), ["--cached"]);
  });

export const unstageHunks = (
  cwd: string,
  selection: PatchSelection,
): Effect.Effect<void, import("@cbranch/rpc-contract").GitError> =>
  Effect.gen(function* () {
    const diffFile = yield* diffWorkingFile(cwd, selection.path, true);
    if (diffFile.isBinary)
      return yield* Effect.fail(
        gitError("gitFailed", "cannot partial-stage binary file"),
      );
    yield* applyPatch(cwd, buildPatch(diffFile, selection), [
      "--reverse",
      "--cached",
    ]);
  });

export const discardHunks = (
  cwd: string,
  selection: PatchSelection,
): Effect.Effect<void, import("@cbranch/rpc-contract").GitError> =>
  Effect.gen(function* () {
    const diffFile = yield* diffWorkingFile(cwd, selection.path, false);
    if (diffFile.isBinary)
      return yield* Effect.fail(
        gitError("gitFailed", "cannot partial-stage binary file"),
      );
    yield* applyPatch(cwd, buildPatch(diffFile, selection), ["--reverse"]);
  });
