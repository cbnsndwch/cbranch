// @cbranch/web-server — Node host service + static bundle server.
//
// P0 scaffold only. This is the ONLY package permitted to open a listening socket
// (REQ-ARCH-005 / depcheck). In P1 it assembles the Effect platform HTTP/WebSocket
// layers (one multiplexed NDJSON socket), serves the Vite client bundle + the HTTP
// side-channel, enforces the Origin/Host allowlist on the WS upgrade, and binds
// loopback (127.0.0.1) by default.

import type { GitEnginePlaceholder } from "@cbranch/core";
import type { RpcContractPlaceholder } from "@cbranch/rpc-contract";

export const version = "0.0.0" as const;

/** Placeholder host entry; the Effect platform server lands in P1. */
export type WebServerPlaceholder = {
  readonly version: typeof version;
  readonly engine: GitEnginePlaceholder["version"];
  readonly contract: RpcContractPlaceholder["version"];
};
