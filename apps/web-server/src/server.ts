// Server assembly (docs/spec/02 REQ-ARCH-005/020; docs/spec/14 §2/§3; DECISIONS
// D3/D4/D10/D11).
//
// Composes the single multiplexed transport the spec mandates: one NDJSON WebSocket
// RPC bus at `/rpc` (REQ-STACK-024), the static SPA bundle, and the large-blob HTTP
// side-channel — all served by ONE Node HTTP server bound to loopback by default, with
// the `Origin`/`Host` perimeter guard applied globally (NF-SEC-3). The concrete Node
// binding is provided by `@effect/platform-node`'s `NodeHttpServer.layer` (DECISIONS
// D11): `effect` core ships only the transport-agnostic `effect/unstable/http`
// abstractions with no Node listener. This is the ONLY package permitted to open a
// listening socket (REQ-ARCH-005 / D10).

import * as http from 'node:http';

import { type ConfigStore, type GitEngine } from '@cbranch/core';
import { CbranchRpcs, type GitError } from '@cbranch/rpc-contract';
import {
    Http,
    RpcServer,
    RpcSerialization,
} from '@cbranch/rpc-contract/effect-rpc-adapter';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { Layer } from 'effect';

import { archiveChannelRoute } from './archive-channel';
import { type ServerConfig } from './config';
import { healthRoute } from './health-route';
import { makeOriginGuard } from './origin-guard';
import { patchChannelRoute, patchUploadRoute } from './patch-channel';
import { pluginManagerUnavailableLayer } from './plugin-manager';
import { handlersLayer } from './rpc-handlers';
import { sideChannelRoute } from './side-channel';
import {
    workspaceAvatarDeleteRoute,
    workspaceAvatarRoute,
    workspaceAvatarUploadRoute,
} from './workspace-avatar-channel';

/** Path of the multiplexed NDJSON WebSocket RPC bus (DECISIONS D3). */
export const RPC_PATH = '/rpc';

/**
 * Build the launchable server `Layer` for the resolved {@link ServerConfig}, backed by
 * the supplied live `GitEngine` layer (so tests can inject a fixture-scoped engine).
 *
 * The application layers — the WS RPC server, the static SPA server, and the
 * side-channel route — are provided with the RPC handlers, NDJSON serialization, and
 * the engine; the whole chain is then served by `NodeHttpServer.layer` with the global
 * `Origin`/`Host` guard. `provideMerge` keeps `HttpServer` (and the Node platform
 * services) in the output so a caller/test can read the bound address.
 */
export const buildServerLive = (
    config: ServerConfig,
    engineLive: Layer.Layer<GitEngine, GitError>,
    configStore: ConfigStore,
) => {
    // `handlersLayer` requires `GitEngine` directly; `sideChannelRoute` requires it as a
    // route-scoped requirement that only surfaces (unwrapped) after `HttpRouter.serve`.
    // So `engineLive` is provided once at the end — after `serve` — to satisfy both.
    const appLive = Layer.mergeAll(
        RpcServer.layerHttp({
            group: CbranchRpcs,
            path: RPC_PATH,
            protocol: 'websocket',
        }),
        Http.HttpStaticServer.layer({
            root: config.clientDir,
            index: 'index.html',
            spa: true,
        }),
        healthRoute,
        sideChannelRoute,
        archiveChannelRoute,
        patchChannelRoute,
        patchUploadRoute,
        workspaceAvatarUploadRoute(configStore),
        workspaceAvatarRoute(configStore),
        workspaceAvatarDeleteRoute(configStore),
    ).pipe(
        Layer.provide(handlersLayer),
        Layer.provide(pluginManagerUnavailableLayer),
        Layer.provide(RpcSerialization.layerNdjson),
    );

    return Http.HttpRouter.serve(appLive, {
        // CORS is needed only because the Windows WebView's asset origin differs
        // from the loopback endpoint. The outer guard still rejects every foreign
        // Origin/Host before a route or preflight handler can run.
        middleware: effect =>
            makeOriginGuard(
                config.allowedHostnames,
                config.allowedDesktopOrigins,
            )(
                Http.HttpMiddleware.cors({
                    allowedOrigins: [...config.allowedDesktopOrigins],
                    allowedMethods: [
                        'GET',
                        'HEAD',
                        'POST',
                        'DELETE',
                        'OPTIONS',
                    ],
                    allowedHeaders: ['content-type'],
                    exposedHeaders: ['content-disposition', 'content-type'],
                })(effect),
            ),
        disableListenLog: true,
    }).pipe(
        Layer.provideMerge(
            NodeHttpServer.layer(() => http.createServer(), {
                port: config.port,
                host: config.host,
            }),
        ),
        Layer.provide(engineLive),
    );
};
