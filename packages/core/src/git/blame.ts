// Per-line blame (docs/spec/08; DECISIONS D17). READ, no lock. Large files are capped
// (REQ-EDGE-010) via a cheap `cat-file --batch-check` size probe before running blame;
// otherwise `git blame --porcelain -M -C` is parsed for per-line ownership plus the
// deduped per-commit headers (incl. `previous`, which powers blame-the-prior-revision).

import {
  BlameCommit,
  BlameData,
  BlameLine,
  type BlameResult,
  BlameTooLarge,
  type GitError,
  Oid as OidBrand,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { type CatFilePool } from "./cat-file-pool";
import { assertNoLeadingDash, decodeUtf8, runGitOk } from "./run-git";

// NF-LIMIT-3: inline content cap. Above this, blame is refused unless forced.
const MAX_BLAME_BYTES = 10 * 1024 * 1024;

export interface BlameOptions {
  readonly rev?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly force?: boolean;
}

/** `+0530` / `-0500` → signed minutes east of UTC. */
const tzToMinutes = (tz: string): number => {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz.trim());
  if (m === null) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
};

interface PendingCommit {
  oid: string;
  authorName?: string;
  authorEmail?: string;
  authorTime?: number;
  authorTzMinutes?: number;
  summary?: string;
  filename?: string;
  previousOid?: string;
  previousPath?: string;
}

const buildCommit = (p: PendingCommit): BlameCommit =>
  new BlameCommit({
    oid: OidBrand.make(p.oid),
    authorName: p.authorName ?? "",
    authorEmail: p.authorEmail ?? "",
    authorTime: p.authorTime ?? 0,
    authorTzMinutes: p.authorTzMinutes ?? 0,
    summary: p.summary ?? "",
    filename: p.filename ?? "",
    previousOid:
      p.previousOid !== undefined ? OidBrand.make(p.previousOid) : undefined,
    previousPath: p.previousPath,
  });

const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/;

/**
 * Parse `git blame --porcelain` output into deduped commits + per-line ownership.
 * Each line group opens with `<oid> <orig> <final> [<count>]`; the per-commit headers
 * appear the first time an oid is seen, and the content line is TAB-prefixed.
 */
export const parseBlamePorcelain = (
  text: string,
  path: string,
  rev: string,
): BlameData => {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];
  let cur: { oid: string; orig: number; final: number } | undefined;
  let pending: PendingCommit | undefined;

  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header !== null) {
      cur = {
        oid: header[1] as string,
        orig: Number(header[2]),
        final: Number(header[3]),
      };
      pending = { oid: cur.oid };
      continue;
    }
    if (cur === undefined) continue;
    if (line.startsWith("\t")) {
      lines.push(
        new BlameLine({
          ownerOid: OidBrand.make(cur.oid),
          finalLineNo: cur.final,
          origLineNo: cur.orig,
          content: line.slice(1),
        }),
      );
      if (!commits.has(cur.oid) && pending !== undefined)
        commits.set(cur.oid, buildCommit(pending));
      continue;
    }
    if (pending === undefined) continue;
    const sp = line.indexOf(" ");
    const key = sp === -1 ? line : line.slice(0, sp);
    const val = sp === -1 ? "" : line.slice(sp + 1);
    if (key === "author") pending.authorName = val;
    else if (key === "author-mail")
      pending.authorEmail = val.replace(/^<|>$/g, "");
    else if (key === "author-time") pending.authorTime = Number(val);
    else if (key === "author-tz") pending.authorTzMinutes = tzToMinutes(val);
    else if (key === "summary") pending.summary = val;
    else if (key === "filename") pending.filename = val;
    else if (key === "previous") {
      const space = val.indexOf(" ");
      pending.previousOid = space === -1 ? val : val.slice(0, space);
      pending.previousPath = space === -1 ? undefined : val.slice(space + 1);
    }
  }

  return new BlameData({
    path,
    rev,
    commits: [...commits.values()],
    lines,
  });
};

/**
 * blame — per-line authorship for a file at a revision (default HEAD), following
 * moves/renames (`-M -C`). Returns {@link BlameTooLarge} for an oversized blob unless
 * `force` is set. READ.
 */
export const blame = (
  cwd: string,
  pool: CatFilePool,
  path: string,
  opts: BlameOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<BlameResult, GitError> =>
  Effect.gen(function* () {
    const rev = opts.rev ?? "HEAD";

    const info = yield* pool.objectInfo(`${rev}:${path}`);
    if (info !== null && info.size > MAX_BLAME_BYTES && opts.force !== true) {
      return new BlameTooLarge({
        path,
        rev,
        byteSize: info.size,
        lineCount: 0,
      });
    }

    // `rev` is positional before `--`; guard against option injection.
    yield* assertNoLeadingDash(rev, "revision");

    const args = ["blame", "--porcelain", "-M", "-C"];
    if (
      opts.startLine !== undefined &&
      opts.endLine !== undefined &&
      opts.startLine > 0 &&
      opts.endLine >= opts.startLine
    ) {
      args.push("-L", `${opts.startLine},${opts.endLine}`);
    }
    args.push(rev, "--", path);

    const out = yield* runGitOk({ cwd, args, env });
    return parseBlamePorcelain(decodeUtf8(out.stdout), path, rev);
  });
