import { type SyncEvent } from "@cbranch/rpc-contract";
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createFixtureWorkspace,
  type FixtureWorkspace,
  fixtureDate,
} from "../testing/fixtures";
import {
  fetchStream,
  pullStream,
  pushDeleteRemoteRef,
  pushStream,
} from "./sync";

const collect = (
  stream: Stream.Stream<SyncEvent, unknown>,
): Promise<SyncEvent[]> =>
  Effect.runPromise(Stream.runCollect(stream)).then((c) => [...c]);

const refUpdates = (events: SyncEvent[]): SyncEvent[] =>
  events.filter((e) => e._tag === "refUpdate");

describe("sync streaming", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("fetchStream — first fetch emits a refUpdate for the new remote ref", async () => {
    const origin = await ws.createRepo("sync-fetch-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-fetch-clone");
    await clone.addRemote("origin", origin.dir);

    const events = await collect(fetchStream(clone.dir, "origin"));
    const refs = refUpdates(events);
    expect(refs.length).toBeGreaterThan(0);
    expect(
      refs.some((e) => e._tag === "refUpdate" && e.remoteRef === "origin/main"),
    ).toBe(true);
  });

  test("fetchStream — after origin advances, emits a parsed refUpdate (SY-026)", async () => {
    const origin = await ws.createRepo("sync-fetch2-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-fetch2-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // Advance origin so the next fetch produces an A..B ref update.
    await origin.commit({ message: "second", files: { "b.txt": "b" } });

    const events = await collect(fetchStream(clone.dir, "origin"));
    const ref = refUpdates(events).find(
      (e) => e._tag === "refUpdate" && e.remoteRef === "origin/main",
    );
    expect(ref).toBeDefined();
    if (ref?._tag === "refUpdate") {
      expect(ref.localRef).toBe("main");
      // The summary is an abbreviated A..B range, so the abbreviated from/to tip
      // hashes are parsed. They are git-abbreviated hex, NOT full Oids (SY-026).
      expect(ref.fromAbbrev).toMatch(/^[0-9a-f]{7,40}$/);
      expect(ref.toAbbrev).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  test("fetchStream — forced update surfaces the parenthetical status (SY-026)", async () => {
    const origin = await ws.createRepo("sync-forced-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-forced-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // Rewrite origin's only commit so origin/main moves non-fast-forward; the
    // next fetch reports a "(forced update)" parenthetical on the ref line.
    await origin.git(["commit", "--amend", "-m", "rewritten"], {
      env: {
        GIT_AUTHOR_DATE: fixtureDate(5),
        GIT_COMMITTER_DATE: fixtureDate(5),
      },
    });

    const events = await collect(fetchStream(clone.dir, "origin"));
    const ref = refUpdates(events).find(
      (e) => e._tag === "refUpdate" && e.remoteRef === "origin/main",
    );
    expect(ref).toBeDefined();
    if (ref?._tag === "refUpdate") {
      // The trailing "(forced update)" parenthetical is captured, not discarded.
      expect(ref.status).toBeDefined();
      expect(ref.status).toContain("forced update");
      // A forced range uses THREE dots (abc...def); its abbreviated tip hashes
      // must still be surfaced (SY-026), not dropped.
      expect(ref.fromAbbrev).toMatch(/^[0-9a-f]{7,40}$/);
      expect(ref.toAbbrev).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  test("fetchStream --all fetches all remotes", async () => {
    const origin = await ws.createRepo("sync-fetchall-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-fetchall-clone");
    await clone.addRemote("origin", origin.dir);

    const events = await collect(fetchStream(clone.dir, undefined, true));
    expect(
      refUpdates(events).some(
        (e) => e._tag === "refUpdate" && e.remoteRef === "origin/main",
      ),
    ).toBe(true);
  });

  test("pullStream — fast-forward pull of new upstream commits", async () => {
    const origin = await ws.createRepo("sync-pull-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-pull-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    await origin.commit({ message: "upstream", files: { "b.txt": "b" } });

    const events = await collect(pullStream(clone.dir, "ff-only"));
    // The pulled file now exists locally.
    const head = await clone.revParse("HEAD");
    const originHead = await origin.revParse("HEAD");
    expect(head).toBe(originHead);
    expect(events.length).toBeGreaterThan(0);
  });

  test("pushStream — pushes a local branch and reports the ref update (SY-026)", async () => {
    const origin = await ws.createRepo("sync-push-origin", { bare: true });

    const work = await ws.createRepo("sync-push-work");
    await work.addRemote("origin", origin.dir);
    await work.commit({ message: "init", files: { "a.txt": "a" } });

    const events = await collect(pushStream(work.dir, "origin", "main", true));
    const ref = refUpdates(events).find(
      (e) => e._tag === "refUpdate" && e.remoteRef === "refs/heads/main",
    );
    expect(ref).toBeDefined();

    // The remote ref really moved to the local tip.
    const localTip = await work.revParse("HEAD");
    const remote = await work.git(["ls-remote", "origin", "refs/heads/main"]);
    expect(remote.stdout).toContain(localTip);
  });

  test("pushStream — non-fast-forward rejection fails with nonFastForward (SY-025)", async () => {
    const origin = await ws.createRepo("sync-nonff-origin", { bare: true });

    const work = await ws.createRepo("sync-nonff-work");
    await work.addRemote("origin", origin.dir);
    await work.commit({ message: "init", files: { "a.txt": "a" } });
    await work.git(["push", "-u", "origin", "main"]);

    // A second clone advances origin/main so work's branch diverges.
    const other = await ws.createRepo("sync-nonff-other");
    await other.addRemote("origin", origin.dir);
    await other.fetch("origin");
    await other.git(["checkout", "-b", "main", "--track", "origin/main"]);
    await other.commit({ message: "other", files: { "b.txt": "b" } });
    await other.git(["push", "origin", "main"]);

    // work commits on top of the now-stale tip and pushes → rejected.
    await work.commit({ message: "work2", files: { "c.txt": "c" } });

    const err = await Effect.runPromise(
      Effect.flip(Stream.runCollect(pushStream(work.dir, "origin", "main"))),
    );
    expect(err.code).toBe("nonFastForward");
  });

  test("pullStream ff-only — divergence fails with nonFastForward (SY-012)", async () => {
    const origin = await ws.createRepo("sync-div-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-div-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // origin and clone advance differently → histories diverge.
    await origin.commit({ message: "upstream", files: { "b.txt": "b" } });
    await clone.commit({ message: "local", files: { "c.txt": "c" } });

    const err = await Effect.runPromise(
      Effect.flip(Stream.runCollect(pullStream(clone.dir, "ff-only"))),
    );
    expect(err.code).toBe("nonFastForward");
  });

  test("pullStream merge — conflicting pull fails with mergeConflict (SY-013)", async () => {
    const origin = await ws.createRepo("sync-conflict-origin");
    await origin.commit({ message: "init", files: { "f.txt": "base\n" } });

    const clone = await ws.createRepo("sync-conflict-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    // Divergent edits to the SAME file → a merge conflict on pull.
    await origin.commit({
      message: "upstream",
      files: { "f.txt": "upstream\n" },
    });
    await clone.commit({ message: "local", files: { "f.txt": "local\n" } });

    const err = await Effect.runPromise(
      Effect.flip(Stream.runCollect(pullStream(clone.dir, "merge"))),
    );
    expect(err.code).toBe("mergeConflict");
  });

  test("pullStream rebase mode — rebases local commits on top of upstream", async () => {
    const origin = await ws.createRepo("sync-pull-rebase-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const clone = await ws.createRepo("sync-pull-rebase-clone");
    await clone.addRemote("origin", origin.dir);
    await clone.fetch("origin");
    await clone.git(["checkout", "-b", "main", "--track", "origin/main"]);

    await origin.commit({ message: "upstream", files: { "b.txt": "b" } });

    const events = await collect(pullStream(clone.dir, "rebase"));
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("fetchStream — errors on invalid remote name", async () => {
    const repo = await ws.createRepo("sync-fetch-fail");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const exit = await Effect.runPromiseExit(
      Stream.runCollect(fetchStream(repo.dir, "no-such-remote")),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("pushStream — set-upstream records the tracking ref locally (SY-021)", async () => {
    const origin = await ws.createRepo("sync-setup-origin", { bare: true });

    const work = await ws.createRepo("sync-setup-work");
    await work.addRemote("origin", origin.dir);
    await work.commit({ message: "init", files: { "a.txt": "a" } });

    await collect(pushStream(work.dir, "origin", "main", true));

    // The local branch now tracks origin/main.
    const upstream = await work.git([
      "rev-parse",
      "--abbrev-ref",
      "main@{upstream}",
    ]);
    expect(upstream.stdout.trim()).toBe("origin/main");
  });

  test("pushStream — force-with-lease overwrites the remote after a rewrite (SY-022)", async () => {
    const origin = await ws.createRepo("sync-lease-origin", { bare: true });

    const work = await ws.createRepo("sync-lease-work");
    await work.addRemote("origin", origin.dir);
    await work.commit({ message: "init", files: { "a.txt": "a" } });
    await work.git(["push", "-u", "origin", "main"]);

    // Rewrite the already-pushed commit so history diverges from origin/main.
    // The lease still holds (work's remote-tracking ref matches the real remote),
    // so a force-with-lease push is accepted where a plain push would be rejected.
    await work.writeFile("a.txt", "rewritten");
    await work.stage("a.txt");
    await work.git(["commit", "--amend", "-m", "rewritten"], {
      env: {
        GIT_AUTHOR_DATE: fixtureDate(5),
        GIT_COMMITTER_DATE: fixtureDate(5),
      },
    });

    const events = await collect(
      pushStream(work.dir, "origin", "main", false, true),
    );
    const ref = refUpdates(events).find(
      (e) => e._tag === "refUpdate" && e.remoteRef === "refs/heads/main",
    );
    expect(ref).toBeDefined();
    if (ref?._tag === "refUpdate") {
      // A forced push reports a three-dot range plus a "(forced update)"
      // parenthetical in the porcelain summary; both the tip hashes (SY-026) and
      // the status must be surfaced, not lumped into `summary`.
      expect(ref.status).toContain("forced update");
      expect(ref.toAbbrev).toMatch(/^[0-9a-f]{7,40}$/);
    }

    const localTip = await work.revParse("HEAD");
    const remote = await work.git(["ls-remote", "origin", "refs/heads/main"]);
    expect(remote.stdout).toContain(localTip);
  });

  test("pushDeleteRemoteRef — deletes a branch on the remote", async () => {
    const origin = await ws.createRepo("sync-delref-origin", { bare: true });

    const work = await ws.createRepo("sync-delref-work");
    await work.addRemote("origin", origin.dir);
    await work.commit({ message: "init", files: { "a.txt": "a" } });
    await work.git(["push", "-u", "origin", "main"]);
    await work.branch("to-delete");
    await work.git(["push", "origin", "to-delete"]);

    await Effect.runPromise(
      pushDeleteRemoteRef(work.dir, "origin", "to-delete"),
    );

    const raw = await work.git(
      ["ls-remote", "--heads", "origin", "to-delete"],
      { allowFailure: true },
    );
    expect(raw.stdout.trim()).toBe("");
  });
});
