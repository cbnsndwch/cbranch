// Process entry point (docs/spec/12 NF-PKG-1/2/5/9; DECISIONS D9/D11).
//
// One command starts the host service and serves the SPA (NF-PKG-1). Resolves the
// effective bind/port/log config from env + the settings store (NF-PKG-9), emits the
// non-loopback trust warning when applicable (NF-PKG-2), then launches the assembled
// server layer at the process root via `NodeRuntime.runMain` (signal handling +
// graceful teardown). The host-git version gate (NF-PKG-5) runs inside the engine
// layer build, so an absent/too-old git fails startup with a typed `GitError`.

import { gitEngineLayer, makeConfigStore } from "@cbranch/core";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";

import { ensureClientDir, resolveServerConfig } from "./config";
import { buildServerLive } from "./server";

const program = Effect.gen(function* () {
  const persisted = yield* makeConfigStore({ env: process.env }).load();
  const config = resolveServerConfig({ env: process.env, config: persisted });
  ensureClientDir(config.clientDir);

  yield* Effect.logInfo(
    `cbranch web-server starting on http://${config.host}:${config.port} (static bundle: ${config.clientDir})`,
  );
  if (!config.isLoopback) {
    yield* Effect.logWarning(
      `Binding to non-loopback address ${config.host}: cbranch ships with NO application-level authentication. ` +
        "Expose it only behind a trusted perimeter (LAN / VPN / SSH tunnel) — never on the public internet.",
    );
  }

  yield* Layer.launch(
    buildServerLive(config, gitEngineLayer({ env: process.env })),
  );
});

NodeRuntime.runMain(program);
