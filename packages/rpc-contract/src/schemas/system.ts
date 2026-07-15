// Connection bootstrap schemas. This is deliberately transport-neutral: desktop
// clients use it before mounting the Git UI, while browser clients use the same RPC.

import { Schema } from 'effect';

/** Bump only for a breaking wire-contract change. */
export const CBRANCH_PROTOCOL_VERSION = 1;

/** Version reported by the backend until release packaging injects a build version. */
export const CBRANCH_BACKEND_VERSION = '0.1.7';

/** Capabilities are additive so clients can explain a missing feature before use. */
export const CbranchCapability = Schema.Literals([
    'system-info',
    'loopback-rpc-v1',
    'side-channel-v1',
]);
export type CbranchCapability = typeof CbranchCapability.Type;

/** A small, non-secret compatibility response returned before normal UI queries. */
export class SystemInfo extends Schema.Class<SystemInfo>('SystemInfo')({
    version: Schema.String,
    protocolVersion: Schema.Number,
    capabilities: Schema.Array(CbranchCapability),
}) {}
