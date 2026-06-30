// Guards the `effect/unstable/*` quarantine adapter (DECISIONS D3/D10).
//
// The adapter is the ONLY module allowed to import `effect/unstable/*`; this test
// pins the exact ⚠-flagged symbol names the spec depends on (14 §1/§2), so an Effect
// beta bump that renames or drops one fails HERE rather than deep in a transport
// layer. Constructing a Layer is pure (the connect Effect is lazy), so the WebSocket
// layers are verified shape-only — no socket is opened (transport itself lives in the
// apps, not this package).

import { describe, expect, test } from "vitest";

import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcSerialization,
  RpcServer,
  RpcTest,
  Socket,
} from "./effect-rpc-adapter";

describe("effect-rpc-adapter quarantine surface @ effect@4.0.0-beta.92", () => {
  test("RPC catalog + test-transport symbols are present", () => {
    expect(typeof Rpc.make).toBe("function");
    expect(typeof RpcGroup.make).toBe("function");
    expect(typeof RpcTest.makeClient).toBe("function");
  });

  test("server + client WebSocket transport layers construct (shape-only)", () => {
    // Server: layerProtocolWebsocket + layerNdjson.
    expect(RpcServer.layerProtocolWebsocket({ path: "/rpc" })).toBeDefined();
    expect(RpcSerialization.layerNdjson).toBeDefined();

    // Client: layerProtocolSocket (there is NO client layerProtocolWebsocket) +
    // layerWebSocket + layerWebSocketConstructorGlobal.
    expect(RpcClient.layerProtocolSocket()).toBeDefined();
    expect(Socket.layerWebSocket("ws://127.0.0.1:7420/rpc")).toBeDefined();
    expect(Socket.layerWebSocketConstructorGlobal).toBeDefined();
  });
});
