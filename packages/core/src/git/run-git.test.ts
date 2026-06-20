import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Fiber, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run, runExit } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
  seedLinear,
} from "../testing/fixtures";
import { gitError } from "./errors";
import {
  assertNoLeadingDash,
  decodeUtf8,
  isHexOid,
  nonInteractiveEnv,
  runGit,
  runGitOk,
  streamGit,
} from "./run-git";

let ws: FixtureWorkspace;
beforeAll(async () => {
  ws = await createFixtureWorkspace();
});
afterAll(async () => {
  await ws.cleanup();
});

describe("nonInteractiveEnv (14 §3.3)", () => {
  test("exports the non-interactive, locale-stable variables", () => {
    const env = nonInteractiveEnv();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    expect(env.GIT_ASKPASS).toBe(process.execPath);
    expect(env.GIT_CORE_ASKPASS).toBe(process.execPath);
    expect(env.LC_ALL).toBe("C");
  });

  test("merges and overrides with extra entries", () => {
    expect(nonInteractiveEnv({ GIT_AUTHOR_NAME: "x" }).GIT_AUTHOR_NAME).toBe(
      "x",
    );
  });
});

describe("runGit", () => {
  test("captures stdout bytes and a zero exit for a successful command", async () => {
    const result = await run(
      runGit({ cwd: process.cwd(), args: ["--version"], read: false }),
    );
    expect(result.exitCode).toBe(0);
    expect(decodeUtf8(result.stdout)).toMatch(/git version/);
  });

  test("returns a non-zero exit as DATA (not a failure)", async () => {
    const plain = mkdtempSync(join(tmpdir(), "cbranch-nonrepo-"));
    const result = await run(
      runGit({ cwd: plain, args: ["rev-parse", "--git-dir"] }),
    );
    expect(result.exitCode).not.toBe(0);
  });
});

describe("runGitOk", () => {
  test("succeeds on exit 0", async () => {
    const repo = await ws.createRepo("ok");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const result = await run(
      runGitOk({ cwd: repo.dir, args: ["rev-parse", "HEAD"] }),
    );
    expect(result.exitCode).toBe(0);
  });

  test("fails with gitFailed on a non-zero exit", async () => {
    const plain = mkdtempSync(join(tmpdir(), "cbranch-nonrepo-"));
    const exit = await runExit(
      runGitOk({ cwd: plain, args: ["rev-parse", "--git-dir"] }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("streamGit (REQ-P3-XC-004 — real-time streaming + cancel)", () => {
  test("emits stdout output as line-tagged GitLine events", async () => {
    const repo = await ws.createRepo("stream-lines");
    await seedLinear(repo);

    const lines = await run(
      Stream.runCollect(
        streamGit({ cwd: repo.dir, args: ["log", "--format=%s"], read: false }),
      ),
    ).then((c) => [...c]);

    const subjects = lines
      .filter((l) => l.source === "stdout")
      .map((l) => l.text);
    expect(subjects).toContain("a");
    expect(subjects).toContain("b");
    expect(subjects).toContain("c");
  });

  test("fails via the classifyFailure callback on a non-zero exit", async () => {
    const repo = await ws.createRepo("stream-fail");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const err = await run(
      Effect.flip(
        Stream.runCollect(
          streamGit({
            cwd: repo.dir,
            args: ["rev-parse", "--verify", "does-not-exist"],
            read: false,
            classifyFailure: () => gitError("invalidRefName", "bad ref"),
          }),
        ),
      ),
    );
    expect(err.code).toBe("invalidRefName");
  });

  test("is cancelable — interrupting a blocked stream terminates promptly (XC-004)", async () => {
    const repo = await ws.createRepo("stream-cancel");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    // `cat-file --batch` blocks reading stdin forever, so the stream never ends on
    // its own; interrupting the fiber must run the scope's SIGKILL cleanup and
    // return rather than hang. If cancellation were broken this test would time out.
    const exit = await runExit(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Stream.runDrain(
            streamGit({
              cwd: repo.dir,
              args: ["cat-file", "--batch"],
              read: false,
            }),
          ),
        );
        yield* Effect.sleep("150 millis");
        // Interrupting returns once the scope's SIGKILL cleanup has run; if the
        // stream were uninterruptible this would never resolve.
        return yield* Fiber.interrupt(fiber);
      }).pipe(Effect.timeout("5 seconds")),
    );
    expect(exit._tag).toBe("Success");
  });
});

describe("argument-safety helpers (NF-SEC-6)", () => {
  test("assertNoLeadingDash rejects a value that looks like an option", async () => {
    const exit = await runExit(
      assertNoLeadingDash("--upload-pack=evil", "ref"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("assertNoLeadingDash passes a normal value", async () => {
    expect(await run(assertNoLeadingDash("main", "ref"))).toBe("main");
  });

  test("isHexOid", () => {
    expect(isHexOid("a4a762c8")).toBe(true);
    expect(isHexOid("nothex")).toBe(false);
    expect(isHexOid("ab")).toBe(false);
  });
});
