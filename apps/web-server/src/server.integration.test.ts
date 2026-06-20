// End-to-end transport test (docs/spec/12 NF-TEST-8; docs/spec/05 AC-1/4/5/10/11/13;
// NF-SEC-3). Boots the REAL server on an ephemeral loopback port against a throwaway
// fixture repo, then drives the read-only browse surface over a real WebSocket RPC
// client plus `fetch` for the static bundle and the HTTP side-channel, and confirms a
// forged `Origin` is rejected before any engine call. No mocks; the whole stack runs.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFixtureWorkspace,
  type FixtureRepo,
  type FixtureWorkspace,
  gitEngineLayer,
  seedLinear,
} from "@cbranch/core";
import { CbranchRpcs, DiffSpec, LogQuery, Oid } from "@cbranch/rpc-contract";
import {
  Http,
  RpcClient,
  RpcSerialization,
  Socket,
} from "@cbranch/rpc-contract/effect-rpc-adapter";
import { Effect, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { resolveServerConfig } from "./config";
import { buildServerLive } from "./server";

let workspace: FixtureWorkspace;
let repo: FixtureRepo;
let commits: ReadonlyArray<string>;
let clientDir: string;
let configPath: string;

beforeAll(async () => {
  workspace = await createFixtureWorkspace();
  repo = await workspace.createRepo("demo");
  commits = await seedLinear(repo); // [a, b, c] on main; c is HEAD
  clientDir = mkdtempSync(join(tmpdir(), "cbranch-web-static-"));
  writeFileSync(
    join(clientDir, "index.html"),
    "<!doctype html><title>cbranch</title><h1>cbranch-test-marker</h1>",
    "utf8",
  );
  writeFileSync(join(clientDir, "app.js"), "export const ok = 1;", "utf8");
  configPath = join(workspace.root, "server-config.json");
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
      contentType: res.headers.get("content-type"),
    };
  });

describe("web-server end-to-end (NF-TEST-8)", () => {
  test("serves the RPC bus, static SPA, and side-channel, and rejects forged Origin (NF-SEC-3)", async () => {
    const config = resolveServerConfig({
      env: { CBRANCH_BIND_ADDRESS: "127.0.0.1", CBRANCH_PORT: "0" },
      clientDir,
    });
    const serverLive = buildServerLive(
      config,
      gitEngineLayer({ env: process.env, configPath }),
    );

    const program = Effect.gen(function* () {
      const server = yield* Http.HttpServer.HttpServer;
      const address = server.address;
      const port = address._tag === "TcpAddress" ? address.port : 0;
      const base = `http://127.0.0.1:${port}`;

      // --- RPC over the multiplexed NDJSON WebSocket ---
      const clientLive = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerNdjson),
      );

      const rpc = yield* Effect.gen(function* () {
        const client = yield* RpcClient.make(CbranchRpcs);
        const handle = yield* client.RepoOpen({ path: repo.dir });
        const head = Oid.make(commits[commits.length - 1]!);
        const state = yield* client.RepoState({ repoId: handle.repoId });
        const log = yield* Stream.runCollect(
          client.LogStream(new LogQuery({ repoId: handle.repoId, limit: 500 })),
        );
        const detail = yield* client.CommitDetail({
          repoId: handle.repoId,
          oid: head,
        });
        const diff = yield* client.CommitDiff(
          new DiffSpec({
            repoId: handle.repoId,
            target: commits[commits.length - 1]!,
            cached: false,
            whitespace: "show",
            context: 3,
            renames: true,
            combined: false,
          }),
        );
        const content = yield* client.FileContentAtRev({
          repoId: handle.repoId,
          path: "c.txt",
          rev: commits[commits.length - 1]!,
        });
        return { handle, state, log, detail, diff, content };
      }).pipe(Effect.provide(clientLive), Effect.scoped);

      const repoId = encodeURIComponent(rpc.handle.repoId);
      const head = commits[commits.length - 1]!;

      // --- static bundle, SPA fallback, side-channel, Origin enforcement ---
      const root = yield* fetchProbe(`${base}/`);
      const appJs = yield* fetchProbe(`${base}/app.js`);
      const spaFallback = yield* fetchProbe(`${base}/some/client/route`, {
        headers: { accept: "text/html" },
      });
      const blob = yield* fetchProbe(
        `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=c.txt`,
      );
      const traversal = yield* fetchProbe(
        `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=../../etc`,
      );
      const forbidden = yield* fetchProbe(`${base}/`, {
        headers: { origin: "http://evil.example.com" },
      });
      const forbiddenBlob = yield* fetchProbe(
        `${base}/sidechannel/blob?repoId=${repoId}&rev=${head}&path=c.txt`,
        {
          headers: { origin: "http://evil.example.com" },
        },
      );

      return {
        rpc,
        root,
        appJs,
        spaFallback,
        blob,
        traversal,
        forbidden,
        forbiddenBlob,
      };
    }).pipe(Effect.provide(serverLive), Effect.scoped);

    const r = await Effect.runPromise(program);

    // AC-1 / AC-5: open resolves identity + state without full history.
    expect(r.rpc.handle.repoId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.rpc.handle.state.currentBranch).toBe("main");
    expect(r.rpc.handle.state.isEmpty).toBe(false);
    expect(r.rpc.handle.state.isBare).toBe(false);
    expect(r.rpc.state.headOid).toBe(commits[commits.length - 1]);

    // AC-6/AC-7 (transport): the streaming history feed yields every commit, newest first.
    expect(r.rpc.log).toHaveLength(3);
    expect(r.rpc.log.map((c) => c.subject)).toEqual(["c", "b", "a"]);

    // AC-10: full commit detail with navigable parents.
    expect(r.rpc.detail.subject).toBe("c");
    expect(r.rpc.detail.parents).toContain(commits[commits.length - 2]);

    // AC-11: changed-file list for the commit vs its first parent.
    expect(r.rpc.diff).toHaveLength(1);
    expect(r.rpc.diff[0]!.newPath).toBe("c.txt");
    expect(r.rpc.diff[0]!.status).toBe("added");

    // AC-13: inline file content at a revision.
    expect("content" in r.rpc.content).toBe(true);
    if ("content" in r.rpc.content) {
      expect(r.rpc.content.content.trimEnd()).toBe("c");
      expect(r.rpc.content.isBinary).toBe(false);
      expect(r.rpc.content.encoding).toBe("utf8");
    }

    // NF-PKG-1: static SPA bundle + index fallback for client routes.
    expect(r.root.status).toBe(200);
    expect(r.root.body).toContain("cbranch-test-marker");
    expect(r.appJs.status).toBe(200);
    expect(r.spaFallback.status).toBe(200);
    expect(r.spaFallback.body).toContain("cbranch-test-marker");

    // D4: side-channel streams the blob; NF-SEC-5: traversal rejected.
    expect(r.blob.status).toBe(200);
    expect(r.blob.body.trimEnd()).toBe("c");
    expect(r.traversal.status).toBe(400);

    // NF-SEC-3: forged Origin rejected (HTTP route + side-channel) before any engine call.
    expect(r.forbidden.status).toBe(403);
    expect(r.forbiddenBlob.status).toBe(403);
  }, 30_000);
});
