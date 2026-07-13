import {
    CBRANCH_BACKEND_VERSION,
    CBRANCH_PROTOCOL_VERSION,
} from '@cbranch/rpc-contract';
import { Http } from '@cbranch/rpc-contract/effect-rpc-adapter';
import { Effect } from 'effect';

/** A lightweight identity probe for SSH-forwarded desktop connections. */
export const HEALTH_PATH = '/healthz';

export const healthRoute = Http.HttpRouter.add('GET', HEALTH_PATH, () =>
    Effect.succeed(
        Http.HttpServerResponse.jsonUnsafe(
            {
                service: 'cbranch',
                version: CBRANCH_BACKEND_VERSION,
                protocolVersion: CBRANCH_PROTOCOL_VERSION,
            },
            {
                headers: { 'cache-control': 'no-store' },
            },
        ),
    ),
);
