// Persistent workspace avatar side-channel. Uploaded files remain under cbranch's
// config directory, are validated by the core store, and are only reachable through
// the host's globally guarded same-origin HTTP server.

import { type ConfigStore, MAX_WORKSPACE_AVATAR_BYTES } from '@cbranch/core';
import { EngagementId } from '@cbranch/rpc-contract';
import { Http } from '@cbranch/rpc-contract/effect-rpc-adapter';
import { Effect, Result } from 'effect';

export const WORKSPACE_AVATAR_CHANNEL_PATH =
    '/sidechannel/workspace-avatar' as const;
const WORKSPACE_AVATAR_FILE_PATH =
    '/sidechannel/workspace-avatar/:filename' as const;

const badRequest = (message: string) =>
    Http.HttpServerResponse.text(message, { status: 400 });

const uploadFailure = (message: string, code?: string) =>
    Http.HttpServerResponse.text(message, {
        status: code === 'engagementNotFound' ? 404 : 400,
    });

export const workspaceAvatarUploadRoute = (configStore: ConfigStore) =>
    Http.HttpRouter.add('POST', WORKSPACE_AVATAR_CHANNEL_PATH, request =>
        Effect.gen(function* () {
            const url = new URL(request.url, 'http://localhost');
            const rawEngagementId = url.searchParams.get('engagementId');
            if (rawEngagementId === null)
                return badRequest('missing engagementId');
            const contentLength = Number(
                request.headers['content-length'] ?? '',
            );
            if (
                Number.isFinite(contentLength) &&
                contentLength > MAX_WORKSPACE_AVATAR_BYTES
            )
                return Http.HttpServerResponse.text('avatar too large', {
                    status: 413,
                });
            const body = yield* request.arrayBuffer.pipe(
                Effect.catch(() => Effect.succeed(null)),
            );
            if (body === null) return badRequest('bad request body');
            const result = yield* configStore
                .uploadEngagementAvatar(
                    EngagementId.make(rawEngagementId),
                    new Uint8Array(body),
                )
                .pipe(Effect.result);
            if (Result.isFailure(result))
                return uploadFailure(
                    result.failure.message,
                    result.failure.code,
                );
            return Http.HttpServerResponse.jsonUnsafe(result.success, {
                status: 200,
                headers: { 'cache-control': 'no-store' },
            });
        }),
    );

export const workspaceAvatarRoute = (configStore: ConfigStore) =>
    Http.HttpRouter.add('GET', WORKSPACE_AVATAR_FILE_PATH, () =>
        Effect.gen(function* () {
            const params = yield* Http.HttpRouter.params;
            const image = yield* configStore.readEngagementAvatar(
                params.filename ?? '',
            );
            if (!image)
                return Http.HttpServerResponse.text('not found', {
                    status: 404,
                });
            return Http.HttpServerResponse.uint8Array(image.bytes, {
                status: 200,
                contentType: image.contentType,
                headers: {
                    'cache-control': 'private, max-age=31536000, immutable',
                    'x-content-type-options': 'nosniff',
                },
            });
        }),
    );

export const workspaceAvatarDeleteRoute = (configStore: ConfigStore) =>
    Http.HttpRouter.add('DELETE', WORKSPACE_AVATAR_CHANNEL_PATH, request =>
        Effect.gen(function* () {
            const url = new URL(request.url, 'http://localhost');
            const rawEngagementId = url.searchParams.get('engagementId');
            if (rawEngagementId === null)
                return badRequest('missing engagementId');
            const result = yield* configStore
                .removeEngagementAvatar(EngagementId.make(rawEngagementId))
                .pipe(Effect.result);
            if (Result.isFailure(result))
                return uploadFailure(
                    result.failure.message,
                    result.failure.code,
                );
            return Http.HttpServerResponse.empty({
                status: 204,
                headers: { 'cache-control': 'no-store' },
            });
        }),
    );
