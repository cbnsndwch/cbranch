// End-to-end transport test (docs/spec/12 NF-TEST-8; docs/spec/05 AC-1/4/5/10/11/13;
// NF-SEC-3). Boots the REAL server on an ephemeral loopback port against a throwaway
// fixture repo, then drives the read-only browse surface over a real WebSocket RPC
// client plus `fetch` for the static bundle and the HTTP side-channel, and confirms a
// forged `Origin` is rejected before any engine call. No mocks; the whole stack runs.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    createFixtureWorkspace,
    type FixtureRepo,
    type FixtureWorkspace,
    gitEngineLayer,
    makeConfigStore,
    run,
    seedLinear,
} from '@cbranch/core';
import {
    CBRANCH_BACKEND_VERSION,
    CbranchRpcs,
    DiffSpec,
    LogQuery,
    Oid,
} from '@cbranch/rpc-contract';
import {
    Http,
    RpcClient,
    RpcSerialization,
    Socket,
} from '@cbranch/rpc-contract/effect-rpc-adapter';
import { Effect, Layer, Stream } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { resolveServerConfig } from './config';
import { HEALTH_PATH } from './health-route';
import { buildServerLive } from './server';
import { WORKSPACE_AVATAR_CHANNEL_PATH } from './workspace-avatar-channel';

let workspace: FixtureWorkspace;
let repo: FixtureRepo;
let commits: ReadonlyArray<string>;
let clientDir: string;
let configPath: string;

beforeAll(async () => {
    workspace = await createFixtureWorkspace();
    repo = await workspace.createRepo('demo');
    commits = await seedLinear(repo); // [a, b, c] on main; c is HEAD
    clientDir = mkdtempSync(join(tmpdir(), 'cbranch-web-static-'));
    writeFileSync(
        join(clientDir, 'index.html'),
        '<!doctype html><title>cbranch</title><h1>cbranch-test-marker</h1>',
        'utf8',
    );
    writeFileSync(join(clientDir, 'app.js'), 'export const ok = 1;', 'utf8');
    configPath = join(workspace.root, 'server-config.json');
});

afterAll(async () => {
    await workspace.cleanup();
});

const fetchProbe = (url: string, init?: RequestInit) =>
    Effect.promise(async () => {
        const res = await fetch(url, init);
        return {
            status: res.status,
            body: await res.text(),
            contentType: res.headers.get('content-type'),
            allowOrigin: res.headers.get('access-control-allow-origin'),
            allowMethods: res.headers.get('access-control-allow-methods'),
        };
    });

const fetchBytes = (url: string, init?: RequestInit) =>
    Effect.promise(async () => {
        const res = await fetch(url, init);
        return {
            status: res.status,
            contentType: res.headers.get('content-type'),
            disposition: res.headers.get('content-disposition'),
            bytes: Buffer.from(await res.arrayBuffer()),
        };
    });

describe('web-server end-to-end (NF-TEST-8)', () => {
    test('serves the RPC bus, static SPA, and side-channel, and rejects forged Origin (NF-SEC-3)', async () => {
        const config = resolveServerConfig({
            env: { CBRANCH_BIND_ADDRESS: '127.0.0.1', CBRANCH_PORT: '0' },
            clientDir,
        });
        const configStore = makeConfigStore({ configPath });
        const avatarWorkspace = await run(
            configStore.createEngagement('Avatar workspace', 'teal'),
        );
        const avatarEngagementId = avatarWorkspace.engagements[0]!.id;
        const serverLive = buildServerLive(
            config,
            gitEngineLayer({ env: process.env, configPath }),
            configStore,
        );

        const program = Effect.gen(function* () {
            const server = yield* Http.HttpServer.HttpServer;
            const address = server.address;
            const port = address._tag === 'TcpAddress' ? address.port : 0;
            const base = `http://127.0.0.1:${port}`;

            // --- RPC over the multiplexed NDJSON WebSocket ---
            const clientLive = RpcClient.layerProtocolSocket().pipe(
                Layer.provide(
                    Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`),
                ),
                Layer.provide(Socket.layerWebSocketConstructorGlobal),
                Layer.provide(RpcSerialization.layerNdjson),
            );

            const rpc = yield* Effect.gen(function* () {
                const client = yield* RpcClient.make(CbranchRpcs);
                const systemInfo = yield* client.SystemInfo({});
                const handle = yield* client.RepoOpen({ path: repo.dir });
                const head = Oid.make(commits[commits.length - 1]!);
                const state = yield* client.RepoState({
                    repoId: handle.repoId,
                });
                const log = yield* Stream.runCollect(
                    client.LogStream(
                        new LogQuery({ repoId: handle.repoId, limit: 500 }),
                    ),
                );
                const detail = yield* client.CommitDetail({
                    repoId: handle.repoId,
                    oid: head,
                });
                const tree = yield* client.CommitTree({
                    repoId: handle.repoId,
                    oid: head,
                });
                const diff = yield* client.CommitDiff(
                    new DiffSpec({
                        repoId: handle.repoId,
                        target: commits[commits.length - 1]!,
                        cached: false,
                        whitespace: 'show',
                        context: 3,
                        renames: true,
                        combined: false,
                    }),
                );
                const content = yield* client.FileContentAtRev({
                    repoId: handle.repoId,
                    path: 'c.txt',
                    rev: commits[commits.length - 1]!,
                });
                const plugins = yield* client.PluginList({});
                const pluginRuntime = yield* client.PluginRuntimeStatus({});
                return {
                    systemInfo,
                    handle,
                    state,
                    log,
                    detail,
                    tree,
                    diff,
                    content,
                    plugins,
                    pluginRuntime,
                };
            }).pipe(Effect.provide(clientLive), Effect.scoped);

            const repoId = encodeURIComponent(rpc.handle.repoId);
            const head = commits[commits.length - 1]!;

            // --- static bundle, SPA fallback, side-channel, Origin enforcement ---
            const root = yield* fetchProbe(`${base}/`);
            const appJs = yield* fetchProbe(`${base}/app.js`);
            const health = yield* fetchProbe(`${base}${HEALTH_PATH}`);
            const spaFallback = yield* fetchProbe(`${base}/some/client/route`, {
                headers: { accept: 'text/html' },
            });
            const blob = yield* fetchProbe(
                `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=c.txt`,
            );
            const traversal = yield* fetchProbe(
                `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=../../etc`,
            );
            const forbidden = yield* fetchProbe(`${base}/`, {
                headers: { origin: 'http://evil.example.com' },
            });
            const forbiddenBlob = yield* fetchProbe(
                `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=c.txt`,
                {
                    headers: { origin: 'http://evil.example.com' },
                },
            );
            const desktopBlob = yield* fetchProbe(
                `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=c.txt`,
                { headers: { origin: 'http://tauri.localhost' } },
            );
            const desktopPreflight = yield* fetchProbe(
                `${base}/sidechannel/workspace-avatar`,
                {
                    method: 'OPTIONS',
                    headers: {
                        origin: 'http://tauri.localhost',
                        'access-control-request-method': 'POST',
                        'access-control-request-headers': 'content-type',
                    },
                },
            );

            const avatarUpload = yield* fetchProbe(
                `${base}${WORKSPACE_AVATAR_CHANNEL_PATH}?engagementId=${encodeURIComponent(avatarEngagementId)}`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'image/png' },
                    body: new Uint8Array([
                        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                    ]),
                },
            );
            const avatarUrl = JSON.parse(avatarUpload.body) as {
                avatarUrl: string;
            };
            const avatar = yield* fetchBytes(`${base}${avatarUrl.avatarUrl}`);
            const invalidAvatar = yield* fetchProbe(
                `${base}${WORKSPACE_AVATAR_CHANNEL_PATH}?engagementId=${encodeURIComponent(avatarEngagementId)}`,
                { method: 'POST', body: 'not an image' },
            );
            const forbiddenAvatar = yield* fetchProbe(
                `${base}${WORKSPACE_AVATAR_CHANNEL_PATH}?engagementId=${encodeURIComponent(avatarEngagementId)}`,
                {
                    method: 'POST',
                    body: new Uint8Array([
                        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
                    ]),
                    headers: { origin: 'http://evil.example.com' },
                },
            );
            const avatarDelete = yield* fetchProbe(
                `${base}${WORKSPACE_AVATAR_CHANNEL_PATH}?engagementId=${encodeURIComponent(avatarEngagementId)}`,
                { method: 'DELETE' },
            );
            const removedAvatar = yield* fetchBytes(
                `${base}${avatarUrl.avatarUrl}`,
            );

            // --- archive side-channel (REQ-P5-AR-004/005) ---
            const archiveOk = yield* fetchBytes(
                `${base}/sidechannel/archive?repoId=${repoId}&treeish=HEAD&format=zip`,
            );
            const archiveBadTree = yield* fetchBytes(
                `${base}/sidechannel/archive?repoId=${repoId}&treeish=no-such-ref&format=zip`,
            );
            const archiveBadPrefix = yield* fetchBytes(
                `${base}/sidechannel/archive?repoId=${repoId}&treeish=HEAD&format=zip&prefix=../evil`,
            );
            const archiveNoTree = yield* fetchBytes(
                `${base}/sidechannel/archive?repoId=${repoId}&format=zip`,
            );
            const archiveBadFormat = yield* fetchBytes(
                `${base}/sidechannel/archive?repoId=${repoId}&treeish=HEAD&format=rar`,
            );
            const forbiddenArchive = yield* fetchBytes(
                `${base}/sidechannel/archive?repoId=${repoId}&treeish=HEAD&format=zip`,
                { headers: { origin: 'http://evil.example.com' } },
            );

            return {
                rpc,
                root,
                appJs,
                health,
                spaFallback,
                blob,
                traversal,
                forbidden,
                forbiddenBlob,
                desktopBlob,
                desktopPreflight,
                avatarUpload,
                avatar,
                invalidAvatar,
                forbiddenAvatar,
                avatarDelete,
                removedAvatar,
                archiveOk,
                archiveBadTree,
                archiveBadPrefix,
                archiveNoTree,
                archiveBadFormat,
                forbiddenArchive,
            };
        }).pipe(Effect.provide(serverLive), Effect.scoped);

        const r = await Effect.runPromise(program);

        // AC-1 / AC-5: open resolves identity + state without full history.
        expect(r.rpc.systemInfo.protocolVersion).toBe(1);
        expect(r.rpc.systemInfo.capabilities).toContain('system-info');
        expect(r.rpc.handle.repoId).toMatch(/^[0-9a-f]{64}$/);
        expect(r.rpc.handle.state.currentBranch).toBe('main');
        expect(r.rpc.handle.state.isEmpty).toBe(false);
        expect(r.rpc.handle.state.isBare).toBe(false);
        expect(r.rpc.state.headOid).toBe(commits[commits.length - 1]);
        // The host exposes no runnable plugin until an OS sandbox supervisor exists.
        expect(r.rpc.plugins).toEqual([]);
        expect(r.rpc.pluginRuntime.available).toBe(true);
        expect(r.rpc.pluginRuntime.reason).toContain('Trusted local ESM');

        // AC-6/AC-7 (transport): the streaming history feed yields every commit, newest first.
        expect(r.rpc.log).toHaveLength(3);
        expect(r.rpc.log.map(c => c.subject)).toEqual(['c', 'b', 'a']);

        // AC-10: full commit detail with navigable parents.
        expect(r.rpc.detail.subject).toBe('c');
        expect(r.rpc.detail.parents).toContain(commits[commits.length - 2]);

        // commit.tree reads the selected tree, including files unchanged by commit c.
        expect(r.rpc.tree.paths).toEqual(['a.txt', 'b.txt', 'c.txt']);

        // AC-11: changed-file list for the commit vs its first parent.
        expect(r.rpc.diff).toHaveLength(1);
        expect(r.rpc.diff[0]!.newPath).toBe('c.txt');
        expect(r.rpc.diff[0]!.status).toBe('added');

        // AC-13: inline file content at a revision.
        expect('content' in r.rpc.content).toBe(true);
        if ('content' in r.rpc.content) {
            expect(r.rpc.content.content.trimEnd()).toBe('c');
            expect(r.rpc.content.isBinary).toBe(false);
            expect(r.rpc.content.encoding).toBe('utf8');
        }

        // NF-PKG-1: static SPA bundle + index fallback for client routes.
        expect(r.root.status).toBe(200);
        expect(r.root.body).toContain('cbranch-test-marker');
        expect(r.appJs.status).toBe(200);
        expect(r.health.status).toBe(200);
        expect(JSON.parse(r.health.body)).toEqual({
            service: 'cbranch',
            version: CBRANCH_BACKEND_VERSION,
            protocolVersion: 1,
        });
        expect(r.health.contentType).toContain('application/json');
        expect(r.spaFallback.status).toBe(200);
        expect(r.spaFallback.body).toContain('cbranch-test-marker');

        // D4: side-channel streams the blob; NF-SEC-5: traversal rejected.
        expect(r.blob.status).toBe(200);
        expect(r.blob.body.trimEnd()).toBe('c');
        expect(r.traversal.status).toBe(400);

        // NF-SEC-3: forged Origin rejected (HTTP route + side-channel) before any engine call.
        expect(r.forbidden.status).toBe(403);
        expect(r.forbiddenBlob.status).toBe(403);
        expect(r.desktopBlob.status).toBe(200);
        expect(r.desktopBlob.allowOrigin).toBe('http://tauri.localhost');
        expect(r.desktopPreflight.status).toBe(204);
        expect(r.desktopPreflight.allowOrigin).toBe('http://tauri.localhost');
        expect(r.desktopPreflight.allowMethods).toContain('POST');

        // Workspace images are validated, persisted by the host, and served only through
        // the guarded local side-channel. The cache-busting URL becomes unavailable after
        // explicit removal.
        expect(r.avatarUpload.status).toBe(200);
        expect(r.avatar.contentType).toContain('image/png');
        expect([...r.avatar.bytes]).toEqual([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        expect(r.invalidAvatar.status).toBe(400);
        expect(r.forbiddenAvatar.status).toBe(403);
        expect(r.avatarDelete.status).toBe(204);
        expect(r.removedAvatar.status).toBe(404);

        // REQ-P5-AR-004/005: archive streams a zip with attachment disposition; an invalid
        // tree-ish or traversal prefix is 400 with NO archive bytes (no partial download);
        // a forged Origin is rejected before any engine call.
        expect(r.archiveOk.status).toBe(200);
        expect(r.archiveOk.contentType).toContain('application/zip');
        expect(r.archiveOk.disposition).toContain('attachment');
        expect(r.archiveOk.disposition).toContain('cbranch-HEAD.zip');
        expect([...r.archiveOk.bytes.subarray(0, 4)]).toEqual([
            0x50, 0x4b, 0x03, 0x04,
        ]);
        expect(r.archiveBadTree.status).toBe(400);
        expect([...r.archiveBadTree.bytes.subarray(0, 4)]).not.toEqual([
            0x50, 0x4b, 0x03, 0x04,
        ]);
        expect(r.archiveBadPrefix.status).toBe(400);
        // REQ-P5-AR-004: a missing tree-ish and an unsupported format are each rejected
        // with 400 before any engine call (no partial download).
        expect(r.archiveNoTree.status).toBe(400);
        expect(r.archiveBadFormat.status).toBe(400);
        expect(r.forbiddenArchive.status).toBe(403);
    }, 30_000);
});
