import { describe, expect, test } from "vitest";

import * as WebServer from "./index";

describe("@cbranch/web-server public surface", () => {
  test("exposes the server builder, config resolver, and route building blocks", () => {
    expect(typeof WebServer.buildServerLive).toBe("function");
    expect(typeof WebServer.resolveServerConfig).toBe("function");
    expect(typeof WebServer.makeOriginGuard).toBe("function");
    expect(typeof WebServer.isAllowedRequest).toBe("function");
    expect(WebServer.SIDE_CHANNEL_PATH).toBe("/sidechannel/blob");
    expect(WebServer.RPC_PATH).toBe("/rpc");
    expect(WebServer.DEFAULT_PORT).toBe(7420);
  });
});
