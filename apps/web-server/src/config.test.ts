import { defaultConfig } from "@cbranch/core";
import { describe, expect, test } from "vitest";

import { DEFAULT_HOST, DEFAULT_PORT, isLoopbackHost, resolveServerConfig } from "./config";

describe("resolveServerConfig (NF-PKG-9 precedence)", () => {
  test("defaults to loopback 127.0.0.1:7420 with no env/config", () => {
    const c = resolveServerConfig({ env: {}, clientDir: "/x" });
    expect(c.host).toBe(DEFAULT_HOST);
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.logLevel).toBe("info");
    expect(c.isLoopback).toBe(true);
    expect(c.allowedHostnames.has("127.0.0.1")).toBe(true);
    expect(c.allowedHostnames.has("localhost")).toBe(true);
  });

  test("settings store overrides the built-in defaults", () => {
    const config = { ...defaultConfig(), bind: { address: "0.0.0.0", port: 9000 }, logLevel: "debug" as const };
    const c = resolveServerConfig({ env: {}, config, clientDir: "/x" });
    expect(c.host).toBe("0.0.0.0");
    expect(c.port).toBe(9000);
    expect(c.logLevel).toBe("debug");
    expect(c.isLoopback).toBe(false);
  });

  test("env overrides the settings store", () => {
    const config = { ...defaultConfig(), bind: { address: "0.0.0.0", port: 9000 } };
    const c = resolveServerConfig({
      env: { CBRANCH_BIND_ADDRESS: "127.0.0.1", CBRANCH_PORT: "5555", CBRANCH_LOG_LEVEL: "warn" },
      config,
      clientDir: "/x",
    });
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(5555);
    expect(c.logLevel).toBe("warn");
  });

  test("an invalid env port falls back to the default", () => {
    const c = resolveServerConfig({ env: { CBRANCH_PORT: "not-a-port" }, clientDir: "/x" });
    expect(c.port).toBe(DEFAULT_PORT);
  });

  test("CBRANCH_CLIENT_DIR overrides the default static dir", () => {
    const c = resolveServerConfig({ env: { CBRANCH_CLIENT_DIR: "/custom/dir" } });
    expect(c.clientDir).toBe("/custom/dir");
  });
});

describe("isLoopbackHost", () => {
  test.each(["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"])("%s is loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  test.each(["0.0.0.0", "192.168.1.5", "example.com"])("%s is not loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});
