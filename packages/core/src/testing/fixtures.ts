// Fixture-repository harness (docs/spec/12 NF-TEST-3/4).
//
// Programmatically creates + tears down throwaway git repositories in a temp dir for
// unit tests. Supports: empty repos; commits with explicit author/committer/message/
// timestamp/file contents; branches & tags (lightweight + annotated); detached HEAD;
// merge commits & divergent histories; staged partial changes; dirty working trees;
// unmerged/conflicted index; linked worktrees; and a second on-disk repo as a local
// remote. DETERMINISTIC by construction: fixed identities + timestamps and an isolated
// git config (global/system config bypassed, autocrlf off, signing off) so commit
// hashes are STABLE across runs and machines (NF-TEST-4).
//
// This module is test-only infrastructure and intentionally uses Promises (not Effect)
// so tests read top-to-bottom.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Identity {
  readonly name: string;
  readonly email: string;
}

/** Deterministic default committer/author identity. */
export const DEFAULT_IDENTITY: Identity = {
  name: "Cb Tester",
  email: "tester@cbranch.test",
};

/** A fixed base instant; `fixtureDate(n)` advances it deterministically. */
const BASE_EPOCH = 1_700_000_000;

/** A stable ISO-8601 timestamp `n` minutes after the fixed base (for reproducible hashes). */
export const fixtureDate = (n = 0): string =>
  `${new Date((BASE_EPOCH + n * 60) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;

export interface CommitOptions {
  readonly message: string;
  /** Files to write (relative path → content) and stage before committing. */
  readonly files?: Readonly<Record<string, string>>;
  readonly author?: Identity;
  readonly committer?: Identity;
  /** Used for both author + committer date unless the specific ones are given. */
  readonly date?: string;
  readonly authorDate?: string;
  readonly committerDate?: string;
  readonly allowEmpty?: boolean;
}

export interface GitRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runGitRaw = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<GitRunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });

/** A throwaway git repository. All methods are deterministic given the same inputs. */
export class FixtureRepo {
  private commitSeq = 0;

  constructor(
    readonly dir: string,
    private readonly isBare = false,
  ) {}

  private baseEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(this.dir, ".no-global-config"),
      GIT_CONFIG_SYSTEM: join(this.dir, ".no-system-config"),
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
      LANGUAGE: "",
      ...extra,
    };
  }

  /** Run git in this repo, throwing on non-zero exit unless `allowFailure` is set. */
  async git(
    args: ReadonlyArray<string>,
    opts?: { env?: NodeJS.ProcessEnv; allowFailure?: boolean },
  ): Promise<GitRunResult> {
    const result = await runGitRaw(this.dir, args, this.baseEnv(opts?.env));
    if (result.code !== 0 && opts?.allowFailure !== true) {
      throw new Error(
        `git ${args.join(" ")} failed (${result.code}): ${result.stderr}`,
      );
    }
    return result;
  }

  /** Initialize the repository and apply deterministic, isolated config. */
  async init(opts?: { initialBranch?: string }): Promise<void> {
    const branch = opts?.initialBranch ?? "main";
    const args = ["init", "-q", `--initial-branch=${branch}`];
    if (this.isBare) args.push("--bare");
    args.push(".");
    await this.git(args);
    // Deterministic identity + content handling (stable hashes across OS — NF-TEST-4).
    await this.git(["config", "user.name", DEFAULT_IDENTITY.name]);
    await this.git(["config", "user.email", DEFAULT_IDENTITY.email]);
    await this.git(["config", "commit.gpgsign", "false"]);
    await this.git(["config", "tag.gpgsign", "false"]);
    await this.git(["config", "core.autocrlf", "false"]);
    await this.git(["config", "core.fsmonitor", "false"]);
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = join(this.dir, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async stage(...paths: string[]): Promise<void> {
    await this.git(["add", "--", ...(paths.length === 0 ? ["."] : paths)]);
  }

  /** Write + stage files and create a commit; returns the new commit oid. */
  async commit(opts: CommitOptions): Promise<string> {
    this.commitSeq += 1;
    if (opts.files !== undefined) {
      await Promise.all(
        Object.entries(opts.files).map(([path, content]) =>
          this.writeFile(path, content),
        ),
      );
      await this.stage(...Object.keys(opts.files));
    }
    const author = opts.author ?? DEFAULT_IDENTITY;
    const committer = opts.committer ?? DEFAULT_IDENTITY;
    const authorDate =
      opts.authorDate ?? opts.date ?? fixtureDate(this.commitSeq);
    const committerDate =
      opts.committerDate ?? opts.date ?? fixtureDate(this.commitSeq);
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: committerDate,
    };
    const args = ["commit", "-q", "-m", opts.message];
    // Allow an empty commit when no files were supplied (terse fixtures); harmless
    // when there ARE staged changes (git only honors it if the commit is empty).
    if (opts.allowEmpty === true || opts.files === undefined)
      args.push("--allow-empty");
    await this.git(args, { env });
    return this.revParse("HEAD");
  }

  async branch(
    name: string,
    opts?: { startPoint?: string; force?: boolean },
  ): Promise<void> {
    const args = ["branch"];
    if (opts?.force === true) args.push("-f");
    args.push(name);
    if (opts?.startPoint !== undefined) args.push(opts.startPoint);
    await this.git(args);
  }

  async deleteBranch(name: string, opts?: { force?: boolean }): Promise<void> {
    await this.git(["branch", opts?.force === true ? "-D" : "-d", name]);
  }

  async checkout(
    ref: string,
    opts?: { detach?: boolean; create?: boolean },
  ): Promise<void> {
    const args = ["checkout", "-q"];
    if (opts?.create === true) args.push("-b");
    if (opts?.detach === true) args.push("--detach");
    args.push(ref);
    await this.git(args);
  }

  async tag(
    name: string,
    opts?: { message?: string; ref?: string; annotated?: boolean },
  ): Promise<void> {
    const annotated = opts?.annotated === true || opts?.message !== undefined;
    const args = ["tag"];
    if (annotated) args.push("-a", "-m", opts?.message ?? name);
    args.push(name);
    if (opts?.ref !== undefined) args.push(opts.ref);
    const env: NodeJS.ProcessEnv = {
      GIT_COMMITTER_NAME: DEFAULT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: DEFAULT_IDENTITY.email,
      GIT_COMMITTER_DATE: fixtureDate(this.commitSeq),
    };
    await this.git(args, { env });
  }

  async deleteTag(name: string): Promise<void> {
    await this.git(["tag", "-d", name]);
  }

  /** Merge `ref` into the current branch; returns whether it left conflicts. */
  async merge(
    ref: string,
    opts?: { message?: string; noFastForward?: boolean },
  ): Promise<{ conflict: boolean }> {
    const args = ["merge", "--no-edit"];
    if (opts?.noFastForward === true) args.push("--no-ff");
    if (opts?.message !== undefined) args.push("-m", opts.message);
    args.push(ref);
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: DEFAULT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: DEFAULT_IDENTITY.email,
      GIT_AUTHOR_DATE: fixtureDate(this.commitSeq + 1),
      GIT_COMMITTER_NAME: DEFAULT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: DEFAULT_IDENTITY.email,
      GIT_COMMITTER_DATE: fixtureDate(this.commitSeq + 1),
    };
    const result = await this.git(args, { env, allowFailure: true });
    return { conflict: result.code !== 0 };
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.git(["remote", "add", name, url]);
  }

  async fetch(remote = "origin"): Promise<void> {
    await this.git(["fetch", "-q", remote]);
  }

  /** Configure `branch` to track `remoteRef` (e.g. `origin/main`). */
  async setUpstream(branch: string, remoteRef: string): Promise<void> {
    await this.git(["branch", `--set-upstream-to=${remoteRef}`, branch]);
  }

  async revParse(rev: string): Promise<string> {
    const result = await this.git(["rev-parse", rev]);
    return result.stdout.trim();
  }

  /** Add a linked worktree and return a handle to it (shares this repo's `repoId`). */
  async worktreeAdd(
    path: string,
    opts?: { branch?: string; detach?: boolean },
  ): Promise<FixtureRepo> {
    const abs = join(this.dir, path);
    const args = ["worktree", "add", "-q"];
    if (opts?.detach === true) args.push("--detach");
    else if (opts?.branch !== undefined) args.push("-b", opts.branch);
    args.push(abs);
    if (opts?.detach === true) args.push("HEAD");
    await this.git(args);
    return new FixtureRepo(abs, false);
  }
}

/** A managed temp workspace that creates fixture repos and cleans them all up. */
export interface FixtureWorkspace {
  readonly root: string;
  /** Create + `init` a repository under the workspace. */
  readonly createRepo: (
    name: string,
    opts?: { bare?: boolean; initialBranch?: string },
  ) => Promise<FixtureRepo>;
  /** Create a directory (no git) — for "open a non-repo" negative tests. */
  readonly createPlainDir: (name: string) => Promise<string>;
  readonly cleanup: () => Promise<void>;
}

export const createFixtureWorkspace = async (): Promise<FixtureWorkspace> => {
  const root = await mkdtemp(join(tmpdir(), "cbranch-fixtures-"));
  return {
    root,
    createRepo: async (name, opts) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const repo = new FixtureRepo(dir, opts?.bare === true);
      await repo.init({ initialBranch: opts?.initialBranch });
      return repo;
    },
    createPlainDir: async (name) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    // Retries absorb the Windows race where a just-killed `cat-file` process still
    // holds a handle to its cwd for a few ms after SIGKILL (EBUSY/EPERM on rmdir).
    cleanup: () =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
  };
};

// ── higher-level declarative scenarios (reproducible from a description) ──────

/** A small linear repo: commits `a`, `b`, `c` on `main` with deterministic hashes. */
export const seedLinear = async (repo: FixtureRepo): Promise<string[]> => {
  const a = await repo.commit({
    message: "a",
    files: { "a.txt": "a\n" },
    date: fixtureDate(1),
  });
  const b = await repo.commit({
    message: "b",
    files: { "b.txt": "b\n" },
    date: fixtureDate(2),
  });
  const c = await repo.commit({
    message: "c",
    files: { "c.txt": "c\n" },
    date: fixtureDate(3),
  });
  return [a, b, c];
};

/** Create an unmerged/conflicted index by merging two divergent edits of one file. */
export const seedConflict = async (repo: FixtureRepo): Promise<void> => {
  await repo.commit({
    message: "base",
    files: { "f.txt": "base\n" },
    date: fixtureDate(1),
  });
  await repo.branch("other");
  await repo.commit({
    message: "ours",
    files: { "f.txt": "ours\n" },
    date: fixtureDate(2),
  });
  await repo.checkout("other");
  await repo.commit({
    message: "theirs",
    files: { "f.txt": "theirs\n" },
    date: fixtureDate(3),
  });
  await repo.checkout("main");
  await repo.merge("other");
};
