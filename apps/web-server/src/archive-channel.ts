// HTTP side-channel for archive downloads (docs/spec/09 REQ-P5-AR-004; DECISIONS D18;
// NF-SEC-3/11).
//
// `archive.prepare` mints an `ArchiveDescriptor` pointing here; `GET /sidechannel/archive`
// streams the `git archive` bytes THROUGH the engine (REQ-ARCH-010 — the web-server never
// spawns git itself). Like the blob side-channel it inherits the global `Origin`/`Host`
// guard (NF-SEC-3), so a forged Origin is rejected before any engine call. The tree-ish is
// re-validated via `archivePrepare` BEFORE a `200` is emitted, so an invalid request yields
// `400` with NO partial download; `attachment` + a conservative content type keep a crafted
// archive from executing in the SPA origin (NF-SEC-11).

import { GitEngine } from '@cbranch/core';
import { type ArchiveFormat, RepoId } from '@cbranch/rpc-contract';
import { Http } from '@cbranch/rpc-contract/effect-rpc-adapter';
import { Effect } from 'effect';

export const ARCHIVE_CHANNEL_PATH = '/sidechannel/archive';

const FORMATS: ReadonlySet<ArchiveFormat> = new Set(['zip', 'tar', 'tar.gz']);

export const archiveChannelRoute = Http.HttpRouter.add(
    'GET',
    ARCHIVE_CHANNEL_PATH,
    request =>
        Effect.gen(function* () {
            const url = new URL(request.url, 'http://localhost');
            const repoIdRaw = url.searchParams.get('repoId');
            const treeish = url.searchParams.get('treeish');
            const format = url.searchParams.get('format');
            const prefix = url.searchParams.get('prefix') ?? undefined;
            const subPath = url.searchParams.get('subPath') ?? undefined;
            if (repoIdRaw === null || treeish === null || format === null) {
                return Http.HttpServerResponse.text(
                    'missing repoId/treeish/format',
                    {
                        status: 400,
                    },
                );
            }
            if (!FORMATS.has(format as ArchiveFormat)) {
                return Http.HttpServerResponse.text('invalid format', {
                    status: 400,
                });
            }
            const fmt = format as ArchiveFormat;
            const repoId = RepoId.make(repoIdRaw);
            const engine = yield* GitEngine;

            // Validate the tree-ish + sanitize prefix/sub-path BEFORE streaming a 200 (no
            // partial download on a bad request — REQ-P5-AR-005).
            const descriptor = yield* engine
                .archivePrepare(repoId, treeish, fmt, prefix, subPath)
                .pipe(Effect.catch(() => Effect.succeed(null)));
            if (descriptor === null) {
                return Http.HttpServerResponse.text('invalid archive request', {
                    status: 400,
                });
            }

            return Http.HttpServerResponse.stream(
                engine.archiveStream(repoId, treeish, fmt, prefix, subPath),
                {
                    status: 200,
                    contentType: descriptor.contentType,
                    headers: {
                        'content-disposition': `attachment; filename="${descriptor.filename}"`,
                        'cache-control': 'no-store',
                    },
                },
            );
        }),
);
