// Diffs & changed-file lists — `commit.diff` / `diff.workingFile` (docs/spec/05 §2.6;
// DM-060/061/062; DECISIONS D7).
//
// A per-file diff is assembled from THREE parallel git outputs over the same tree pair
// and the same rename/whitespace flags (so all three stay aligned, one entry per file in
// the same order):
//   • `--name-status -z` → authoritative status letter + old/new path (renames/copies),
//   • `--numstat -z`     → additions/deletions (binary ⇒ `-`/`-`) + binary detection,
//   • `-p` unified patch → modes, blob oids, and the addressable hunks/lines.
// Binary files carry empty hunks and `additions`/`deletions = null`; gitlinks surface via
// the `160000` mode; a root commit diffs against the empty tree (`--root`).

import {
  type ChangeCode,
  type DiffFile as DiffFileType,
  type DiffSpec,
  type GitError,
} from "@cbranch/rpc-contract";
import {
  DiffFile,
  DiffLine,
  Hunk,
  Oid as OidBrand,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { assertNoLeadingDash, decodeUtf8, runGitOk } from "./run-git";

// ── status mapping ───────────────────────────────────────────────────────────

/** Map a `git` status letter (A/M/D/R/C/T/U/X) to the closed {@link ChangeCode} set (DM-051). */
export const mapStatusLetter = (letter: string): ChangeCode => {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "typeChanged";
    case "U":
      return "updatedButUnmerged";
    case "M":
    default:
      return "modified";
  }
};

// ── name-status (-z) ─────────────────────────────────────────────────────────

export interface NameStatusEntry {
  readonly status: ChangeCode;
  readonly oldPath: string;
  readonly newPath: string;
}

/**
 * Parse `--name-status -z`: a flat NUL-token stream. A rename/copy record is
 * `R<score>\0<old>\0<new>`; every other record is `<X>\0<path>`.
 */
export const parseNameStatus = (
  stdout: Buffer,
): ReadonlyArray<NameStatusEntry> => {
  const tokens = decodeUtf8(stdout).split("\0");
  const out: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (code === undefined || code === "") {
      i += 1;
      continue;
    }
    const letter = code.charAt(0);
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      out.push({ status: mapStatusLetter(letter), oldPath, newPath });
      i += 3;
    } else {
      const path = tokens[i + 1] ?? "";
      out.push({
        status: mapStatusLetter(letter),
        oldPath: path,
        newPath: path,
      });
      i += 2;
    }
  }
  return out;
};

// ── numstat (-z) ─────────────────────────────────────────────────────────────

export interface NumstatEntry {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly oldPath: string;
  readonly newPath: string;
}

/**
 * Parse `--numstat -z`. A normal record is one token `add\tdel\tpath`; a rename record
 * is `add\tdel\t` followed by two path tokens (`old`, `new`). Binary files report `-`.
 */
export const parseNumstat = (stdout: Buffer): ReadonlyArray<NumstatEntry> => {
  const tokens = decodeUtf8(stdout).split("\0");
  const out: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === undefined || token === "") {
      i += 1;
      continue;
    }
    const parts = token.split("\t");
    if (parts.length < 3) {
      i += 1;
      continue;
    }
    const [addRaw, delRaw, pathPart] = parts as [string, string, string];
    const additions = addRaw === "-" ? null : Number(addRaw);
    const deletions = delRaw === "-" ? null : Number(delRaw);
    if (pathPart === "") {
      // Rename: the path is split across the next two NUL tokens.
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      out.push({ additions, deletions, oldPath, newPath });
      i += 3;
    } else {
      out.push({ additions, deletions, oldPath: pathPart, newPath: pathPart });
      i += 1;
    }
  }
  return out;
};

// ── unified patch ──────────────────────────────────────────────────────────────

export interface PatchFile {
  oldMode?: string;
  newMode?: string;
  oldOid?: string;
  newOid?: string;
  isBinary: boolean;
  hunks: Hunk[];
}

const ZERO_OID = /^0+$/;
const ADD_MARKER = /\+/;
const DEL_MARKER = /-/;

/** Parse a `@@ -a,b +c,d @@` header (or combined `@@@ … @@@`). Counts default to 1. */
const parseHunkHeader = (
  line: string,
): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  markerWidth: number;
} | null => {
  const at = /^(@+)/.exec(line);
  if (at === null) return null;
  const atCount = (at[1] as string).length;
  const ranges = [...line.matchAll(/([-+])(\d+)(?:,(\d+))?/g)];
  if (ranges.length < 2) return null;
  const first = ranges[0] as RegExpMatchArray;
  const last = ranges[ranges.length - 1] as RegExpMatchArray;
  return {
    oldStart: Number(first[2]),
    oldLines: first[3] === undefined ? 1 : Number(first[3]),
    newStart: Number(last[2]),
    newLines: last[3] === undefined ? 1 : Number(last[3]),
    markerWidth: Math.max(1, atCount - 1), // 1 for a normal diff, N for an N-parent combined diff
  };
};

/**
 * Parse a unified diff into per-file {@link PatchFile} sections IN ORDER (one per
 * `diff --git` header). Hunk lines are individually addressable with their old/new line
 * numbers (DM-062). Combined (`--cc`) hunks are parsed leniently by marker column.
 */
export const parsePatch = (text: string): ReadonlyArray<PatchFile> => {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let markerWidth = 1;

  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] as string;
    if (line.startsWith("diff --git ")) {
      file = { isBinary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (file === null) continue;

    if (line.startsWith("@@")) {
      const parsed = parseHunkHeader(line);
      if (parsed === null) continue;
      oldNo = parsed.oldStart;
      newNo = parsed.newStart;
      markerWidth = parsed.markerWidth;
      hunk = new Hunk({
        header: line,
        oldStart: parsed.oldStart,
        oldLines: parsed.oldLines,
        newStart: parsed.newStart,
        newLines: parsed.newLines,
        lines: [],
      });
      file.hunks.push(hunk);
      continue;
    }

    if (
      hunk !== null &&
      (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
    ) {
      const marker = line.slice(0, markerWidth);
      const content = line.slice(markerWidth);
      const mutableLines = hunk.lines as DiffLine[];
      if (ADD_MARKER.test(marker)) {
        mutableLines.push(
          new DiffLine({ kind: "add", content, newLineNo: newNo }),
        );
        newNo += 1;
      } else if (DEL_MARKER.test(marker)) {
        mutableLines.push(
          new DiffLine({ kind: "delete", content, oldLineNo: oldNo }),
        );
        oldNo += 1;
      } else {
        mutableLines.push(
          new DiffLine({
            kind: "context",
            content,
            oldLineNo: oldNo,
            newLineNo: newNo,
          }),
        );
        oldNo += 1;
        newNo += 1;
      }
      continue;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" — applies to the preceding +/- line.
      if (hunk !== null)
        (hunk.lines as DiffLine[]).push(
          new DiffLine({ kind: "noNewlineAtEof", content: line.slice(2) }),
        );
      continue;
    }

    // Pre-hunk metadata lines.
    if (line.startsWith("Binary files ")) file.isBinary = true;
    else if (line.startsWith("old mode "))
      file.oldMode = line.slice("old mode ".length).trim();
    else if (line.startsWith("new mode "))
      file.newMode = line.slice("new mode ".length).trim();
    else if (line.startsWith("new file mode "))
      file.newMode = line.slice("new file mode ".length).trim();
    else if (line.startsWith("deleted file mode "))
      file.oldMode = line.slice("deleted file mode ".length).trim();
    else if (line.startsWith("index ")) {
      const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?/.exec(line);
      if (m !== null) {
        file.oldOid = m[1];
        file.newOid = m[2];
        if (m[3] !== undefined) {
          if (file.oldMode === undefined) file.oldMode = m[3];
          if (file.newMode === undefined) file.newMode = m[3];
        }
      }
    }
  }
  return files;
};

// ── assembly ─────────────────────────────────────────────────────────────────

const oidOrUndefined = (oid: string | undefined) =>
  oid === undefined || ZERO_OID.test(oid) ? undefined : OidBrand.make(oid);

/** Zip the three aligned outputs into ordered {@link DiffFile}s (DM-060). */
export const buildDiffFiles = (
  nameStatus: ReadonlyArray<NameStatusEntry>,
  numstat: ReadonlyArray<NumstatEntry>,
  patch: ReadonlyArray<PatchFile>,
): ReadonlyArray<DiffFile> =>
  nameStatus.map((ns, i) => {
    const num = numstat[i];
    const pf = patch[i];
    const isBinary =
      (num !== undefined && num.additions === null) || (pf?.isBinary ?? false);
    return new DiffFile({
      oldPath: ns.oldPath,
      newPath: ns.newPath,
      status: ns.status,
      isBinary,
      oldMode: pf?.oldMode,
      newMode: pf?.newMode,
      oldOid: oidOrUndefined(pf?.oldOid),
      newOid: oidOrUndefined(pf?.newOid),
      additions: isBinary ? null : (num?.additions ?? 0),
      deletions: isBinary ? null : (num?.deletions ?? 0),
      hunks: isBinary ? [] : (pf?.hunks ?? []),
    });
  });

// ── command building ───────────────────────────────────────────────────────────

/** Whitespace control → `git` diff flag (P1-DIFF-5). */
const whitespaceArgs = (ws: DiffSpec["whitespace"]): ReadonlyArray<string> =>
  ws === "ignore-all" ? ["-w"] : ws === "ignore-change" ? ["-b"] : [];

/**
 * Rename control. We force `-M -C` or `--no-renames` (never leaving it to repo config)
 * so the three parallel outputs stay one-entry-per-file aligned (DM-060).
 */
const renameArgs = (renames: boolean): ReadonlyArray<string> =>
  renames ? ["-M", "-C"] : ["--no-renames"];

/** Build the three aligned diff commands (name-status, numstat, patch) for a base prefix. */
const diffTriple = (
  base: ReadonlyArray<string>,
  ws: ReadonlyArray<string>,
  renames: ReadonlyArray<string>,
  context: ReadonlyArray<string>,
  combined: ReadonlyArray<string>,
  rev: ReadonlyArray<string>,
  paths: ReadonlyArray<string>,
): { nameStatus: string[]; numstat: string[]; patch: string[] } => {
  const tail = paths.length > 0 ? ["--", ...paths] : [];
  return {
    nameStatus: [
      ...base,
      "-z",
      "--name-status",
      ...renames,
      ...ws,
      ...rev,
      ...tail,
    ],
    numstat: [...base, "-z", "--numstat", ...renames, ...ws, ...rev, ...tail],
    patch: [
      ...base,
      "-p",
      ...renames,
      ...ws,
      ...context,
      ...combined,
      ...rev,
      ...tail,
    ],
  };
};

const assembleDiff = (
  cwd: string,
  cmds: { nameStatus: string[]; numstat: string[]; patch: string[] },
  env: NodeJS.ProcessEnv | undefined,
): Effect.Effect<ReadonlyArray<DiffFileType>, GitError> =>
  Effect.gen(function* () {
    const ns = yield* runGitOk({ cwd, args: cmds.nameStatus, env });
    const num = yield* runGitOk({ cwd, args: cmds.numstat, env });
    const patch = yield* runGitOk({ cwd, args: cmds.patch, env });
    return buildDiffFiles(
      parseNameStatus(ns.stdout),
      parseNumstat(num.stdout),
      parsePatch(decodeUtf8(patch.stdout)),
    );
  });

/** `commit.diff` — changed files for a commit or range (DiffSpec, 05 §2.6). */
export const commitDiff = (
  cwd: string,
  spec: DiffSpec,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<ReadonlyArray<DiffFileType>, GitError> =>
  Effect.gen(function* () {
    const target = yield* assertNoLeadingDash(spec.target, "diff target");
    const ws = whitespaceArgs(spec.whitespace);
    const renames = renameArgs(spec.renames);
    const context = [`-U${Math.max(0, Math.floor(spec.context))}`];
    const combined = spec.combined ? ["--cc"] : [];
    const paths = (spec.paths ?? []).filter((p) => p !== "");

    if (spec.cached) {
      // Index vs the target tree (an unusual but valid `commit.diff` request).
      const cmds = diffTriple(
        ["diff", "--cached"],
        ws,
        renames,
        context,
        combined,
        [target],
        paths,
      );
      return yield* assembleDiff(cwd, cmds, env);
    }

    // Tree-to-tree (`diff-tree`): explicit base, else target vs its first parent
    // (`--root` makes a root commit diff against the empty tree).
    let rev: string[];
    if (spec.base !== undefined && spec.base !== "") {
      const base = yield* assertNoLeadingDash(spec.base, "diff base");
      rev = [base, target];
    } else {
      rev = ["--root", target];
    }
    const cmds = diffTriple(
      ["diff-tree", "-r", "--no-commit-id"],
      ws,
      renames,
      context,
      combined,
      rev,
      paths,
    );
    return yield* assembleDiff(cwd, cmds, env);
  });

/** `diff.workingFile` — the working-tree (or staged) diff for one path (P2 surface). */
export const diffWorkingFile = (
  cwd: string,
  path: string,
  staged: boolean,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<DiffFileType, GitError> =>
  Effect.gen(function* () {
    const cachedFlag = staged ? ["--cached"] : [];
    const base = ["diff", ...cachedFlag];
    const tail = ["--", path];
    const ns = yield* runGitOk({
      cwd,
      args: [...base, "-z", "--name-status", "--no-renames", ...tail],
      env,
    });
    const num = yield* runGitOk({
      cwd,
      args: [...base, "-z", "--numstat", "--no-renames", ...tail],
      env,
    });
    const patch = yield* runGitOk({
      cwd,
      args: [...base, "-p", "--no-renames", ...tail],
      env,
    });
    const files = buildDiffFiles(
      parseNameStatus(ns.stdout),
      parseNumstat(num.stdout),
      parsePatch(decodeUtf8(patch.stdout)),
    );
    const first = files[0];
    if (first !== undefined) return first;
    // No change for this path ⇒ an explicit unmodified result (not an error).
    return new DiffFile({
      oldPath: path,
      newPath: path,
      status: "unmodified",
      isBinary: false,
      additions: 0,
      deletions: 0,
      hunks: [],
    });
  });
