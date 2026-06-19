// Server runtime configuration (docs/spec/12 NF-PKG-2/9, NF-CFG-7; DECISIONS D9).
//
// Resolves the bind address, port, static-bundle directory, and log level with the
// documented precedence **env > settings store > defaults** (NF-PKG-9). The default
// bind is loopback `127.0.0.1:7420`; a non-loopback bind is allowed only as an
// explicit opt-in and MUST trigger a prominent startup warning (NF-PKG-2) — this
// module computes the `isLoopback` flag the entry point uses to emit it.
//
// The `Origin`/`Host` allowlist (NF-SEC-3) is derived here so the perimeter check
// has a single source of truth: a request is accepted only if its `Host` (and, when
// present, its `Origin`) hostname is one of the bound host plus the loopback aliases.

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Config } from "@cbranch/core";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface ServerConfig {
  /** Bind address (NF-PKG-9). Loopback `127.0.0.1` by default. */
  readonly host: string;
  /** TCP port (NF-PKG-9). `7420` by default. */
  readonly port: number;
  /** Absolute path to the pre-built static SPA bundle served at `/` (NF-PKG-1). */
  readonly clientDir: string;
  /** Server log level (NF-LOG-2); carried for the logger configuration. */
  readonly logLevel: LogLevel;
  /** True when {@link host} is a loopback address (no NF-PKG-2 warning needed). */
  readonly isLoopback: boolean;
  /**
   * Lowercased hostnames accepted on the `Origin`/`Host` headers (NF-SEC-3). The
   * bound host plus the loopback aliases, so a same-origin browser passes while a
   * cross-site/DNS-rebinding `Origin` is rejected.
   */
  readonly allowedHostnames: ReadonlySet<string>;
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 7420;

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "::1", "localhost"] as const;

/** Strip the brackets a URL/`Host` uses around an IPv6 literal (e.g. `[::1]` → `::1`). */
export const stripIpv6Brackets = (host: string): string =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

/** Normalize a hostname for allowlist comparison: lowercased, IPv6 brackets removed. */
export const normalizeHostname = (host: string): string => stripIpv6Brackets(host.toLowerCase());

/** A host is loopback if it is one of the well-known loopback names/addresses. */
export const isLoopbackHost = (host: string): boolean =>
  (LOOPBACK_HOSTNAMES as ReadonlyArray<string>).includes(normalizeHostname(host));

/** The default static-bundle directory: `<server>/public`, resolved from this module. */
export const defaultClientDir = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");

/**
 * Ensure the static-bundle directory exists so `HttpStaticServer.layer` can build even
 * before the UI bundle is produced (it 404s missing files at request time). Never
 * overwrites an existing bundle.
 */
export const ensureClientDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
};

const parsePort = (value: string | undefined): number | undefined => {
  if (value === undefined || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
};

const asLogLevel = (value: string | undefined): LogLevel | undefined =>
  value === "error" || value === "warn" || value === "info" || value === "debug" ? value : undefined;

/**
 * Resolve the effective {@link ServerConfig}. `env` overrides the persisted `config`
 * (from the core settings store), which overrides the built-in defaults (NF-PKG-9).
 * Pure: no env mutation, no I/O — the entry point performs the store read + warning.
 */
export const resolveServerConfig = (opts?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly config?: Config;
  readonly clientDir?: string;
}): ServerConfig => {
  const env = opts?.env ?? process.env;
  const persisted = opts?.config;

  const host = env.CBRANCH_BIND_ADDRESS ?? persisted?.bind.address ?? DEFAULT_HOST;
  const port = parsePort(env.CBRANCH_PORT) ?? persisted?.bind.port ?? DEFAULT_PORT;
  const logLevel = asLogLevel(env.CBRANCH_LOG_LEVEL) ?? persisted?.logLevel ?? "info";
  const clientDir = opts?.clientDir ?? env.CBRANCH_CLIENT_DIR ?? defaultClientDir();

  const allowedHostnames = new Set<string>([normalizeHostname(host), ...LOOPBACK_HOSTNAMES]);

  return { host, port, clientDir, logLevel, isLoopback: isLoopbackHost(host), allowedHostnames };
};
