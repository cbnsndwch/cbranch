// Branch listing (docs/spec/07 REQ-P3-BR-001..005).
//
// A single `git for-each-ref refs/heads refs/remotes` call retrieves all local
// and remote-tracking branches with their upstream info and ahead/behind counts.
// The ASCII Unit Separator (0x1F) is used as the field delimiter so that branch
// names (which cannot contain it) do not collide with the separator.

import { BranchInfo, BranchListing, BranchUpstream, type GitError, Oid } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { decodeUtf8, runGit, runGitOk } from "./run-git";

// ASCII Unit Separator — cannot appear in branch names or commit subjects.
const SEP = String.fromCharCode(31);

// for-each-ref format fields (0–7) separated by SEP:
// 0: HEAD marker ("*" if current, " " otherwise)
// 1: full refname (refs/heads/main or refs/remotes/origin/main)
// 2: short refname (main or origin/main)
// 3: objectname (full SHA)
// 4: contents:subject (tip commit subject)
// 5: upstream full ref (empty for remote-tracking or untracked local)
// 6: upstream short name
// 7: upstream:track (e.g. "[ahead 2, behind 3]" or "[gone]" or "")
const FORMAT =
  "%(HEAD)" +
  SEP +
  "%(refname)" +
  SEP +
  "%(refname:short)" +
  SEP +
  "%(objectname)" +
  SEP +
  "%(contents:subject)" +
  SEP +
  "%(upstream)" +
  SEP +
  "%(upstream:short)" +
  SEP +
  "%(upstream:track)";

function parseTrack(track: string): { ahead: number; behind: number } | undefined {
  if (!track || track === "[gone]") return undefined;
  const ahead = track.match(/ahead (\d+)/);
  const behind = track.match(/behind (\d+)/);
  if (!ahead && !behind) return undefined;
  return { ahead: ahead ? parseInt(ahead[1] ?? "0", 10) : 0, behind: behind ? parseInt(behind[1] ?? "0", 10) : 0 };
}

function parseLine(line: string, isRemote: boolean): BranchInfo | null {
  const parts = line.split(SEP);
  if (parts.length < 8) return null;
  const headMarker = parts[0] ?? "";
  const fullRef = parts[1] ?? "";
  const shortName = parts[2] ?? "";
  const objectname = parts[3] ?? "";
  const subject = parts[4] ?? "";
  const upstreamRef = parts[5] ?? "";
  const upstreamShort = parts[6] ?? "";
  const upstreamTrack = parts[7] ?? "";

  if (!fullRef || !objectname) return null;

  // Skip remote HEAD symlinks (refs/remotes/origin/HEAD)
  if (isRemote && shortName.endsWith("/HEAD")) return null;

  let remoteName: string | undefined;
  if (isRemote) {
    const m = fullRef.match(/^refs\/remotes\/([^/]+)\//);
    remoteName = m?.[1];
  }

  let upstream: BranchUpstream | undefined;
  if (!isRemote && upstreamRef && upstreamTrack !== "[gone]") {
    // Empty track means parity (0 ahead, 0 behind); only "[gone]" means no upstream object.
    const track = parseTrack(upstreamTrack) ?? { ahead: 0, behind: 0 };
    upstream = new BranchUpstream({
      ref: upstreamRef,
      name: upstreamShort,
      ahead: track.ahead,
      behind: track.behind,
    });
  }

  return new BranchInfo({
    name: shortName,
    fullRef,
    tipOid: objectname as Oid,
    tipSubject: subject,
    isCurrent: headMarker === "*",
    upstream,
    isRemote,
    remoteName,
  });
}

export const branchList = (cwd: string, env?: NodeJS.ProcessEnv): Effect.Effect<BranchListing, GitError> =>
  Effect.gen(function* () {
    const result = yield* runGitOk({
      cwd,
      args: ["for-each-ref", "--format=" + FORMAT, "refs/heads", "refs/remotes"],
      env,
    });
    const output = decodeUtf8(result.stdout);

    const localBranches: BranchInfo[] = [];
    const remoteBranches: BranchInfo[] = [];
    let currentBranch: string | undefined;

    for (const line of output.split("\n")) {
      if (!line) continue;
      const fullRef = line.split(SEP)[1] ?? "";
      const isRemote = fullRef.startsWith("refs/remotes/");
      const info = parseLine(line, isRemote);
      if (!info) continue;
      if (isRemote) {
        remoteBranches.push(info);
      } else {
        localBranches.push(info);
        if (info.isCurrent) currentBranch = info.name;
      }
    }

    // Detect detached HEAD — no local branch is marked as current
    let detachedHead: Oid | undefined;
    if (!currentBranch) {
      const headRaw = yield* runGit({ cwd, args: ["rev-parse", "HEAD"], env });
      const h = headRaw.exitCode === 0 ? decodeUtf8(headRaw.stdout).trim() : "";
      if (h) detachedHead = h as Oid;
    }

    return new BranchListing({ localBranches, remoteBranches, currentBranch, detachedHead });
  });
