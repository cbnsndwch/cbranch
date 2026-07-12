// RPC client runtime (docs/spec/14 §2; DECISIONS D3/D10).
//
// The browser talks to the host over ONE multiplexed NDJSON WebSocket. This module
// builds that transport and a single long-lived `ManagedRuntime` that owns the client
// connection for the app's lifetime — the SOLE place the UI reaches the host. Every
// `effect/unstable/*` symbol comes through the rpc-contract adapter (D10); `CbranchRpcs`
// is the same catalog the server binds, so client and server can never drift.

import { CbranchRpcs } from '@cbranch/rpc-contract';
import {
    RpcClient,
    RpcSerialization,
    Socket,
} from '@cbranch/rpc-contract/effect-rpc-adapter';
import {
    Context,
    type Effect as EffectNS,
    Effect,
    Layer,
    ManagedRuntime,
    Stream,
} from 'effect';

const makeClient = RpcClient.make(CbranchRpcs);

/** The typed client object (`client.RepoOpen(...)`, `client.LogStream(...)`, …). */
export type CbranchRpcClient =
    typeof makeClient extends EffectNS.Effect<infer A, infer _E, infer _R>
        ? A
        : never;

/** Context service holding the connected client, built once per runtime. */
export class RpcClientService extends Context.Service<
    RpcClientService,
    CbranchRpcClient
>()('ui/RpcClient') {}

/** The WebSocket transport layer for the multiplexed NDJSON bus at `url` (e.g. `ws://host:port/rpc`). */
export const transportLayer = (url: string): Layer.Layer<RpcClient.Protocol> =>
    RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(url)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerNdjson),
    );

/** Layer that constructs the connected {@link RpcClientService} over the transport. */
export const rpcClientLayer = (url: string): Layer.Layer<RpcClientService> =>
    Layer.effect(RpcClientService, makeClient).pipe(
        Layer.provide(transportLayer(url)),
    );

/** Build the single app runtime that owns the live client connection. Dispose on teardown. */
export const makeAppRuntime = (
    url: string,
): ManagedRuntime.ManagedRuntime<RpcClientService, never> =>
    ManagedRuntime.make(rpcClientLayer(url));

export type AppRuntime = ReturnType<typeof makeAppRuntime>;

/** Run an effect against the connected client. */
export const withClient = <A, E>(
    f: (client: CbranchRpcClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E, RpcClientService> => Effect.flatMap(RpcClientService, f);

/** Open a stream from the connected client (history feed, invalidation bus). */
export const streamWithClient = <A, E>(
    f: (client: CbranchRpcClient) => Stream.Stream<A, E>,
): Stream.Stream<A, E, RpcClientService> =>
    Stream.unwrap(Effect.map(RpcClientService, f));

/** A selected cbranch backend, including its HTTP side-channel base. */
export interface HostEndpoint {
    readonly rpcUrl: string;
    readonly httpBaseUrl: string;
}

const asHttpProtocol = (protocol: string): string =>
    protocol === 'wss:' ? 'https:' : 'http:';

/** Validate and normalize an explicit backend endpoint. */
export const makeHostEndpoint = (
    rpcUrl: string,
    httpBaseUrl?: string,
): HostEndpoint => {
    const rpc = new URL(rpcUrl);
    if (rpc.protocol !== 'ws:' && rpc.protocol !== 'wss:')
        throw new Error('The RPC endpoint must use ws:// or wss://.');
    if (rpc.pathname !== '/rpc' || rpc.search !== '' || rpc.hash !== '')
        throw new Error('The RPC endpoint must end with /rpc.');

    const derivedHttp = new URL(rpc);
    derivedHttp.protocol = asHttpProtocol(rpc.protocol);
    derivedHttp.pathname = '';
    const http = new URL(httpBaseUrl ?? derivedHttp.toString());
    if (http.protocol !== 'http:' && http.protocol !== 'https:')
        throw new Error('The HTTP endpoint must use http:// or https://.');
    http.pathname = http.pathname.replace(/\/$/, '');
    http.search = '';
    http.hash = '';

    return { rpcUrl: rpc.toString(), httpBaseUrl: http.toString() };
};

/** Default RPC endpoint derived from the page origin (loopback dev or served host). */
export const defaultHostEndpoint = (location: {
    protocol: string;
    host: string;
}): HostEndpoint => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return makeHostEndpoint(`${scheme}//${location.host}/rpc`);
};

/** Kept for callers that require only the WebSocket URL. */
export const defaultRpcUrl = (location: {
    protocol: string;
    host: string;
}): string => defaultHostEndpoint(location).rpcUrl;

/** Resolve a backend-relative side-channel URL against the selected connection. */
export const resolveHostUrl = (
    endpoint: HostEndpoint,
    value: string,
): string => {
    try {
        return new URL(value).toString();
    } catch {
        const resolved = new URL(value, `${endpoint.httpBaseUrl}/`);
        if (
            typeof window !== 'undefined' &&
            resolved.origin === window.location.origin
        )
            return `${resolved.pathname}${resolved.search}${resolved.hash}`;
        return resolved.toString();
    }
};
