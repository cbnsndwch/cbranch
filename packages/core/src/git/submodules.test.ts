import { existsSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureWorkspace,
} from "../testing/fixtures";
import {
  combineSubmodules,
  parseGitlinks,
  parseGitmodules,
  parseSubmoduleStatus,
  submoduleAdd,
  submoduleAddArgs,
  submoduleList,
  submoduleRemove,
  submoduleSync,
  submoduleSyncArgs,
  submoduleUpdate,
  submoduleUpdateArgs,
} from "./submodules";

// Enables `protocol.file.allow=always` for THIS test only (local-file submodule
// clone/init); production never bypasses git's CVE-2022-39253 guard. Honored by git
// exactly like `-c protocol.file.allow=always`, and inherited by child git processes.
const PROTO_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

const hex = (c: string) => c.repeat(40);

describe("submodule parsers (pure)", () => {
  test("parseGitlinks keeps gitlinks, drops files, marks conflict stages", () => {
    const stage = [
      `160000 ${hex("a")} 0\ta`,
      `160000 ${hex("d")} 1\td`,
      `160000 ${hex("e")} 2\td`,
      `160000 ${hex("f")} 3\td`,
      `100644 ${hex("2")} 0\treadme.txt`,
    ]
      .map((r) => `${r}\0`)
      .join("");
    const links = parseGitlinks(stage);
    expect([...links.keys()].sort()).toEqual(["a", "d"]);
    expect(links.get("a")).toEqual({
      stage0Oid: hex("a"),
      hasConflictStages: false,
    });
    // conflicted: stages 1/2/3 only, no stage 0.
    expect(links.get("d")?.stage0Oid).toBeUndefined();
    expect(links.get("d")?.hasConflictStages).toBe(true);
  });

  test("parseSubmoduleStatus matches spaced paths, extracts describe, drops unknowns", () => {
    const status = [
      ` ${hex("a")} a (v1)`,
      `-${hex("b")} b`,
      `+${hex("9")} c (heads/x)`,
      ` ${hex("1")} e f (vtag)`,
      ` ${hex("3")} ghost`,
    ].join("\n");
    const map = parseSubmoduleStatus(status, ["a", "b", "c", "e f"]);
    expect(map.get("a")).toEqual({
      prefix: " ",
      sha: hex("a"),
      describe: "v1",
    });
    expect(map.get("b")?.prefix).toBe("-");
    expect(map.get("c")).toEqual({
      prefix: "+",
      sha: hex("9"),
      describe: "heads/x",
    });
    // spaced path round-trips with its describe.
    expect(map.get("e f")).toEqual({
      prefix: " ",
      sha: hex("1"),
      describe: "vtag",
    });
    // a line for a path not in the gitlink set is dropped.
    expect(map.has("ghost")).toBe(false);
  });

  test("parseSubmoduleStatus prefers the longest matching path (no prefix shadow)", () => {
    const status = [` ${hex("a")} lib/sub (x)`, ` ${hex("b")} lib (y)`].join(
      "\n",
    );
    const map = parseSubmoduleStatus(status, ["lib", "lib/sub"]);
    expect(map.get("lib/sub")?.sha).toBe(hex("a"));
    expect(map.get("lib")?.sha).toBe(hex("b"));
  });

  test("parseGitmodules re-keys by path, splits dotted names, ignores foreign keys", () => {
    const gm = [
      "submodule.a.path\na",
      "submodule.a.url\nhttps://x/a.git",
      "submodule.a.branch\nmain",
      "submodule.lib.core.path\nc", // a name that itself contains a dot
      "submodule.lib.core.url\nhttps://x/c.git",
      "core.bare\nfalse", // a non-submodule key, ignored
    ]
      .map((r) => `${r}\0`)
      .join("");
    const map = parseGitmodules(gm);
    expect(map.get("a")).toEqual({
      name: "a",
      url: "https://x/a.git",
      branch: "main",
    });
    expect(map.get("c")).toEqual({
      name: "lib.core",
      url: "https://x/c.git",
      branch: undefined,
    });
    expect(map.has("core")).toBe(false);
  });

  test("combineSubmodules joins the three sources across the full status matrix", () => {
    const stage = [
      `160000 ${hex("a")} 0\ta`,
      `160000 ${hex("b")} 0\tb`,
      `160000 ${hex("c")} 0\tc`,
      `160000 ${hex("d")} 1\td`,
      `160000 ${hex("e")} 2\td`,
      `160000 ${hex("f")} 3\td`,
      `160000 ${hex("1")} 0\te f`,
      `100644 ${hex("2")} 0\treadme.txt`,
    ]
      .map((r) => `${r}\0`)
      .join("");
    const status = [
      ` ${hex("a")} a (v1)`,
      `-${hex("b")} b`,
      `+${hex("9")} c (heads/x)`,
      `U${hex("0")} d`,
      ` ${hex("1")} e f (vtag)`,
      ` ${hex("3")} ghost`,
    ].join("\n");
    const gm = [
      "submodule.a.path\na",
      "submodule.a.url\nhttps://x/a.git",
      "submodule.a.branch\nmain",
      "submodule.b.path\nb",
      "submodule.b.url\nhttps://x/b.git",
      "submodule.lib.core.path\nc",
      "submodule.lib.core.url\nhttps://x/c.git",
      "submodule.spaced.path\ne f",
      "submodule.spaced.url\nhttps://x/ef.git",
    ]
      .map((r) => `${r}\0`)
      .join("");

    const subs = combineSubmodules(stage, status, gm, "/srv/repo");
    expect(subs.map((s) => s.path)).toEqual(["a", "b", "c", "d", "e f"]);

    const [a, b, c, d, ef] = subs;
    // upToDate: recorded == checked-out, full enrichment.
    expect(a?.status).toBe("upToDate");
    expect(a?.recordedOid).toBe(hex("a"));
    expect(a?.checkedOutOid).toBe(hex("a"));
    expect(a?.name).toBe("a");
    expect(a?.url).toBe("https://x/a.git");
    expect(a?.branch).toBe("main");
    expect(a?.describe).toBe("v1");
    expect(a?.absPath).toBe(join("/srv/repo", "a"));
    // uninitialized: `submodule status` shows the RECORDED oid, but we omit checkedOut.
    expect(b?.status).toBe("uninitialized");
    expect(b?.recordedOid).toBe(hex("b"));
    expect(b?.checkedOutOid).toBeUndefined();
    // outOfSync: checked-out differs from recorded; dotted name split correctly.
    expect(c?.status).toBe("outOfSync");
    expect(c?.recordedOid).toBe(hex("c"));
    expect(c?.checkedOutOid).toBe(hex("9"));
    expect(c?.name).toBe("lib.core");
    // conflicted: stages 1/2/3 only → recordedOid ABSENT, no checked-out.
    expect(d?.status).toBe("conflicted");
    expect(d?.recordedOid).toBeUndefined();
    expect(d?.checkedOutOid).toBeUndefined();
    // spaced path survives the NUL-safe cross-read.
    expect(ef?.status).toBe("upToDate");
    expect(ef?.name).toBe("spaced");
    expect(ef?.describe).toBe("vtag");
    expect(ef?.absPath).toBe(join("/srv/repo", "e f"));
  });

  test("combineSubmodules on a repo with no submodules is empty", () => {
    expect(combineSubmodules("", "", "", "/srv/repo")).toEqual([]);
  });
});

describe("submodule argv builders (pure)", () => {
  test("update toggles --init/--recursive/--force and `-- <paths>`", () => {
    expect(submoduleUpdateArgs({})).toEqual(["submodule", "update"]);
    expect(
      submoduleUpdateArgs({
        init: true,
        recursive: true,
        force: true,
        paths: ["a", "b"],
      }),
    ).toEqual([
      "submodule",
      "update",
      "--init",
      "--recursive",
      "--force",
      "--",
      "a",
      "b",
    ]);
    // empty paths add no pathspec separator.
    expect(submoduleUpdateArgs({ paths: [] })).toEqual(["submodule", "update"]);
  });

  test("sync toggles --recursive and `-- <paths>`", () => {
    expect(submoduleSyncArgs({})).toEqual(["submodule", "sync"]);
    expect(submoduleSyncArgs({ recursive: true, paths: ["x"] })).toEqual([
      "submodule",
      "sync",
      "--recursive",
      "--",
      "x",
    ]);
  });

  test("add places url/path after `--`, branch as `-b`", () => {
    expect(submoduleAddArgs("https://x/a.git", "a")).toEqual([
      "submodule",
      "add",
      "--",
      "https://x/a.git",
      "a",
    ]);
    expect(submoduleAddArgs("https://x/a.git", "a", "dev")).toEqual([
      "submodule",
      "add",
      "-b",
      "dev",
      "--",
      "https://x/a.git",
      "a",
    ]);
  });
});

describe("submodule git operations", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  // A superproject with one initialized, up-to-date submodule at `lib`.
  const seedSuper = async (name: string) => {
    const child = await ws.createRepo(`${name}-child`);
    const childOid = await child.commit({
      message: "c1",
      files: { "lib.txt": "v1\n" },
    });
    const sup = await ws.createRepo(name);
    await sup.commit({ message: "init", files: { "README.md": "x\n" } });
    await sup.git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      child.dir,
      "lib",
    ]);
    await sup.commit({ message: "add lib" });
    return { sup, child, childOid, gitDir: join(sup.dir, ".git") };
  };

  test("list cross-reads gitlink + status + .gitmodules (upToDate)", async () => {
    const { sup, child, childOid } = await seedSuper("sm-list");
    const subs = await run(submoduleList(sup.dir));
    expect(subs).toHaveLength(1);
    const lib = subs[0];
    expect(lib?.path).toBe("lib");
    expect(lib?.name).toBe("lib");
    expect(lib?.status).toBe("upToDate");
    expect(lib?.recordedOid).toBe(childOid);
    expect(lib?.checkedOutOid).toBe(childOid);
    expect(lib?.url).toBe(child.dir);
    expect(lib?.absPath).toBe(join(sup.dir, "lib"));
  });

  test("a repo with no submodules lists empty (exit 0)", async () => {
    const repo = await ws.createRepo("sm-none");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    expect(await run(submoduleList(repo.dir))).toEqual([]);
  });

  test("deinit → uninitialized; update --init re-initializes", async () => {
    const { sup, childOid } = await seedSuper("sm-init");

    await sup.git(["submodule", "deinit", "-f", "--", "lib"]);
    const deinited = await run(submoduleList(sup.dir));
    expect(deinited[0]?.status).toBe("uninitialized");
    expect(deinited[0]?.recordedOid).toBe(childOid);
    expect(deinited[0]?.checkedOutOid).toBeUndefined();

    await run(submoduleUpdate(sup.dir, { init: true }, PROTO_ENV));
    const reinited = await run(submoduleList(sup.dir));
    expect(reinited[0]?.status).toBe("upToDate");
    expect(reinited[0]?.checkedOutOid).toBe(childOid);
  });

  test("sync on an initialized submodule succeeds (no-op)", async () => {
    const { sup } = await seedSuper("sm-sync");
    await run(submoduleSync(sup.dir, {}));
    // still listed, unchanged.
    expect(await run(submoduleList(sup.dir))).toHaveLength(1);
  });

  test("add registers a second submodule", async () => {
    const { sup, child } = await seedSuper("sm-add");
    await run(submoduleAdd(sup.dir, child.dir, "lib2", undefined, PROTO_ENV));
    const subs = await run(submoduleList(sup.dir));
    expect(subs.map((s) => s.path).sort()).toEqual(["lib", "lib2"]);
  });

  test("add refuses leading-dash url/path/branch (invalidRefName)", async () => {
    const repo = await ws.createRepo("sm-guard");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const url = await run(Effect.flip(submoduleAdd(repo.dir, "-evil", "x")));
    expect(url.code).toBe("invalidRefName");
    const path = await run(
      Effect.flip(submoduleAdd(repo.dir, "https://x/a.git", "-x")),
    );
    expect(path.code).toBe("invalidRefName");
    const branch = await run(
      Effect.flip(submoduleAdd(repo.dir, "https://x/a.git", "x", "-b")),
    );
    expect(branch.code).toBe("invalidRefName");
  });

  test("remove deinits, drops the gitlink, and clears the cached git dir", async () => {
    const { sup, gitDir } = await seedSuper("sm-remove");
    const cached = join(gitDir, "modules", "lib");
    expect(existsSync(cached)).toBe(true);

    await run(submoduleRemove(sup.dir, gitDir, "lib"));

    expect(await run(submoduleList(sup.dir))).toEqual([]);
    expect(existsSync(cached)).toBe(false);
  });

  test("remove clears the cached git dir by NAME when name != path", async () => {
    // git stores the cached git dir at modules/<name>, not modules/<path>; a
    // `--name`-added submodule (name "customname" at path "path/to/sub") would orphan
    // its object store if cleanup keyed off the path.
    const child = await ws.createRepo("nm-child");
    await child.commit({ message: "c1", files: { "lib.txt": "v1\n" } });
    const sup = await ws.createRepo("nm-super");
    await sup.commit({ message: "init", files: { "README.md": "x\n" } });
    await sup.git([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--name",
      "customname",
      "--",
      child.dir,
      "path/to/sub",
    ]);
    await sup.commit({ message: "add named submodule" });

    const gitDir = join(sup.dir, ".git");
    const byName = join(gitDir, "modules", "customname");
    const byPath = join(gitDir, "modules", "path/to/sub");
    expect(existsSync(byName)).toBe(true);
    expect(existsSync(byPath)).toBe(false);
    // The listing maps the worktree path to its distinct name.
    const before = await run(submoduleList(sup.dir));
    expect(before[0]?.path).toBe("path/to/sub");
    expect(before[0]?.name).toBe("customname");

    await run(submoduleRemove(sup.dir, gitDir, "path/to/sub"));

    expect(await run(submoduleList(sup.dir))).toEqual([]);
    expect(existsSync(byName)).toBe(false);
  });

  test("remove of an unknown path fails as gitFailed (no partial removal)", async () => {
    const { sup, gitDir } = await seedSuper("sm-remove-bad");
    const err = await run(
      Effect.flip(submoduleRemove(sup.dir, gitDir, "nope")),
    );
    expect(err.code).toBe("gitFailed");
    // the real submodule is untouched.
    expect(await run(submoduleList(sup.dir))).toHaveLength(1);
  });
});
