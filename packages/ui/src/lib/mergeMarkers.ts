// Conflict-marker grammar + hunk model for the 3-way merge editor (docs/spec/11
// REQ-MERGE-012/015/017, REQ-CN-010, REQ-EDGE-004; DECISIONS D17). Pure, byte-faithful
// logic — the editor's testable core. Markers are matched STRICTLY: exactly seven
// marker chars at column 0; `<<<<<<< ` / `||||||| ` / `>>>>>>> ` require a trailing
// space (+label); `=======` is exactly seven `=` alone. The diff3 base section is
// optional (2-way fallback). Anything unbalanced/nested/EOF-in-block is reported
// AMBIGUOUS so the caller falls back to plain-text editing; lines that merely resemble
// markers (wrong length / no trailing space) are NOT treated as markers.

const OURS = /^<<<<<<< /;
const BASE = /^\|\|\|\|\|\|\| /;
const SEP = /^=======$/;
const THEIRS = /^>>>>>>> /;

const isMarker = (line: string): boolean =>
  OURS.test(line) || BASE.test(line) || SEP.test(line) || THEIRS.test(line);

export type AcceptChoice =
  | "ours"
  | "theirs"
  | "both"
  | "both-reversed"
  | "base";

export interface ConflictBlock {
  /** Line index of the `<<<<<<<` opener. */
  readonly startLine: number;
  /** Line index of the `>>>>>>>` closer. */
  readonly endLine: number;
  readonly ours: ReadonlyArray<string>;
  readonly base?: ReadonlyArray<string>;
  readonly theirs: ReadonlyArray<string>;
}

export interface ParseResult {
  readonly blocks: ReadonlyArray<ConflictBlock>;
  /** Markers were unbalanced/nested/unterminated — treat the file as plain text. */
  readonly ambiguous: boolean;
}

/** Read one conflict block starting at `<<<<<<<` line `start`; `null` if malformed. */
const readBlock = (
  lines: ReadonlyArray<string>,
  start: number,
): ConflictBlock | null => {
  const ours: string[] = [];
  let base: string[] | undefined;
  const theirs: string[] = [];
  let section: "ours" | "base" | "theirs" = "ours";
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (OURS.test(l)) return null; // nested opener
    if (BASE.test(l)) {
      if (section !== "ours") return null;
      section = "base";
      base = [];
      continue;
    }
    if (SEP.test(l)) {
      if (section === "theirs") return null;
      section = "theirs";
      continue;
    }
    if (THEIRS.test(l)) {
      if (section !== "theirs") return null;
      return { startLine: start, endLine: i, ours, base, theirs };
    }
    if (section === "ours") ours.push(l);
    else if (section === "base") (base as string[]).push(l);
    else theirs.push(l);
  }
  return null; // EOF before the closer
};

/** Parse conflict blocks out of LF-normalized text. */
export const parseConflicts = (text: string): ParseResult => {
  const lines = text.split("\n");
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (OURS.test(line)) {
      const block = readBlock(lines, i);
      if (block === null) return { blocks: [], ambiguous: true };
      blocks.push(block);
      i = block.endLine + 1;
      continue;
    }
    // A closer/separator/base marker with no open block is unbalanced.
    if (BASE.test(line) || SEP.test(line) || THEIRS.test(line))
      return { blocks: [], ambiguous: true };
    i++;
  }
  return { blocks, ambiguous: false };
};

const resolvedLines = (
  block: ConflictBlock,
  choice: AcceptChoice,
): ReadonlyArray<string> => {
  switch (choice) {
    case "ours":
      return block.ours;
    case "theirs":
      return block.theirs;
    case "both":
      return [...block.ours, ...block.theirs];
    case "both-reversed":
      return [...block.theirs, ...block.ours];
    case "base":
      return block.base ?? [];
  }
};

/**
 * Replace the `index`-th conflict block in `text` with the chosen side's lines. Re-parses
 * `text` first so it composes with free edits; a no-op if ambiguous or out of range.
 */
export const applyResolution = (
  text: string,
  index: number,
  choice: AcceptChoice,
): string => {
  const { blocks, ambiguous } = parseConflicts(text);
  if (ambiguous || index < 0 || index >= blocks.length) return text;
  const block = blocks[index] as ConflictBlock;
  const lines = text.split("\n");
  lines.splice(
    block.startLine,
    block.endLine - block.startLine + 1,
    ...resolvedLines(block, choice),
  );
  return lines.join("\n");
};

/** Whether any line is still a conflict marker (drives the save warning, REQ-MERGE-017). */
export const hasConflictMarkers = (text: string): boolean =>
  text.split("\n").some(isMarker);

// ── byte fidelity: BOM + EOL detection / reconstruction (REQ-MERGE-019) ──────────

export const detectBom = (text: string): boolean =>
  text.charCodeAt(0) === 0xfeff;

export const detectEol = (text: string): "\n" | "\r\n" => {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneLf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > 0 && crlf >= loneLf ? "\r\n" : "\n";
};

export interface WorkingText {
  /** LF-normalized, BOM-stripped editable text. */
  readonly working: string;
  readonly bom: boolean;
  readonly eol: "\n" | "\r\n";
}

/** Decompose raw seed bytes-as-string into editable text + the EOL/BOM to restore. */
export const toWorkingText = (raw: string): WorkingText => {
  const bom = detectBom(raw);
  const body = bom ? raw.slice(1) : raw;
  return { working: body.replace(/\r\n/g, "\n"), bom, eol: detectEol(body) };
};

/** Reassemble editable text into the exact bytes-as-string to save. */
export const fromWorkingText = (
  working: string,
  bom: boolean,
  eol: "\n" | "\r\n",
): string => {
  const restored = eol === "\r\n" ? working.replace(/\n/g, "\r\n") : working;
  return bom ? `﻿${restored}` : restored;
};

/** UTF-8 → base64 (browser-safe; the server base64-decodes and writes verbatim). */
export const utf8ToBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};
