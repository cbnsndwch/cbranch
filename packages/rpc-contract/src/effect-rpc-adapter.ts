// Effect unstable-API quarantine (REQ-STACK-023 / DECISIONS D3, D10).
//
// MANDATORY: this is the ONLY module in the entire monorepo permitted to import
// from `effect/unstable/*`. Every consumer (the RpcGroup catalog here, the server
// transport in apps/web-server, the client transport in packages/ui) imports these
// symbols from this adapter instead of reaching into `effect/unstable/*` directly,
// so a rename on an Effect beta bump touches exactly one file.
//
// `effect/Schema` is on Effect's STABLE track and is therefore NOT quarantined:
// Schemas are imported directly via `import { Schema } from "effect"` elsewhere.
//
// P0 status: these re-exports are VERIFIED to resolve against effect@4.0.0-beta.84.
// The ⚠ member symbols the spec flags were checked present at this pin:
//   RpcServer.layerProtocolWebsocket, RpcClient.layerProtocolSocket,
//   RpcSerialization.layerNdjson, Socket.layerWebSocket,
//   Socket.layerWebSocketConstructorGlobal, Rpc.make, RpcGroup.make.
// (Schema.TaggedErrorClass exists; Schema.TaggedError does NOT — confirming the
// spec's "v4 name" note.) P0.5 fills the adapter with the typed transport bindings;
// re-verify every symbol above on any deliberate effect bump.

// --- RPC: catalog + server/client protocol + serialization ---
export { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";

// --- Socket: WebSocket transport for the multiplexed NDJSON channel ---
export { Socket, SocketServer } from "effect/unstable/socket";

// --- HTTP: platform server/router/static + side-channel (apps/web-server, P1) ---
export * as Http from "effect/unstable/http";
