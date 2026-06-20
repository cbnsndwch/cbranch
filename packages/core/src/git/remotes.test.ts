import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createFixtureWorkspace, type FixtureWorkspace } from "../testing/fixtures";
import { remoteAdd, remoteList, remoteRemove, remoteRename, remoteSetUrl } from "./remotes";

describe("remote CRUD", () => {
  let ws: FixtureWorkspace;

  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });

  afterAll(async () => {
    await ws.cleanup();
  });

  test("remoteList — empty repo has no remotes", async () => {
    const repo = await ws.createRepo("rm-empty");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    const remotes = await Effect.runPromise(remoteList(repo.dir));
    expect(remotes).toHaveLength(0);
  });

  test("remoteAdd + remoteList round-trip", async () => {
    const origin = await ws.createRepo("rm-add-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const repo = await ws.createRepo("rm-add-repo");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });

    await Effect.runPromise(remoteAdd(repo.dir, "origin", origin.dir));

    const remotes = await Effect.runPromise(remoteList(repo.dir));
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.name).toBe("origin");
    expect(remotes[0]?.fetchUrl).toBe(origin.dir);
  });

  test("remoteSetUrl updates the fetch URL", async () => {
    const a = await ws.createRepo("rm-seturl-a");
    await a.commit({ message: "init", files: { "a.txt": "a" } });
    const b = await ws.createRepo("rm-seturl-b");
    await b.commit({ message: "init", files: { "b.txt": "b" } });

    const repo = await ws.createRepo("rm-seturl-repo");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.addRemote("origin", a.dir);

    await Effect.runPromise(remoteSetUrl(repo.dir, "origin", b.dir));

    const remotes = await Effect.runPromise(remoteList(repo.dir));
    expect(remotes[0]?.fetchUrl).toBe(b.dir);
  });

  test("remoteRename changes the remote name", async () => {
    const origin = await ws.createRepo("rm-rename-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const repo = await ws.createRepo("rm-rename-repo");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.addRemote("origin", origin.dir);

    await Effect.runPromise(remoteRename(repo.dir, "origin", "upstream"));

    const remotes = await Effect.runPromise(remoteList(repo.dir));
    expect(remotes).toHaveLength(1);
    expect(remotes[0]?.name).toBe("upstream");
  });

  test("remoteRemove removes the remote", async () => {
    const origin = await ws.createRepo("rm-remove-origin");
    await origin.commit({ message: "init", files: { "a.txt": "a" } });

    const repo = await ws.createRepo("rm-remove-repo");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.addRemote("origin", origin.dir);

    await Effect.runPromise(remoteRemove(repo.dir, "origin"));

    const remotes = await Effect.runPromise(remoteList(repo.dir));
    expect(remotes).toHaveLength(0);
  });

  test("remoteSetUrl with push=true sets the push URL separately", async () => {
    const a = await ws.createRepo("rm-pushurl-a");
    await a.commit({ message: "init", files: { "a.txt": "a" } });
    const b = await ws.createRepo("rm-pushurl-b");
    await b.commit({ message: "init", files: { "b.txt": "b" } });

    const repo = await ws.createRepo("rm-pushurl-repo");
    await repo.commit({ message: "init", files: { "a.txt": "a" } });
    await repo.addRemote("origin", a.dir);

    await Effect.runPromise(remoteSetUrl(repo.dir, "origin", b.dir, true));

    const remotes = await Effect.runPromise(remoteList(repo.dir));
    expect(remotes[0]?.fetchUrl).toBe(a.dir);
    expect(remotes[0]?.pushUrl).toBe(b.dir);
  });
});
