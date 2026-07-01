// HTTP side-channel for patch interchange (docs/spec/17 REQ-P6-PATCH-001/006; NF-SEC-3/11).
//
// Outbound: `GET /sidechannel/patch` streams a `format-patch` bundle THROUGH the engine
// (REQ-ARCH-010 — the web-server never spawns git itself). The range is re-validated via
// `patch.formatPrepare` BEFORE a 200, so an invalid request yields 400 with no partial
// download; `attachment` + a text content type keep the patch from executing in the SPA
// origin. Inbound: `POST /sidechannel/patch-upload` accepts a large `.patch` body that
// exceeds the inline RPC cap and returns an upload token the `patch.apply`/`patch.inspect`
// payload references in place of inline text. Both inherit the global Origin/Host guard.

import { GitEngine } from '@cbranch/core';
import { RepoId } from '@cbranch/rpc-contract';
import { Http } from '@cbranch/rpc-contract/effect-rpc-adapter';
import { Effect } from 'effect';

export const PATCH_CHANNEL_PATH = '/sidechannel/patch';
export const PATCH_UPLOAD_PATH = '/sidechannel/patch-upload';

// A bounded, in-memory store of uploaded patch bodies keyed by an opaque token. It is
// ephemeral diagnostic-style state (never persisted); the oldest entries age out so a long
// session cannot grow memory unbounded. A monotonic counter avoids any time/randomness.
const UPLOAD_CAPACITY = 64;
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024; // 16 MB inbound cap.
const uploads = new Map<string, string>();
let uploadSeq = 0;

const putUpload = (text: string): string => {
    const token = `up-${uploadSeq++}`;
    uploads.set(token, text);
    while (uploads.size > UPLOAD_CAPACITY) {
        const oldest = uploads.keys().next().value;
        if (oldest === undefined) break;
        uploads.delete(oldest);
    }
    return token;
};

/** Resolve an upload token to its stored patch text (used by the patch RPC handlers). */
export const getUpload = (token: string): string | undefined =>
    uploads.get(token);

export const patchChannelRoute = Http.HttpRouter.add(
    'GET',
    PATCH_CHANNEL_PATH,
    request =>
        Effect.gen(function* () {
            const url = new URL(request.url, 'http://localhost');
            const repoIdRaw = url.searchParams.get('repoId');
            const range = url.searchParams.get('range');
            const includeCover =
                url.searchParams.get('includeCover') === 'true';
            if (repoIdRaw === null || range === null) {
                return Http.HttpServerResponse.text('missing repoId/range', {
                    status: 400,
                });
            }
            const repoId = RepoId.make(repoIdRaw);
            const engine = yield* GitEngine;

            // Re-validate the range BEFORE streaming a 200 (no partial download on failure).
            const descriptor = yield* engine
                .patchFormatPrepare(repoId, range, includeCover)
                .pipe(Effect.catch(() => Effect.succeed(null)));
            if (descriptor === null) {
                return Http.HttpServerResponse.text('invalid patch range', {
                    status: 400,
                });
            }

            return Http.HttpServerResponse.stream(
                engine.patchFormatStream(repoId, range, includeCover),
                {
                    status: 200,
                    contentType: 'text/x-patch; charset=utf-8',
                    headers: {
                        'content-disposition': `attachment; filename="${descriptor.filename}"`,
                        'cache-control': 'no-store',
                    },
                },
            );
        }),
);

export const patchUploadRoute = Http.HttpRouter.add(
    'POST',
    PATCH_UPLOAD_PATH,
    request =>
        Effect.gen(function* () {
            const text = yield* request.text.pipe(
                Effect.catch(() => Effect.succeed(null)),
            );
            if (text === null) {
                return Http.HttpServerResponse.text('bad request body', {
                    status: 400,
                });
            }
            if (Buffer.byteLength(text, 'utf8') > MAX_UPLOAD_BYTES) {
                return Http.HttpServerResponse.text('patch too large', {
                    status: 413,
                });
            }
            const token = putUpload(text);
            return Http.HttpServerResponse.text(
                JSON.stringify({ uploadId: token }),
                {
                    status: 200,
                    contentType: 'application/json; charset=utf-8',
                    headers: { 'cache-control': 'no-store' },
                },
            );
        }),
);
