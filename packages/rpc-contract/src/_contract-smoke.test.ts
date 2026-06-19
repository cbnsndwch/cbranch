// P0.5 API-shape smoke test for @effect/rpc + Effect Schema at effect@4.0.0-beta.84.
//
// This is NOT the P1 method catalog. It is a minimal, permanent contract smoke
// test that (a) pins the exact verified API shapes the spec flags with ⚠ and
// (b) seeds the in-memory contract-test transport (NF-TEST-6) so the real P1
// methods can be exercised client<->server without opening a socket.
//
// Every effect/unstable/* symbol is imported via the quarantine adapter, never
// directly (REQ-STACK-023 / DECISIONS D3, D10).

import { Effect, Schema, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer, RpcTest, Socket } from "./effect-rpc-adapter";

// --- 1. GitError via Schema.TaggedErrorClass (NOT Schema.TaggedError; that name
//        does not exist at this pin). One tagged class whose `code` is a closed
//        Schema.Literals union; mirrors docs/spec/14-rpc-contract.md §4. ---
class GitError extends Schema.TaggedErrorClass<GitError>()("GitError", {
  code: Schema.Literals(["gitFailed", "cancelled"]),
  message: Schema.String,
  detail: Schema.optional(Schema.Unknown),
}) {}

// --- 2 & 3. Rpc.make + RpcGroup.make. `payload` accepts bare struct fields;
//            `success`/`error` must be Schemas. `stream: true` makes the success
//            a stream schema and forces the top-level error to Never (§4/§7). ---
const SmokeRpcs = RpcGroup.make(
  Rpc.make("Echo", {
    payload: { msg: Schema.String },
    success: Schema.Struct({ echo: Schema.String }),
  }),
  Rpc.make("Boom", {
    payload: { reason: Schema.String },
    error: GitError,
  }),
  Rpc.make("Count", {
    payload: { n: Schema.Number },
    success: Schema.Struct({ i: Schema.Number }),
    error: GitError,
    stream: true,
  }),
);

// --- 3. Server side: RpcGroup#toLayer maps each tag to a handler. Unary handlers
//        return an Effect<Success, Error>; streaming handlers return a
//        Stream<Item, GitError>. ---
const HandlersLayer = SmokeRpcs.toLayer({
  Echo: ({ msg }) => Effect.succeed({ echo: msg }),
  Boom: ({ reason }) => Effect.fail(new GitError({ code: "cancelled", message: reason })),
  Count: ({ n }) => {
    if (n < 0) {
      return Stream.fail(new GitError({ code: "gitFailed", message: "n must be >= 0" }));
    }
    return Stream.fromIterable(Array.from({ length: n }, (_unused, i) => ({ i })));
  },
});

describe("rpc-contract API shapes @ effect@4.0.0-beta.84", () => {
  test("in-memory RpcTest round-trip: unary, stream, typed unary + stream errors", async () => {
    // --- 6. RpcTest.makeClient(group) is the in-memory/test transport (NF-TEST-6).
    //        It needs the handlers in context (provide the toLayer output) and a
    //        Scope; no socket, no serializer. ---
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(SmokeRpcs);

      // --- unary call returns the success value ---
      const echo = yield* client.Echo({ msg: "hello" });

      // --- 7. streaming call yields a Stream on the client ---
      const items = yield* Stream.runCollect(client.Count({ n: 3 }));

      // --- handler-thrown GitError surfaces as a typed error (unary channel) ---
      const unaryErr = yield* Effect.flip(client.Boom({ reason: "nope" }));

      // --- 7. GitError on a stream's per-item error channel ---
      const streamErr = yield* Effect.flip(Stream.runCollect(client.Count({ n: -1 })));

      return { echo, items, unaryErr, streamErr };
    }).pipe(Effect.provide(HandlersLayer), Effect.scoped);

    const { echo, items, streamErr, unaryErr } = await Effect.runPromise(program);

    expect(echo).toEqual({ echo: "hello" });
    expect(items).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);

    expect(unaryErr._tag).toBe("GitError");
    expect(unaryErr.code).toBe("cancelled");
    expect(unaryErr.message).toBe("nope");

    expect(streamErr._tag).toBe("GitError");
    expect(streamErr.code).toBe("gitFailed");
  });

  test("websocket transport layers construct (shape-only; no socket opened)", () => {
    // --- 4. Server transport: layerProtocolWebsocket + layerNdjson. ---
    const serverProtocol = RpcServer.layerProtocolWebsocket({ path: "/rpc" });
    const serverSerialization = RpcSerialization.layerNdjson;

    // --- 5. Client transport: layerProtocolSocket + layerWebSocket +
    //        layerWebSocketConstructorGlobal + layerNdjson. There is NO client
    //        layerProtocolWebsocket; layerProtocolSocket is the correct symbol. ---
    const clientProtocol = RpcClient.layerProtocolSocket();
    const clientSocket = Socket.layerWebSocket("ws://127.0.0.1:7420/rpc");
    const clientWsConstructor = Socket.layerWebSocketConstructorGlobal;

    // Constructing a Layer is pure (the connect Effect is lazy), so this verifies
    // the symbol names + argument shapes without standing up a real server.
    expect(serverProtocol).toBeDefined();
    expect(serverSerialization).toBeDefined();
    expect(clientProtocol).toBeDefined();
    expect(clientSocket).toBeDefined();
    expect(clientWsConstructor).toBeDefined();
  });
});
