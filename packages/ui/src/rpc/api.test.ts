import { type LogQuery, Oid, RepoId } from "@cbranch/rpc-contract";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { describe, expect, test } from "vitest";

import { makeApi } from "./api";
import { type CbranchRpcClient, RpcClientService } from "./client";

// A fake client (NF-TEST-7: no live host) implementing just the methods exercised here.
const fakeClient = {
  RepoOpen: ({ path }: { path: string }) => Effect.succeed({ repoId: RepoId.make("r1"), root: path }),
  LogStream: (_query: unknown) =>
    Stream.fromIterable([
      { oid: Oid.make("a"), subject: "a" },
      { oid: Oid.make("b"), subject: "b" },
    ]),
} as unknown as CbranchRpcClient;

const runtime = ManagedRuntime.make(Layer.succeed(RpcClientService, fakeClient));
const api = makeApi(runtime);

describe("makeApi", () => {
  test("unary methods resolve through the client", async () => {
    const handle = await api.repoOpen("/repos/demo");
    expect(handle.root).toBe("/repos/demo");
    expect(handle.repoId).toBe("r1");
  });

  test("logStream delivers each item then completes and returns an unsubscribe", async () => {
    const subjects: string[] = [];
    let unsubscribe: (() => void) | undefined;
    await new Promise<void>((resolve) => {
      // NB: do not reference `unsubscribe` inside onComplete — it may fire before the
      // assignment lands (effect would swallow the TDZ throw as a defect → hang).
      unsubscribe = api.logStream({} as unknown as LogQuery, {
        onItem: (row) => subjects.push(row.subject),
        onComplete: () => resolve(),
      });
    });
    expect(subjects).toEqual(["a", "b"]);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe?.();
  });
});
