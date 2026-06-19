// @cbranch/web-server — Node host service + static bundle server.
//
// The single deployable host unit (NF-PKG-1) and the ONLY package permitted to open a
// listening socket (REQ-ARCH-005 / DECISIONS D10). It assembles the Effect platform
// HTTP/WebSocket layers into one multiplexed NDJSON socket (`/rpc`), serves the static
// SPA + the large-blob HTTP side-channel, enforces the `Origin`/`Host` allowlist, and
// binds loopback by default. The runnable entry point is `./main`; this module exports
// the composable building blocks (used by the integration tests and any embedder).

export { buildServerLive, RPC_PATH } from "./server";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  defaultClientDir,
  ensureClientDir,
  isLoopbackHost,
  type LogLevel,
  resolveServerConfig,
  type ServerConfig,
} from "./config";
export { isAllowedRequest, makeOriginGuard } from "./origin-guard";
export { handlersLayer } from "./rpc-handlers";
export { containBlobPath, guessContentType, safeRev, SIDE_CHANNEL_PATH, sideChannelRoute } from "./side-channel";
