// Host-side settings store (docs/spec/12 NF-CFG-2/4/5/6/7; DECISIONS D9).
//
// Human-readable JSON at `$XDG_CONFIG_HOME/cbranch/config.json` (default
// `~/.config/cbranch/config.json`; Windows `%APPDATA%\cbranch\config.json`),
// overridable via `CBRANCH_CONFIG`. This is the SINGLE source for the repo
// switcher's recent list (P1-RECENT-6, server-side). Reads are infallible: a
// missing/unreadable/garbage file falls back to documented defaults rather than
// crashing (NF-CFG-5), and unknown fields are ignored (forward/backward compatible).
// cbranch NEVER writes repository git config (NF-CFG-4) or secrets (NF-CFG-6).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type GitError, type RepoId } from "@cbranch/rpc-contract";
import { RecentRepo, RepoId as RepoIdBrand } from "@cbranch/rpc-contract";
import { Effect } from "effect";

import { classifyNodeError } from "../git/errors";

/** Current settings schema version (top-level integer for migration — NF-CFG-7). */
export const CONFIG_VERSION = 1;

export const DEFAULT_BIND = { address: "127.0.0.1", port: 7420 } as const;

/** Configurable limits (NF-LIMIT-1..6) — values are the documented defaults. */
export const DEFAULT_THRESHOLDS = {
  largeDiffLines: 2000,
  largeDiffBytes: 512 * 1024,
  binaryPreviewBytes: 5 * 1024 * 1024,
  inlineContentBytes: 10 * 1024 * 1024,
  mergeEditorBytes: 2 * 1024 * 1024,
  logPageSize: 500,
  rpcPayloadBytes: 1024 * 1024,
} as const;

export interface RecentRepoEntry {
  readonly path: string;
  readonly name: string;
  readonly repoId: string;
  readonly lastOpenedAt: number;
}

export interface Config {
  readonly version: number;
  readonly recentRepos: ReadonlyArray<RecentRepoEntry>;
  readonly theme: "light" | "dark" | "system";
  readonly locale: string;
  readonly logLevel: "error" | "warn" | "info" | "debug";
  readonly bind: { readonly address: string; readonly port: number };
  readonly thresholds: Record<string, number>;
  readonly keybindings: Record<string, string>;
}

export const defaultConfig = (): Config => ({
  version: CONFIG_VERSION,
  recentRepos: [],
  theme: "system",
  locale: "en",
  logLevel: "info",
  bind: { ...DEFAULT_BIND },
  thresholds: { ...DEFAULT_THRESHOLDS },
  keybindings: {},
});

/** Resolve the config file path with the documented precedence (NF-CFG-7 / NF-PKG-9). */
export const resolveConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
): string => {
  if (typeof env.CBRANCH_CONFIG === "string" && env.CBRANCH_CONFIG !== "")
    return env.CBRANCH_CONFIG;
  if (
    process.platform === "win32" &&
    typeof env.APPDATA === "string" &&
    env.APPDATA !== ""
  ) {
    return join(env.APPDATA, "cbranch", "config.json");
  }
  const xdg =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME !== ""
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(xdg, "cbranch", "config.json");
};

/**
 * cbranch's own app settings (REQ-P5-CFG-006) — theme/locale/keybindings, persisted in
 * THIS host `config.json`, NEVER in git config (REQ-P5-CFG-005). `keybindings` is the
 * native `Record<commandId, chord>` of user overrides; the engine converts it to/from
 * the wire `KeyBinding[]` at the boundary.
 */
export interface AppSettingsData {
  readonly theme: Config["theme"];
  readonly locale: string;
  readonly keybindings: Record<string, string>;
}

export interface ConfigStore {
  readonly path: string;
  /** Load the config; ALWAYS succeeds with documented defaults on any problem. */
  readonly load: () => Effect.Effect<Config>;
  readonly listRecent: () => Effect.Effect<ReadonlyArray<RecentRepo>>;
  readonly upsertRecent: (
    entry: RecentRepoEntry,
  ) => Effect.Effect<void, GitError>;
  readonly removeRecent: (repoId: RepoId) => Effect.Effect<void, GitError>;
  readonly renameRecent: (
    repoId: RepoId,
    name: string,
  ) => Effect.Effect<void, GitError>;
  /** Read app settings (theme/locale/keybindings); infallible (defaults on any problem). */
  readonly getAppSettings: () => Effect.Effect<AppSettingsData>;
  /** Merge a partial patch into app settings and persist (REQ-P5-CFG-006). */
  readonly setAppSettings: (
    patch: Partial<AppSettingsData>,
  ) => Effect.Effect<AppSettingsData, GitError>;
}

export const makeConfigStore = (opts?: {
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}): ConfigStore => {
  const path = opts?.configPath ?? resolveConfigPath(opts?.env);

  const load = (): Effect.Effect<Config> =>
    Effect.map(
      Effect.tryPromise({
        try: () => readFile(path, "utf8"),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null)),
      (raw) => (raw === null ? defaultConfig() : normalizeConfig(raw)),
    );

  const save = (config: Config): Effect.Effect<void, GitError> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(
          path,
          `${JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2)}\n`,
          "utf8",
        );
      },
      catch: classifyNodeError,
    });

  const mutate = (
    f: (recents: RecentRepoEntry[]) => RecentRepoEntry[],
  ): Effect.Effect<void, GitError> =>
    Effect.flatMap(load(), (config) =>
      save({ ...config, recentRepos: f([...config.recentRepos]) }),
    );

  return {
    path,
    load,
    listRecent: () =>
      Effect.map(load(), (config) =>
        config.recentRepos.map(
          (e) =>
            new RecentRepo({
              path: e.path,
              name: e.name,
              repoId: RepoIdBrand.make(e.repoId),
              lastOpenedAt: e.lastOpenedAt,
            }),
        ),
      ),
    // Move/insert at the top, de-duplicated by resolved path (P1-RECENT-1/3).
    upsertRecent: (entry) =>
      mutate((recents) => [
        entry,
        ...recents.filter((r) => r.path !== entry.path),
      ]),
    removeRecent: (repoId) =>
      mutate((recents) => recents.filter((r) => r.repoId !== repoId)),
    renameRecent: (repoId, name) =>
      mutate((recents) =>
        recents.map((r) => (r.repoId === repoId ? { ...r, name } : r)),
      ),
    getAppSettings: () =>
      Effect.map(load(), (config) => ({
        theme: config.theme,
        locale: config.locale,
        keybindings: config.keybindings,
      })),
    setAppSettings: (patch) =>
      Effect.flatMap(load(), (config) => {
        const next: AppSettingsData = {
          theme: patch.theme ?? config.theme,
          locale: patch.locale ?? config.locale,
          keybindings: patch.keybindings ?? config.keybindings,
        };
        return Effect.as(save({ ...config, ...next }), next);
      }),
  };
};

/** Defensive parse: pick known, well-typed fields; ignore everything else (NF-CFG-5). */
const normalizeConfig = (raw: string): Config => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConfig();
  }
  if (typeof parsed !== "object" || parsed === null) return defaultConfig();
  const obj = parsed as Record<string, unknown>;
  const base = defaultConfig();
  return {
    version: typeof obj.version === "number" ? obj.version : base.version,
    recentRepos: normalizeRecents(obj.recentRepos),
    theme:
      obj.theme === "light" || obj.theme === "dark" || obj.theme === "system"
        ? obj.theme
        : base.theme,
    locale: typeof obj.locale === "string" ? obj.locale : base.locale,
    logLevel: isLogLevel(obj.logLevel) ? obj.logLevel : base.logLevel,
    bind: normalizeBind(obj.bind, base.bind),
    thresholds: { ...base.thresholds, ...pickNumbers(obj.thresholds) },
    keybindings: pickStrings(obj.keybindings),
  };
};

const normalizeRecents = (value: unknown): RecentRepoEntry[] => {
  if (!Array.isArray(value)) return [];
  const out: RecentRepoEntry[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (
      typeof e.path === "string" &&
      typeof e.name === "string" &&
      typeof e.repoId === "string" &&
      typeof e.lastOpenedAt === "number"
    ) {
      out.push({
        path: e.path,
        name: e.name,
        repoId: e.repoId,
        lastOpenedAt: e.lastOpenedAt,
      });
    }
  }
  return out;
};

const normalizeBind = (
  value: unknown,
  fallback: Config["bind"],
): Config["bind"] => {
  if (typeof value !== "object" || value === null) return fallback;
  const b = value as Record<string, unknown>;
  return {
    address: typeof b.address === "string" ? b.address : fallback.address,
    port: typeof b.port === "number" ? b.port : fallback.port,
  };
};

const isLogLevel = (v: unknown): v is Config["logLevel"] =>
  v === "error" || v === "warn" || v === "info" || v === "debug";

const pickNumbers = (value: unknown): Record<string, number> => {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value))
    if (typeof v === "number") out[k] = v;
  return out;
};

const pickStrings = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value))
    if (typeof v === "string") out[k] = v;
  return out;
};
