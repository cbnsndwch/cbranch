// Repository discovery & classification (docs/spec/05 §2.1; P1-OPEN-2/3).
//
// Resolves an on-disk path to a repository's identity WITHOUT loading history
// (P1-OPEN-5): top-level working dir, the worktree git dir, the shared common git
// dir (which backs `repoId`), and bare/normal classification. Failures map to the
// narrowed `repoNotFound | notARepository | fsError` set (P1-OPEN-2 / DECISIONS D7).

import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import { type GitError, type RepoId } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { classifyNodeError, gitError } from "../git/errors";
import { computeRepoId, normalizeAbsolute } from "../git/repo-id";
import { decodeUtf8, runGit } from "../git/run-git";

export interface ResolvedRepo {
  readonly repoId: RepoId;
  /** Resolved top-level working path (for bare repos, the git dir). Recent-list key. */
  readonly root: string;
  /** Absolute, worktree-specific git dir (`--absolute-git-dir`). */
  readonly gitDir: string;
  /** Normalized absolute common git dir (`--git-common-dir`); SHA-256 → `repoId`. */
  readonly commonDir: string;
  readonly isBare: boolean;
}

/** Working directory to run subsequent reads against (bare repos have no worktree). */
export const repoCwd = (repo: ResolvedRepo): string => (repo.isBare ? repo.gitDir : repo.root);

export const resolveRepo = (inputPath: string): Effect.Effect<ResolvedRepo, GitError> =>
  Effect.gen(function* () {
    // 1. Path must exist; ENOENT → repoNotFound, other fs problem → fsError/permission.
    yield* Effect.tryPromise({
      try: () => stat(inputPath),
      catch: (err): GitError => {
        const code =
          typeof err === "object" && err !== null && "code" in err ? (err as { code: unknown }).code : undefined;
        return code === "ENOENT" ? gitError("repoNotFound", "no such path") : classifyNodeError(err);
      },
    });

    // 2. Classify the repository. A non-zero exit here means "not a git repository".
    const probe = yield* runGit({
      cwd: inputPath,
      args: ["rev-parse", "--is-bare-repository", "--is-inside-work-tree", "--absolute-git-dir", "--git-common-dir"],
    });
    if (probe.exitCode !== 0) {
      return yield* Effect.fail(gitError("notARepository", "path is not inside a git repository"));
    }
    const lines = decodeUtf8(probe.stdout)
      .split("\n")
      .map((l) => l.trim());
    const [isBareStr, isInsideStr, absoluteGitDir, commonDirRaw] = lines as [string, string, string, string];
    const isBare = isBareStr === "true";
    const isInsideWorkTree = isInsideStr === "true";

    const gitDir = normalizeAbsolute(inputPath, absoluteGitDir);
    const commonDir = normalizeAbsolute(inputPath, commonDirRaw);

    // 3. Top-level working dir (absent for bare / when inside the git dir).
    let root = isBare ? gitDir : dirname(gitDir);
    if (!isBare && isInsideWorkTree) {
      const top = yield* runGit({ cwd: inputPath, args: ["rev-parse", "--show-toplevel"] });
      if (top.exitCode === 0) {
        const text = decodeUtf8(top.stdout).trim();
        if (text !== "") root = normalizeAbsolute(inputPath, text);
      }
    }

    return { repoId: computeRepoId(commonDir), root, gitDir, commonDir, isBare };
  });
