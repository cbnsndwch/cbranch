// Per-repository `git cat-file --batch` / `--batch-check` process pool
// (docs/spec/02 REQ-ARCH-020; 05 §2; NF-PERF-7).
//
// Object reads are the hot path; spawning `git` per read does not scale. Instead each
// repository keeps two LONG-LIVED `cat-file` processes — `--batch` (header + bytes)
// for content and `--batch-check` (header only) for metadata — fed by a serialized
// FIFO request queue over stdin/stdout. Lifetime is bound to a `Scope` via
// `Effect.acquireRelease`: the processes are killed on teardown (REQ-ARCH-061/064),
// so no orphan survives. Object reads are content-addressed and immutable, so no
// cache invalidation is required (REQ-ARCH-032).
//
// core-A builds + tests this infrastructure and exposes `readObject` / `objectInfo`;
// the history/diff/content methods that consume it are filled in by core-B.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { type GitError } from "@cbranch/rpc-contract";
import { Effect, type Scope } from "effect";

import { classifyNodeError, gitError } from "./errors";
import { nonInteractiveEnv } from "./run-git";

const NEWLINE = 0x0a;

export interface ObjectInfo {
  readonly oid: string;
  readonly type: string;
  readonly size: number;
}

export interface ObjectData extends ObjectInfo {
  readonly data: Buffer;
}

export interface CatFilePool {
  /** Read a full object (`null` when missing/ambiguous). Bytes are raw (ENC-003). */
  readonly readObject: (
    rev: string,
  ) => Effect.Effect<ObjectData | null, GitError>;
  /** Read object metadata only (`null` when missing/ambiguous). */
  readonly objectInfo: (
    rev: string,
  ) => Effect.Effect<ObjectInfo | null, GitError>;
}

type Pending = {
  readonly resolve: (value: ObjectData | ObjectInfo | null) => void;
  readonly reject: (err: unknown) => void;
};

/** One long-lived `cat-file` process with a serialized request queue + byte parser. */
class BatchProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly queue: Pending[] = [];
  private buf: Buffer = Buffer.alloc(0);
  private pendingBody: ObjectInfo | null = null;
  private closed = false;

  constructor(
    cwd: string,
    private readonly withBody: boolean,
    env?: NodeJS.ProcessEnv,
  ) {
    const mode = withBody ? "--batch" : "--batch-check";
    this.child = spawn("git", ["--no-optional-locks", "cat-file", mode], {
      cwd,
      env: nonInteractiveEnv(env),
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.on("error", (err) => this.fail(err));
    this.child.on("close", () =>
      this.fail(new Error("cat-file process closed")),
    );
  }

  request(rev: string): Promise<ObjectData | ObjectInfo | null> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("cat-file pool is closed"));
        return;
      }
      this.queue.push({ resolve, reject });
      this.child.stdin.write(`${rev}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.child.kill("SIGKILL");
    this.fail(new Error("cat-file pool closed"));
  }

  private fail(err: unknown): void {
    if (this.queue.length === 0) return;
    const pending = this.queue.splice(0, this.queue.length);
    for (const p of pending) p.reject(err);
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.pendingBody === null) {
        const nl = this.buf.indexOf(NEWLINE);
        if (nl === -1) return;
        const header = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 1);
        const parsed = parseHeader(header);
        if (parsed === null) {
          this.settle(null);
          continue;
        }
        if (this.withBody) {
          this.pendingBody = parsed;
          continue;
        }
        this.settle(parsed);
        continue;
      }
      // Awaiting body: <size> content bytes followed by a single trailing newline.
      const need = this.pendingBody.size + 1;
      if (this.buf.length < need) return;
      const data = this.buf.subarray(0, this.pendingBody.size);
      this.buf = this.buf.subarray(need);
      const info = this.pendingBody;
      this.pendingBody = null;
      this.settle({ ...info, data: Buffer.from(data) });
    }
  }

  private settle(value: ObjectData | ObjectInfo | null): void {
    const next = this.queue.shift();
    if (next !== undefined) next.resolve(value);
  }
}

const parseHeader = (line: string): ObjectInfo | null => {
  // "<sha> <type> <size>" on success; "<oid> missing" / "<oid> ambiguous" otherwise.
  const parts = line.split(" ");
  if (parts.length !== 3) return null;
  const [oid, type, sizeStr] = parts as [string, string, string];
  const size = Number(sizeStr);
  if (!Number.isFinite(size)) return null;
  return { oid, type, size };
};

/** Reject revs that could break the line protocol or inject a `git` option. */
const validateRev = (rev: string): GitError | null => {
  if (rev.includes("\n") || rev.includes("\r"))
    return gitError("gitFailed", "object id must be a single line");
  if (rev.startsWith("-"))
    return gitError("invalidRefName", "object id must not begin with '-'");
  return null;
};

/**
 * Create a scoped object-read pool for one repository. The two `cat-file` processes
 * are spawned on acquire and killed on the scope's release.
 */
export const makeCatFilePool = (
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<CatFilePool, GitError, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => ({
        batch: new BatchProcess(cwd, true, env),
        check: new BatchProcess(cwd, false, env),
      })),
      (pair) =>
        Effect.sync(() => {
          pair.batch.close();
          pair.check.close();
        }),
    ),
    (pair): CatFilePool => ({
      readObject: (rev) => {
        const invalid = validateRev(rev);
        return invalid !== null
          ? Effect.fail(invalid)
          : Effect.tryPromise({
              try: () => pair.batch.request(rev) as Promise<ObjectData | null>,
              catch: classifyNodeError,
            });
      },
      objectInfo: (rev) => {
        const invalid = validateRev(rev);
        return invalid !== null
          ? Effect.fail(invalid)
          : Effect.tryPromise({
              try: () => pair.check.request(rev) as Promise<ObjectInfo | null>,
              catch: classifyNodeError,
            });
      },
    }),
  );
