import type { CommitInput } from "@cbranch/rpc-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";
import { commitCreate, commitLastMessage } from "./commit-write";

const BASE_INPUT: Omit<CommitInput, "repoId" | "subject"> = {
  body: undefined,
  amend: false,
  signoff: false,
  sign: undefined,
  authorOverride: undefined,
  allowEmpty: false,
  noVerify: false,
};

describe("commit-write git operations", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  test("commitCreate creates a commit with the given subject", async () => {
    const repo = await ws.createRepo("commit-basic");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("a.txt", "hello\n");
    await repo.stage("a.txt");

    const input: CommitInput = { ...BASE_INPUT, repoId: "test" as any, subject: "add a.txt" };
    const result = await run(commitCreate(repo.dir, input));

    expect(result.subject).toBe("add a.txt");
    expect(result.oid).toHaveLength(40);
    expect(result.shortOid.length).toBeGreaterThanOrEqual(4);

    const log = await repo.git(["log", "-1", "--format=%s"]);
    expect(log.stdout.trim()).toBe("add a.txt");
  });

  test("commitCreate creates a commit with subject and body", async () => {
    const repo = await ws.createRepo("commit-body");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("b.txt", "world\n");
    await repo.stage("b.txt");

    const input: CommitInput = {
      ...BASE_INPUT,
      repoId: "test" as any,
      subject: "feat: add feature",
      body: "This adds the feature.\n\nCloses #42.",
    };
    await run(commitCreate(repo.dir, input));

    const log = await repo.git(["log", "-1", "--format=%B"]);
    expect(log.stdout).toContain("feat: add feature");
    expect(log.stdout).toContain("This adds the feature.");
    expect(log.stdout).toContain("Closes #42.");
  });

  test("commitCreate rejects empty index when not amending or allowEmpty", async () => {
    const repo = await ws.createRepo("commit-empty-guard");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });

    const input: CommitInput = { ...BASE_INPUT, repoId: "test" as any, subject: "empty" };
    await expect(run(commitCreate(repo.dir, input))).rejects.toThrow();
  });

  test("commitCreate with allowEmpty succeeds when nothing is staged", async () => {
    const repo = await ws.createRepo("commit-allow-empty");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });

    const input: CommitInput = { ...BASE_INPUT, repoId: "test" as any, subject: "empty ok", allowEmpty: true };
    const result = await run(commitCreate(repo.dir, input));

    expect(result.subject).toBe("empty ok");
    const log = await repo.git(["log", "-1", "--format=%s"]);
    expect(log.stdout.trim()).toBe("empty ok");
  });

  test("commitCreate with amend replaces the previous commit message", async () => {
    const repo = await ws.createRepo("commit-amend");
    await repo.commit({ message: "original", files: { "init.txt": "init\n" } });
    await repo.writeFile("x.txt", "x\n");
    await repo.stage("x.txt");

    const input: CommitInput = { ...BASE_INPUT, repoId: "test" as any, subject: "amended", amend: true };
    await run(commitCreate(repo.dir, input));

    const log = await repo.git(["log", "-1", "--format=%s"]);
    expect(log.stdout.trim()).toBe("amended");
  });

  test("commitCreate with signoff adds Signed-off-by trailer", async () => {
    const repo = await ws.createRepo("commit-signoff");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("s.txt", "s\n");
    await repo.stage("s.txt");

    const input: CommitInput = { ...BASE_INPUT, repoId: "test" as any, subject: "signed", signoff: true };
    await run(commitCreate(repo.dir, input));

    const log = await repo.git(["log", "-1", "--format=%B"]);
    expect(log.stdout).toContain("Signed-off-by:");
  });

  test("commitLastMessage returns the subject of the most recent commit", async () => {
    const repo = await ws.createRepo("last-message-subject");
    await repo.commit({ message: "my subject", files: { "init.txt": "init\n" } });

    const msg = await run(commitLastMessage(repo.dir));

    expect(msg.subject).toBe("my subject");
    expect(msg.raw).toContain("my subject");
  });

  test("commitLastMessage returns subject and body correctly", async () => {
    const repo = await ws.createRepo("last-message-body");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("f.txt", "f\n");
    await repo.stage("f.txt");
    // Commit with subject + body via the commit-write function
    const input: CommitInput = {
      ...BASE_INPUT,
      repoId: "test" as any,
      subject: "feat: thing",
      body: "Detailed explanation.",
    };
    await run(commitCreate(repo.dir, input));

    const msg = await run(commitLastMessage(repo.dir));

    expect(msg.subject).toBe("feat: thing");
    expect(msg.body).toContain("Detailed explanation.");
  });

  test("commitLastMessage fails with repoUnavailable on an empty repo", async () => {
    const repo = await ws.createRepo("last-message-empty");
    // No commits — empty repo

    await expect(run(commitLastMessage(repo.dir))).rejects.toThrow();
  });

  test("commitCreate with authorOverride — sets custom author", async () => {
    const repo = await ws.createRepo("commit-author");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("x.txt", "x\n");
    await repo.stage("x.txt");

    const input: CommitInput = {
      ...BASE_INPUT,
      repoId: "test" as any,
      subject: "custom author",
      authorOverride: { name: "Custom User", email: "custom@example.com" },
    };
    await run(commitCreate(repo.dir, input));

    const log = await repo.git(["log", "-1", "--format=%an <%ae>"]);
    expect(log.stdout.trim()).toBe("Custom User <custom@example.com>");
  });

  test("commitCreate with noVerify — skips pre-commit hooks", async () => {
    const repo = await ws.createRepo("commit-noverify");
    await repo.commit({ message: "init", files: { "init.txt": "init\n" } });
    await repo.writeFile("y.txt", "y\n");
    await repo.stage("y.txt");

    const input: CommitInput = {
      ...BASE_INPUT,
      repoId: "test" as any,
      subject: "skip hooks",
      noVerify: true,
    };
    const result = await run(commitCreate(repo.dir, input));
    expect(result.subject).toBe("skip hooks");
  });
});
