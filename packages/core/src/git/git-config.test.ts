import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  createFixtureWorkspace,
  type FixtureRepo,
  type FixtureWorkspace,
} from "../testing/fixtures";
import {
  configGet,
  configGetArgs,
  configList,
  configListArgs,
  configSet,
  configSetArgs,
  configUnset,
  configUnsetArgs,
  parseConfigList,
} from "./git-config";

// NUL-framed record helper: `scope\0origin\0key\nvalue\0` per entry.
const rec = (scope: string, origin: string, keyValue: string): string =>
  `${scope}\0${origin}\0${keyValue}\0`;

describe("parseConfigList", () => {
  test("groups by 3, splits key/value on the first newline", () => {
    const stdout =
      rec("global", "file:/home/a/.gitconfig", "user.name\nAda Lovelace") +
      rec("local", "file:.git/config", "core.editor\nvim");
    const rows = parseConfigList(stdout);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: "user.name",
      value: "Ada Lovelace",
      scope: "global",
      origin: "file:/home/a/.gitconfig",
    });
    expect(rows[1]).toMatchObject({
      key: "core.editor",
      value: "vim",
      scope: "local",
    });
  });

  test("a valueless boolean yields an empty value", () => {
    const rows = parseConfigList(
      rec("local", "file:.git/config", "core.bare\n"),
    );
    expect(rows[0]?.key).toBe("core.bare");
    expect(rows[0]?.value).toBe("");
  });

  test("a value containing newlines round-trips (NUL framing, split on FIRST \\n)", () => {
    const rows = parseConfigList(
      rec("global", "file:x", "alias.lol\nlog --oneline\nmore"),
    );
    expect(rows[0]?.key).toBe("alias.lol");
    expect(rows[0]?.value).toBe("log --oneline\nmore");
  });

  test("a multi-valued key yields multiple rows", () => {
    const rows = parseConfigList(
      rec("global", "file:x", "credential.helper\ncache") +
        rec("global", "file:x", "credential.helper\nstore"),
    );
    expect(rows.map((r) => r.value)).toEqual(["cache", "store"]);
  });

  test("tolerates all five scopes including command", () => {
    const stdout =
      rec("system", "file:/etc/gitconfig", "a.b\n1") +
      rec("global", "file:~/.gitconfig", "c.d\n2") +
      rec("local", "file:.git/config", "e.f\n3") +
      rec("worktree", "file:.git/config.worktree", "g.h\n4") +
      rec("command", "command line:", "i.j\n5");
    expect(parseConfigList(stdout).map((r) => r.scope)).toEqual([
      "system",
      "global",
      "local",
      "worktree",
      "command",
    ]);
  });

  test("skips unknown scopes and tolerates a short final group", () => {
    const stdout =
      rec("global", "file:x", "ok.key\nv") +
      "weirdscope\0file:y\0bad.key\nv2\0extra";
    const rows = parseConfigList(stdout);
    // The "weirdscope" entry is skipped; the trailing short group is ignored.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("ok.key");
  });
});

describe("git-config argv builders", () => {
  test("configListArgs requests scope + origin, NUL-framed", () => {
    expect(configListArgs()).toEqual([
      "config",
      "--list",
      "--show-origin",
      "--show-scope",
      "-z",
    ]);
  });

  test("configGetArgs is effective without a scope, scoped with one", () => {
    expect(configGetArgs("user.name")).toEqual([
      "config",
      "--get",
      "user.name",
    ]);
    expect(configGetArgs("user.name", "global")).toEqual([
      "config",
      "--global",
      "--get",
      "user.name",
    ]);
    expect(configGetArgs("user.name", "system")).toEqual([
      "config",
      "--system",
      "--get",
      "user.name",
    ]);
    expect(configGetArgs("user.name", "worktree")).toEqual([
      "config",
      "--worktree",
      "--get",
      "user.name",
    ]);
    // `command` has no `--command` flag → falls back to an effective read.
    expect(configGetArgs("user.name", "command")).toEqual([
      "config",
      "--get",
      "user.name",
    ]);
  });

  test("configSetArgs/configUnsetArgs carry the scope flag", () => {
    expect(configSetArgs("user.name", "Ada", "global")).toEqual([
      "config",
      "--global",
      "user.name",
      "Ada",
    ]);
    expect(configUnsetArgs("user.name", "local")).toEqual([
      "config",
      "--local",
      "--unset-all",
      "user.name",
    ]);
  });
});

describe("git-config integration (real fixture repo)", () => {
  let ws: FixtureWorkspace;
  beforeAll(async () => {
    ws = await createFixtureWorkspace();
  });
  afterAll(async () => {
    await ws.cleanup();
  });

  // Isolate global/system config so `--global` writes never touch the real ~/.gitconfig.
  const isolated = (repo: FixtureRepo): NodeJS.ProcessEnv => ({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(repo.dir, ".gitconfig-global"),
    GIT_CONFIG_SYSTEM: join(repo.dir, ".gitconfig-system"),
  });

  test("configList returns local entries and NO injected command-scope rows", async () => {
    const repo = await ws.createRepo("cfg-list");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const rows = await run(configList(repo.dir, isolated(repo)));
    // The fixture's init set user.name/user.email at local scope.
    expect(rows.some((r) => r.key === "user.name" && r.scope === "local")).toBe(
      true,
    );
    // read:false means no `-c color.ui`/`-c core.quotePath` phantom command rows.
    expect(rows.some((r) => r.scope === "command")).toBe(false);
    expect(rows.some((r) => r.key === "color.ui")).toBe(false);
    expect(rows.some((r) => r.key === "core.quotepath")).toBe(false);
  });

  test("configGet returns present value (exit 0) and absent present:false (exit 1)", async () => {
    const repo = await ws.createRepo("cfg-get");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const present = await run(
      configGet(repo.dir, "user.name", "local", isolated(repo)),
    );
    expect(present.present).toBe(true);
    expect(present.value).toBe("Cb Tester");
    expect(present.scope).toBe("local");
    const absent = await run(
      configGet(repo.dir, "user.signingkey", "local", isolated(repo)),
    );
    expect(absent.present).toBe(false);
    expect(absent.value).toBeUndefined();
  });

  test("configGet without a scope omits scope and reads the effective value", async () => {
    const repo = await ws.createRepo("cfg-get-eff");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const v = await run(
      configGet(repo.dir, "user.email", undefined, isolated(repo)),
    );
    expect(v.present).toBe(true);
    expect(v.value).toBe("tester@cbranch.test");
    expect(v.scope).toBeUndefined();
  });

  test("configSet writes local and global, integration set→get→unset", async () => {
    const repo = await ws.createRepo("cfg-write");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await run(
      configSet(repo.dir, "cbranch.flag", "on", "local", isolated(repo)),
    );
    const local = await run(
      configGet(repo.dir, "cbranch.flag", "local", isolated(repo)),
    );
    expect(local.value).toBe("on");
    await run(
      configSet(repo.dir, "user.name", "Global Ada", "global", isolated(repo)),
    );
    const global = await run(
      configGet(repo.dir, "user.name", "global", isolated(repo)),
    );
    expect(global.value).toBe("Global Ada");
    // Unset, then it reads absent.
    await run(configUnset(repo.dir, "cbranch.flag", "local", isolated(repo)));
    const gone = await run(
      configGet(repo.dir, "cbranch.flag", "local", isolated(repo)),
    );
    expect(gone.present).toBe(false);
  });

  test("configUnset of an absent key is idempotent success (exit 5)", async () => {
    const repo = await ws.createRepo("cfg-unset-absent");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    await run(configUnset(repo.dir, "does.not.exist", "local", isolated(repo)));
    // No throw == success.
    expect(true).toBe(true);
  });

  test("configUnset removes ALL values of a multi-valued key (--unset-all)", async () => {
    const repo = await ws.createRepo("cfg-unset-multivar");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    // Two values for one key — plain `--unset` would exit 5 and remove nothing.
    await repo.git([
      "config",
      "--local",
      "--add",
      "credential.helper",
      "cache",
    ]);
    await repo.git([
      "config",
      "--local",
      "--add",
      "credential.helper",
      "store",
    ]);
    await run(
      configUnset(repo.dir, "credential.helper", "local", isolated(repo)),
    );
    const rows = await run(configList(repo.dir, isolated(repo)));
    expect(rows.some((r) => r.key === "credential.helper")).toBe(false);
  });

  test("configGet with a non-readable scope (command) does an effective read, scope omitted", async () => {
    const repo = await ws.createRepo("cfg-get-command");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const v = await run(
      configGet(repo.dir, "user.name", "command", isolated(repo)),
    );
    expect(v.present).toBe(true);
    expect(v.value).toBe("Cb Tester");
    expect(v.scope).toBeUndefined();
  });

  test("configSet refuses the system scope with permissionDenied", async () => {
    const repo = await ws.createRepo("cfg-system");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const err = await run(
      Effect.flip(
        configSet(repo.dir, "user.name", "x", "system", isolated(repo)),
      ),
    );
    expect(err.code).toBe("permissionDenied");
  });

  test("configSet refuses a leading-dash key but ACCEPTS a leading-dash value", async () => {
    const repo = await ws.createRepo("cfg-dash");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const keyErr = await run(
      Effect.flip(configSet(repo.dir, "-evil", "x", "local", isolated(repo))),
    );
    expect(keyErr.code).toBe("invalidRefName");
    // Value is positional, so a leading-dash value is a legitimate value.
    await run(
      configSet(repo.dir, "cbranch.dash", "-x", "local", isolated(repo)),
    );
    const v = await run(
      configGet(repo.dir, "cbranch.dash", "local", isolated(repo)),
    );
    expect(v.value).toBe("-x");
  });

  test("an invalid key (no section) surfaces gitFailed", async () => {
    const repo = await ws.createRepo("cfg-bad");
    await repo.commit({ message: "init", files: { "a.txt": "a\n" } });
    const err = await run(
      Effect.flip(
        configSet(repo.dir, "nodotsection", "x", "local", isolated(repo)),
      ),
    );
    expect(err.code).toBe("gitFailed");
  });
});
