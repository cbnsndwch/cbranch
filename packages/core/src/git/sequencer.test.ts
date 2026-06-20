import { existsSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { detectInProgress } from "../repo/state";
import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureRepo,
  type FixtureWorkspace,
  fixtureDate,
  seedConflict,
} from "../testing/fixtures";
import { cherryPick, opAbort, opContinue, opSkip, revert } from "./sequencer";

let ws: FixtureWorkspace;
beforeAll(async () => {
  ws = await createFixtureWorkspace();
});
afterAll(async () => {
  await ws.cleanup();
});

const gd = (repo: FixtureRepo) => join(repo.dir, ".git");
const subject = async (repo: FixtureRepo) =>
  (await repo.git(["log", "-1", "--format=%s"])).stdout.trim();
const body = async (repo: FixtureRepo) =>
  (await repo.git(["log", "-1", "--format=%B"])).stdout;

/** main: base; feature branch adds `feature.txt`; back on main. Returns the pick oid. */
const seedPickable = async (repo: FixtureRepo): Promise<string> => {
  await repo.commit({
    message: "base",
    files: { "a.txt": "a\n" },
    date: fixtureDate(1),
  });
  await repo.checkout("feature", { create: true });
  const pick = await repo.commit({
    message: "add feature",
    files: { "feature.txt": "f\n" },
    date: fixtureDate(2),
  });
  await repo.checkout("main");
  return pick;
};

/** A divergent edit of a.txt on feature vs main → cherry-pick conflicts. */
const seedPickConflict = async (repo: FixtureRepo): Promise<string> => {
  await repo.commit({
    message: "base",
    files: { "a.txt": "base\n" },
    date: fixtureDate(1),
  });
  await repo.checkout("feature", { create: true });
  const feat = await repo.commit({
    message: "feature edit",
    files: { "a.txt": "feat\n" },
    date: fixtureDate(2),
  });
  await repo.checkout("main");
  await repo.commit({
    message: "main edit",
    files: { "a.txt": "main\n" },
    date: fixtureDate(3),
  });
  return feat;
};

describe("cherryPick (REQ-CP-001..008; AC-1/2/3/4(08))", () => {
  test("single commit applies and commits (completed)", async () => {
    const repo = await ws.createRepo("cp-single");
    const pick = await seedPickable(repo);

    const r = await run(cherryPick(repo.dir, gd(repo), "none", [pick], {}));
    expect(r.outcome).toBe("completed");
    expect(r.committed).toBe(1);
    expect(r.newCommitOid).toBeDefined();
    expect(existsSync(join(repo.dir, "feature.txt"))).toBe(true);
  });

  test("-x records the provenance line (AC-1)", async () => {
    const repo = await ws.createRepo("cp-x");
    const pick = await seedPickable(repo);

    await run(
      cherryPick(repo.dir, gd(repo), "none", [pick], { recordOrigin: true }),
    );
    expect(await body(repo)).toContain(`(cherry picked from commit ${pick})`);
  });

  test("--no-commit stages without committing (AC-4)", async () => {
    const repo = await ws.createRepo("cp-nocommit");
    const pick = await seedPickable(repo);
    const head = await repo.revParse("HEAD");

    const r = await run(
      cherryPick(repo.dir, gd(repo), "none", [pick], { noCommit: true }),
    );
    expect(r.outcome).toBe("staged");
    expect(await repo.revParse("HEAD")).toBe(head);
    expect(
      (await repo.git(["diff", "--cached", "--name-only"])).stdout,
    ).toContain("feature.txt");
  });

  test("a conflicting pick stops with conflicts + the current commit (AC-2)", async () => {
    const repo = await ws.createRepo("cp-conflict");
    const feat = await seedPickConflict(repo);

    const r = await run(cherryPick(repo.dir, gd(repo), "none", [feat], {}));
    expect(r.outcome).toBe("conflicts");
    expect(r.currentOid).toBe(feat);
    expect(existsSync(join(gd(repo), "CHERRY_PICK_HEAD"))).toBe(true);
  });

  test("an already-applied pick reports empty, not error (REQ-CP-006)", async () => {
    const repo = await ws.createRepo("cp-empty");
    const pick = await seedPickable(repo);
    await run(cherryPick(repo.dir, gd(repo), "none", [pick], {}));

    const r = await run(cherryPick(repo.dir, gd(repo), "none", [pick], {}));
    expect(r.outcome).toBe("empty");
  });

  test("a merge commit without a mainline is refused (AC-3)", async () => {
    const repo = await ws.createRepo("cp-merge");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    await repo.checkout("side", { create: true });
    await repo.commit({
      message: "side",
      files: { "s.txt": "s\n" },
      date: fixtureDate(2),
    });
    await repo.checkout("main");
    await repo.commit({
      message: "mainline",
      files: { "m.txt": "m\n" },
      date: fixtureDate(3),
    });
    await repo.merge("side", { noFastForward: true });
    const mergeOid = await repo.revParse("HEAD");
    await repo.checkout("base-branch", { create: true });
    await repo.git(["reset", "--hard", "HEAD~2"]);

    const err = await run(
      Effect.flip(cherryPick(repo.dir, gd(repo), "none", [mergeOid], {})),
    );
    expect(err.code).toBe("gitFailed");
    // With a mainline chosen it proceeds (does not hit the mainline guard).
    const r = await run(
      cherryPick(repo.dir, gd(repo), "none", [mergeOid], { mainline: 1 }),
    );
    expect(["completed", "conflicts", "empty"]).toContain(r.outcome);
  });

  test("refuses when picked paths overlap dirty tracked paths (REQ-CP-007)", async () => {
    const repo = await ws.createRepo("cp-dirty");
    await repo.commit({
      message: "base",
      files: { "feature.txt": "main\n" },
      date: fixtureDate(1),
    });
    await repo.checkout("feature", { create: true });
    const feat = await repo.commit({
      message: "feat edit",
      files: { "feature.txt": "feat\n" },
      date: fixtureDate(2),
    });
    await repo.checkout("main");
    await repo.writeFile("feature.txt", "dirty\n");

    const err = await run(
      Effect.flip(cherryPick(repo.dir, gd(repo), "none", [feat], {})),
    );
    expect(err.code).toBe("dirtyWorkingTree");
  });

  test("refuses to start while another operation is in progress (REQ-EDGE-007)", async () => {
    const repo = await ws.createRepo("cp-locked");
    const pick = await seedPickable(repo);

    const err = await run(
      Effect.flip(cherryPick(repo.dir, gd(repo), "cherryPick", [pick], {})),
    );
    expect(err.code).toBe("repoLocked");
  });
});

describe("revert (REQ-RV-001..005; AC-5(08))", () => {
  test("single commit creates an inverse commit", async () => {
    const repo = await ws.createRepo("rv-single");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    const add = await repo.commit({
      message: "add b",
      files: { "b.txt": "b\n" },
      date: fixtureDate(2),
    });

    const r = await run(revert(repo.dir, gd(repo), "none", [add], {}));
    expect(r.outcome).toBe("completed");
    expect(existsSync(join(repo.dir, "b.txt"))).toBe(false);
  });

  test("honors a custom commit message", async () => {
    const repo = await ws.createRepo("rv-message");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    const add = await repo.commit({
      message: "add b",
      files: { "b.txt": "b\n" },
      date: fixtureDate(2),
    });

    await run(
      revert(repo.dir, gd(repo), "none", [add], { message: "undo the b file" }),
    );
    expect(await subject(repo)).toBe("undo the b file");
  });
});

describe("continue / abort / skip (REQ-CN-007/008/009; AC-8/9/10(08))", () => {
  test("continue completes after the conflict is resolved (AC-8)", async () => {
    const repo = await ws.createRepo("seq-continue");
    const feat = await seedPickConflict(repo);
    await run(cherryPick(repo.dir, gd(repo), "none", [feat], {}));
    await repo.git(["checkout", "--theirs", "--", "a.txt"]);
    await repo.git(["add", "--", "a.txt"]);

    const r = await run(
      opContinue(repo.dir, gd(repo), detectInProgress(gd(repo)), {}),
    );
    expect(r.outcome).toBe("completed");
    expect(existsSync(join(gd(repo), "CHERRY_PICK_HEAD"))).toBe(false);
  });

  test("abort restores the pre-operation HEAD and clears the conflict (AC-9)", async () => {
    const repo = await ws.createRepo("seq-abort");
    const feat = await seedPickConflict(repo);
    const head = await repo.revParse("HEAD");
    await run(cherryPick(repo.dir, gd(repo), "none", [feat], {}));

    await run(opAbort(repo.dir, detectInProgress(gd(repo))));
    expect(await repo.revParse("HEAD")).toBe(head);
    expect(existsSync(join(gd(repo), "CHERRY_PICK_HEAD"))).toBe(false);
  });

  test("skip drops the current commit (AC-10)", async () => {
    const repo = await ws.createRepo("seq-skip");
    const feat = await seedPickConflict(repo);
    await run(cherryPick(repo.dir, gd(repo), "none", [feat], {}));

    const r = await run(opSkip(repo.dir, gd(repo), detectInProgress(gd(repo))));
    expect(r.outcome).toBe("completed");
    expect(existsSync(join(gd(repo), "CHERRY_PICK_HEAD"))).toBe(false);
  });

  test("skip is rejected for a merge; abort/continue reject when idle", async () => {
    const repo = await ws.createRepo("seq-guards");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    const skipErr = await run(Effect.flip(opSkip(repo.dir, gd(repo), "merge")));
    expect(skipErr.code).toBe("gitFailed");
    const abortErr = await run(Effect.flip(opAbort(repo.dir, "none")));
    expect(abortErr.code).toBe("gitFailed");
  });
});

describe("more sequencer branches", () => {
  test("a range applies oldest→newest and commits each (AC-2)", async () => {
    const repo = await ws.createRepo("cp-range");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    await repo.checkout("feature", { create: true });
    const f1 = await repo.commit({
      message: "f1",
      files: { "x.txt": "x\n" },
      date: fixtureDate(2),
    });
    const f2 = await repo.commit({
      message: "f2",
      files: { "y.txt": "y\n" },
      date: fixtureDate(3),
    });
    await repo.checkout("main");

    const r = await run(cherryPick(repo.dir, gd(repo), "none", [f1, f2], {}));
    expect(r.outcome).toBe("completed");
    expect(r.committed).toBe(2);
    expect(existsSync(join(repo.dir, "x.txt"))).toBe(true);
    expect(existsSync(join(repo.dir, "y.txt"))).toBe(true);
  });

  test("revert --no-commit stages the inverse without committing", async () => {
    const repo = await ws.createRepo("rv-nocommit");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    const add = await repo.commit({
      message: "add b",
      files: { "b.txt": "b\n" },
      date: fixtureDate(2),
    });
    const head = await repo.revParse("HEAD");

    const r = await run(
      revert(repo.dir, gd(repo), "none", [add], { noCommit: true }),
    );
    expect(r.outcome).toBe("staged");
    expect(await repo.revParse("HEAD")).toBe(head);
  });

  test("continue with a custom message commits the resolution under it", async () => {
    const repo = await ws.createRepo("cont-message");
    const feat = await seedPickConflict(repo);
    await run(cherryPick(repo.dir, gd(repo), "none", [feat], {}));
    await repo.git(["checkout", "--theirs", "--", "a.txt"]);
    await repo.git(["add", "--", "a.txt"]);

    const r = await run(
      opContinue(repo.dir, gd(repo), detectInProgress(gd(repo)), {
        message: "resolved the pick",
      }),
    );
    expect(r.outcome).toBe("completed");
    expect(await subject(repo)).toBe("resolved the pick");
  });

  test("continue with allowEmpty records the empty pick (REQ-CP-006)", async () => {
    const repo = await ws.createRepo("cont-empty");
    await repo.commit({
      message: "base",
      files: { "a.txt": "a\n" },
      date: fixtureDate(1),
    });
    await repo.checkout("feature", { create: true });
    const featY = await repo.commit({
      message: "add y",
      files: { "y.txt": "y\n" },
      date: fixtureDate(2),
    });
    await repo.checkout("main");
    await run(cherryPick(repo.dir, gd(repo), "none", [featY], {}));
    const empty = await run(
      cherryPick(repo.dir, gd(repo), "none", [featY], {}),
    );
    expect(empty.outcome).toBe("empty");

    const r = await run(
      opContinue(repo.dir, gd(repo), detectInProgress(gd(repo)), {
        allowEmpty: true,
      }),
    );
    expect(r.outcome).toBe("completed");
    expect(existsSync(join(gd(repo), "CHERRY_PICK_HEAD"))).toBe(false);
  });

  test("merge continue commits the resolved merge (AC-4(11))", async () => {
    const repo = await ws.createRepo("merge-continue");
    await seedConflict(repo);
    await repo.git(["checkout", "--theirs", "--", "f.txt"]);
    await repo.git(["add", "--", "f.txt"]);

    const r = await run(opContinue(repo.dir, gd(repo), "merge", {}));
    expect(r.outcome).toBe("completed");
    expect(existsSync(join(gd(repo), "MERGE_HEAD"))).toBe(false);
  });

  test("a genuinely failing pick surfaces gitFailed", async () => {
    const repo = await ws.createRepo("cp-bogus");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });

    const err = await run(
      Effect.flip(cherryPick(repo.dir, gd(repo), "none", ["0".repeat(40)], {})),
    );
    expect(err.code).toBe("gitFailed");
  });
});
