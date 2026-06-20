import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import {
  tagCreate,
  tagDelete,
  tagDeleteRemote,
  tagList,
  tagPush,
} from "./tags";

describe("tagList", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("empty repo with no commits returns empty array", async () => {
    const repo = await ws.createRepo("tl-empty");
    // No commits — no tags possible
    const tags = await Effect.runPromise(tagList(repo.dir));
    expect(tags).toHaveLength(0);
  });

  test("lightweight tag is listed with isAnnotated=false", async () => {
    const repo = await ws.createRepo("tl-lw");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.tag("v0.1.0");

    const tags = await Effect.runPromise(tagList(repo.dir));
    expect(tags).toHaveLength(1);
    const t = tags[0];
    expect(t?.name).toBe("v0.1.0");
    expect(t?.fullRef).toBe("refs/tags/v0.1.0");
    expect(t?.isAnnotated).toBe(false);
    expect(t?.taggerName).toBeUndefined();
    expect(t?.taggerEmail).toBeUndefined();
    expect(t?.taggerDate).toBeUndefined();
    expect(t?.objectOid).toMatch(/^[0-9a-f]{40}$/);
    expect(t?.targetOid).toMatch(/^[0-9a-f]{40}$/);
    // For lightweight: objectOid === targetOid (both point at the commit)
    expect(t?.objectOid).toBe(t?.targetOid);
  });

  test("annotated tag is listed with isAnnotated=true and tagger info", async () => {
    const repo = await ws.createRepo("tl-ann");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.tag("v1.0.0", { annotated: true, message: "Release 1.0" });

    const tags = await Effect.runPromise(tagList(repo.dir));
    expect(tags).toHaveLength(1);
    const t = tags[0];
    expect(t?.name).toBe("v1.0.0");
    expect(t?.isAnnotated).toBe(true);
    expect(t?.taggerName).toBe("Cb Tester");
    expect(t?.taggerEmail).toBe("tester@cbranch.test");
    expect(t?.taggerDate).toBeGreaterThan(0);
    expect(t?.subject).toBe("Release 1.0");
    // For annotated: objectOid is the tag object; targetOid is the commit
    expect(t?.objectOid).toMatch(/^[0-9a-f]{40}$/);
    expect(t?.targetOid).toMatch(/^[0-9a-f]{40}$/);
    expect(t?.objectOid).not.toBe(t?.targetOid);
  });

  test("multiple tags are all listed", async () => {
    const repo = await ws.createRepo("tl-multi");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.tag("v1.0.0");
    await repo.tag("v2.0.0", { annotated: true, message: "v2" });
    await repo.commit({ message: "next", files: { "b.txt": "b" } });
    await repo.tag("v3.0.0");

    const tags = await Effect.runPromise(tagList(repo.dir));
    expect(tags).toHaveLength(3);
    const names = tags.map((t) => t.name).toSorted();
    expect(names).toEqual(["v1.0.0", "v2.0.0", "v3.0.0"]);
  });
});

describe("tagCreate", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("creates a lightweight tag and returns TagInfo", async () => {
    const repo = await ws.createRepo("tc-lw");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const tag = await Effect.runPromise(
      tagCreate(repo.dir, "v1.0.0", { tagType: "lightweight" }),
    );
    expect(tag.name).toBe("v1.0.0");
    expect(tag.fullRef).toBe("refs/tags/v1.0.0");
    expect(tag.isAnnotated).toBe(false);
    expect(tag.objectOid).toMatch(/^[0-9a-f]{40}$/);
  });

  test("creates an annotated tag with message and returns TagInfo", async () => {
    const repo = await ws.createRepo("tc-ann");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const tag = await Effect.runPromise(
      tagCreate(repo.dir, "v1.0.0", {
        tagType: "annotated",
        message: "First release",
      }),
    );
    expect(tag.name).toBe("v1.0.0");
    expect(tag.isAnnotated).toBe(true);
    expect(tag.subject).toBe("First release");
    expect(tag.taggerName).toBe("Cb Tester");
  });

  test("duplicate tag name without force fails with refExists", async () => {
    const repo = await ws.createRepo("tc-dup");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.tag("v1.0.0");

    await expect(
      Effect.runPromise(
        tagCreate(repo.dir, "v1.0.0", { tagType: "lightweight" }),
      ),
    ).rejects.toMatchObject({
      code: "refExists",
    });
  });

  test("tagCreate with invalid target SHA — fails with gitFailed", async () => {
    const repo = await ws.createRepo("tc-bad-target");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await expect(
      Effect.runPromise(
        tagCreate(repo.dir, "v1.0.0", {
          tagType: "lightweight",
          target: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        }),
      ),
    ).rejects.toMatchObject({ code: "gitFailed" });
  });

  test("signed tag type — fails gracefully with gitFailed when gpg not available", async () => {
    const repo = await ws.createRepo("tc-signed");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const exit = await Effect.runPromiseExit(
      tagCreate(repo.dir, "v1.0.0-signed", { tagType: "signed" }),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("force-creates overwrites existing tag", async () => {
    const repo = await ws.createRepo("tc-force");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    const oid1 = await repo.revParse("HEAD");
    await repo.commit({ message: "second", files: { "b.txt": "b" } });
    const oid2 = await repo.revParse("HEAD");

    // Tag at first commit
    await repo.tag("v1.0.0", { ref: oid1 });
    // Force-move to second commit
    const tag = await Effect.runPromise(
      tagCreate(repo.dir, "v1.0.0", {
        tagType: "lightweight",
        force: true,
        target: oid2,
      }),
    );
    expect(tag.name).toBe("v1.0.0");
    expect(tag.targetOid).toBe(oid2);
  });
});

describe("tagDelete", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("deletes a local tag", async () => {
    const repo = await ws.createRepo("td-basic");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.tag("v1.0.0");

    await Effect.runPromise(tagDelete(repo.dir, "v1.0.0"));

    const tags = await Effect.runPromise(tagList(repo.dir));
    expect(tags).toHaveLength(0);
  });
});

describe("tagPush / tagDeleteRemote", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("tagPush pushes a specific tag to a remote", async () => {
    const origin = await ws.createRepo("tp-origin", { bare: true });
    const clone = await ws.createRepo("tp-clone");
    await clone.commit({ message: "init", files: { "a.txt": "a" } });
    await clone.addRemote("origin", origin.dir);
    await clone.git(["push", "-u", "origin", "main"]);
    await clone.tag("v1.0.0");

    await Effect.runPromise(tagPush(clone.dir, "origin", { name: "v1.0.0" }));

    // Verify tag now exists in origin
    const result = await origin.git(["tag", "-l"]);
    expect(result.stdout.trim()).toBe("v1.0.0");
  });

  test("tagDeleteRemote removes tag from remote", async () => {
    const origin = await ws.createRepo("tdr-origin", { bare: true });
    const clone = await ws.createRepo("tdr-clone");
    await clone.commit({ message: "init", files: { "a.txt": "a" } });
    await clone.addRemote("origin", origin.dir);
    await clone.git(["push", "-u", "origin", "main"]);
    await clone.tag("v2.0.0");
    await clone.git(["push", "origin", "refs/tags/v2.0.0"]);

    await Effect.runPromise(tagDeleteRemote(clone.dir, "origin", "v2.0.0"));

    const result = await origin.git(["tag", "-l"]);
    expect(result.stdout.trim()).toBe("");
  });

  test("tagPush with all:true pushes all tags to remote", async () => {
    const origin = await ws.createRepo("tpa-origin", { bare: true });
    const clone = await ws.createRepo("tpa-clone");
    await clone.commit({ message: "init", files: { "a.txt": "a" } });
    await clone.addRemote("origin", origin.dir);
    await clone.git(["push", "-u", "origin", "main"]);
    await clone.tag("v1.0.0");
    await clone.tag("v2.0.0");

    await Effect.runPromise(tagPush(clone.dir, "origin", { all: true }));

    const result = await origin.git(["tag", "-l"]);
    const remoteTags = result.stdout.trim().split("\n").toSorted();
    expect(remoteTags).toEqual(["v1.0.0", "v2.0.0"]);
  });

  test("tagPush with no opts — pushes all tags as default", async () => {
    const origin = await ws.createRepo("tpd-origin", { bare: true });
    const clone = await ws.createRepo("tpd-clone");
    await clone.commit({ message: "init", files: { "a.txt": "a" } });
    await clone.addRemote("origin", origin.dir);
    await clone.git(["push", "-u", "origin", "main"]);
    await clone.tag("v3.0.0");

    // No opts → push all tags
    await Effect.runPromise(tagPush(clone.dir, "origin"));

    const result = await origin.git(["tag", "-l"]);
    expect(result.stdout.trim()).toBe("v3.0.0");
  });
});
