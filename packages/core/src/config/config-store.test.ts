import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RecentRepo, RepoId } from "@cbranch/rpc-contract";
import { afterAll, describe, expect, test } from "vitest";

import { run } from "../testing/effect-run";
import {
  CONFIG_VERSION,
  defaultConfig,
  DEFAULT_BIND,
  DEFAULT_THRESHOLDS,
  makeConfigStore,
  resolveConfigPath,
} from "./config-store";

const tmp = mkdtempSync(join(tmpdir(), "cbranch-config-"));
let counter = 0;
const newPath = (): string => join(tmp, `config-${counter++}.json`);

afterAll(() => {
  // best-effort: leave temp dir to the OS; files are tiny.
});

describe("defaults (NF-CFG-5/7)", () => {
  test("a missing file loads documented defaults without crashing", async () => {
    const store = makeConfigStore({ configPath: newPath() });
    const config = await run(store.load());
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.recentRepos).toEqual([]);
    expect(config.theme).toBe("system");
    expect(config.bind).toEqual(DEFAULT_BIND);
    expect(config.thresholds.logPageSize).toBe(DEFAULT_THRESHOLDS.logPageSize);
  });

  test("garbage JSON falls back to defaults", async () => {
    const path = newPath();
    writeFileSync(path, "{ not valid json", "utf8");
    const config = await run(makeConfigStore({ configPath: path }).load());
    expect(config).toEqual(defaultConfig());
  });

  test("unknown fields are ignored; known fields are kept (migration-safe)", async () => {
    const path = newPath();
    writeFileSync(
      path,
      JSON.stringify({
        version: 999,
        theme: "dark",
        locale: "fr",
        somethingUnknown: { a: 1 },
        bind: { address: "0.0.0.0", port: 9999, extra: true },
        recentRepos: [
          { path: "/r", name: "r", repoId: "a".repeat(64), lastOpenedAt: 1 },
          { path: "/bad" }, // dropped: missing required fields
        ],
      }),
      "utf8",
    );
    const config = await run(makeConfigStore({ configPath: path }).load());
    expect(config.theme).toBe("dark");
    expect(config.locale).toBe("fr");
    expect(config.bind).toEqual({ address: "0.0.0.0", port: 9999 });
    expect(config.recentRepos).toHaveLength(1);
    expect("somethingUnknown" in config).toBe(false);
  });
});

const entry = (p: string) => ({
  path: p,
  name: p.split("/").pop() ?? p,
  repoId: createHash("sha256").update(p).digest("hex"),
  lastOpenedAt: Date.now(),
});

describe("recent list CRUD (P1-RECENT-1/3/5)", () => {
  test("upsert moves to top + de-duplicates by path; list returns RecentRepo instances", async () => {
    const store = makeConfigStore({ configPath: newPath() });
    await run(store.upsertRecent(entry("/a")));
    await run(store.upsertRecent(entry("/b")));
    await run(store.upsertRecent(entry("/a"))); // re-open A → back to top, no dup
    const recents = await run(store.listRecent());
    expect(recents.map((r) => r.path)).toEqual(["/a", "/b"]);
    expect(recents[0]).toBeInstanceOf(RecentRepo);
  });

  test("remove + rename persist", async () => {
    const store = makeConfigStore({ configPath: newPath() });
    const a = entry("/a");
    const b = entry("/b");
    await run(store.upsertRecent(a));
    await run(store.upsertRecent(b));
    await run(store.removeRecent(RepoId.make(b.repoId)));
    await run(store.renameRecent(RepoId.make(a.repoId), "Custom Name"));
    const recents = await run(store.listRecent());
    expect(recents).toHaveLength(1);
    expect(recents[0]?.name).toBe("Custom Name");
  });

  test("save normalizes the version field on disk", async () => {
    const path = newPath();
    const store = makeConfigStore({ configPath: path });
    await run(store.upsertRecent(entry("/a")));
    const written = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    expect(written.version).toBe(CONFIG_VERSION);
  });
});

describe("resolveConfigPath (NF-CFG-7 / NF-PKG-9 precedence)", () => {
  test("CBRANCH_CONFIG wins", () => {
    expect(resolveConfigPath({ CBRANCH_CONFIG: "/custom/c.json" } as NodeJS.ProcessEnv)).toBe("/custom/c.json");
  });

  test("falls back to a cbranch/config.json under a config home", () => {
    const resolved = resolveConfigPath({ XDG_CONFIG_HOME: "/xdg", APPDATA: "/appdata" } as NodeJS.ProcessEnv);
    expect(resolved.replace(/\\/g, "/")).toContain("cbranch/config.json");
  });
});
