// Single-path file history with rename following (docs/spec/08; DECISIONS D17). READ,
// no lock, cursor-paginated (reuses the log cursor helpers). `--follow` is single-path
// and its `--name-status -z` output interleaves a per-commit format record with the
// file's status line, so this ships a dedicated parser rather than reusing the
// name-status reader: each commit record is `\x01<oid>\x1f<an>\x1f<ae>\x1f<date>\x1f
// <subject>` (NUL-terminated), then git prefixes the status token of the following
// name-status block with a single `\n` (e.g. `\nR100\0old\0new`).

import {
  type ChangeCode,
  FileHistoryEntry,
  FileHistoryPage,
  type GitError,
  Oid as OidBrand,
} from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { classifyExit } from "./errors";
import { cappedLimit, decodeLogCursor, encodeLogCursor } from "./history";
import { assertNoLeadingDash, decodeUtf8, runGit } from "./run-git";

const REC = "\x01"; // record sentinel at the start of each commit's format output
const FSEP = "\x1f"; // unit separator between format fields
const FH_FORMAT = `${REC}%H${FSEP}%an${FSEP}%ae${FSEP}%aI${FSEP}%s`;

export interface FileHistoryOptions {
  readonly limit: number;
  readonly cursor?: string;
  readonly startRev?: string;
}

const mapStatus = (code: string): ChangeCode => {
  switch (code.charAt(0)) {
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
    default:
      return "modified";
  }
};

/**
 * Parse the interleaved `git log --follow -z --name-status` window into ordered
 * revisions. Each `\x01`-led token is a commit record; the tokens that follow (up to
 * the next record) are its name-status fields, with the single leading `\n` git inserts
 * stripped from the status token. For `--follow` each commit touches the one path, so
 * the first name-status entry is the file's change in that revision.
 */
export const parseFileHistory = (stdout: Buffer): FileHistoryEntry[] => {
  const tokens = decodeUtf8(stdout).split("\0");
  const entries: FileHistoryEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === undefined || !tok.startsWith(REC)) {
      i++;
      continue;
    }
    const fields = tok.slice(1).split(FSEP);
    const oid = fields[0];
    i++;

    const ns: string[] = [];
    while (i < tokens.length && !(tokens[i] ?? "").startsWith(REC)) {
      const t = tokens[i] ?? "";
      if (t !== "") ns.push(t);
      i++;
    }
    if (oid === undefined || oid === "") continue;
    if (ns.length > 0) ns[0] = (ns[0] as string).replace(/^\n/, "");

    const status = ns[0];
    const isMove =
      status !== undefined &&
      (status.startsWith("R") || status.startsWith("C"));
    const path = (isMove ? ns[2] : ns[1]) ?? "";
    const oldPath = isMove ? ns[1] : undefined;
    const renameScore =
      isMove && status !== undefined ? Number(status.slice(1)) : undefined;

    entries.push(
      new FileHistoryEntry({
        oid: OidBrand.make(oid),
        authorName: fields[1] ?? "",
        authorEmail: fields[2] ?? "",
        authorDate: fields[3] ?? "",
        subject: fields[4] ?? "",
        path,
        status: mapStatus(status ?? "M"),
        oldPath,
        renameScore:
          renameScore !== undefined && Number.isFinite(renameScore)
            ? renameScore
            : undefined,
      }),
    );
  }
  return entries;
};

/**
 * file.history — the rename-following revision list of a single path, paginated
 * (cursor + capped limit). An unborn HEAD or a path with no history yields an empty
 * page rather than an error. READ.
 */
export const fileHistory = (
  cwd: string,
  path: string,
  opts: FileHistoryOptions,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<FileHistoryPage, GitError> =>
  Effect.gen(function* () {
    const startRev = opts.startRev ?? "HEAD";
    yield* assertNoLeadingDash(startRev, "revision");
    const limit = cappedLimit(opts.limit);
    const skip = decodeLogCursor(opts.cursor)?.skip ?? 0;

    const args = [
      "log",
      "--follow",
      "-z",
      `--format=${FH_FORMAT}`,
      "--name-status",
      `--max-count=${limit}`,
    ];
    if (skip > 0) args.push(`--skip=${skip}`);
    args.push(startRev, "--", path);

    const res = yield* runGit({ cwd, args, env });
    if (res.exitCode !== 0) {
      const head = yield* runGit({
        cwd,
        args: ["rev-parse", "--quiet", "--verify", "HEAD"],
        env,
      });
      if (head.exitCode !== 0) return new FileHistoryPage({ entries: [] });
      return yield* Effect.fail(
        classifyExit(res.exitCode, decodeUtf8(res.stderr)),
      );
    }

    const entries = parseFileHistory(res.stdout);
    const last = entries[entries.length - 1];
    const nextCursor =
      entries.length === limit && last !== undefined
        ? encodeLogCursor(skip + entries.length, last.oid)
        : undefined;
    return new FileHistoryPage({ entries, nextCursor });
  });
