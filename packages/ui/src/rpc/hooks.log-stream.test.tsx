// @vitest-environment jsdom
import { CommitCreated, LogQuery, Oid, RepoId } from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "./api";
import { ApiProvider } from "./ApiProvider";
import { useCommitCreate, useLogStream } from "./hooks";

const repoId = RepoId.make("repo-1");
const query = new LogQuery({ repoId, limit: 50, refScope: "current" });

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    // Each subscription immediately completes with no rows; we only count subscriptions.
    logStream: vi.fn((_q, h) => {
      h.onComplete();
      return () => undefined;
    }),
    commitCreate: vi.fn(
      async () =>
        new CommitCreated({
          oid: Oid.make("a".repeat(40)),
          shortOid: "aaaaaaa",
          subject: "x",
        }),
    ),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  }) as unknown as CbranchApi;

const makeWrapper = (api: CbranchApi) => {
  // One shared client so the commit mutation's invalidation reaches the log sentinel.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ApiProvider api={api}>{children}</ApiProvider>
    </QueryClientProvider>
  );
};

describe("useLogStream refresh-on-commit (commits-domain bridge)", () => {
  test("subscribes once on mount", async () => {
    const api = makeFakeApi();
    renderHook(() => useLogStream(query), { wrapper: makeWrapper(api) });
    await waitFor(() =>
      expect(
        (api.logStream as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1),
    );
  });

  test("re-subscribes when a commit invalidates the commits domain", async () => {
    const api = makeFakeApi();
    const { result } = renderHook(
      () => ({ log: useLogStream(query), commit: useCommitCreate(repoId) }),
      { wrapper: makeWrapper(api) },
    );
    const logStream = api.logStream as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(logStream.mock.calls.length).toBe(1));

    await act(async () => {
      result.current.commit.mutate({
        repoId,
        subject: "new commit",
        amend: false,
        signoff: false,
        allowEmpty: false,
        noVerify: false,
      });
    });

    // The commit invalidates [repoId, "commits"]; the log sentinel refetches and the
    // stream restarts to re-snapshot the new history.
    await waitFor(() => expect(logStream.mock.calls.length).toBe(2));
  });
});
