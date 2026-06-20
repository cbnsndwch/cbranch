// @vitest-environment jsdom
import { RepoId, StatusEntry, WorkingTreeStatus } from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "./api";
import { ApiProvider } from "./ApiProvider";
import { useStageFiles, useStatus } from "./hooks";

const repoId = RepoId.make("repo-1");

const makeEntry = (overrides: Partial<StatusEntry>): StatusEntry =>
  new StatusEntry({
    path: "file.ts",
    staged: "unmodified",
    unstaged: "modified",
    isConflicted: false,
    isUntracked: false,
    isIgnored: false,
    isSubmodule: false,
    ...overrides,
  });

const fakeStatus = new WorkingTreeStatus({
  entries: [
    makeEntry({ path: "a.ts", staged: "modified", unstaged: "modified" }),
  ],
  hasConflicts: false,
});

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    statusGet: vi.fn(async () => fakeStatus),
    stageFiles: vi.fn(async () => undefined),
    unstageFiles: vi.fn(async () => undefined),
    discardFiles: vi.fn(async () => undefined),
    deleteUntracked: vi.fn(async () => undefined),
    resetTo: vi.fn(async () => undefined),
    stageHunks: vi.fn(async () => undefined),
    unstageHunks: vi.fn(async () => undefined),
    discardHunks: vi.fn(async () => undefined),
    commitCreate: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    commitLastMessage: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    workingFileDiff: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    repoOpen: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    recentList: vi.fn(async () => []),
    recentRemove: vi.fn(async () => undefined),
    repoState: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    commitDetail: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    commitDiff: vi.fn(async () => []),
    fileContentAtRev: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    logStream: vi.fn(() => () => undefined),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  }) as unknown as CbranchApi;

const makeWrapper =
  (api: CbranchApi) =>
  ({ children }: { children: ReactNode }) => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return (
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>{children}</ApiProvider>
      </QueryClientProvider>
    );
  };

describe("useStatus", () => {
  test("fetches working-tree status from the API", async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useStatus(repoId), {
      wrapper: makeWrapper(api),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.entries).toHaveLength(1);
    expect(result.current.data?.entries[0]?.path).toBe("a.ts");
  });

  test("does not fetch when repoId is null", () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useStatus(null), {
      wrapper: makeWrapper(api),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.statusGet).not.toHaveBeenCalled();
  });
});

describe("useStageFiles", () => {
  test("calls stageFiles and invalidates status on settled", async () => {
    const api = makeFakeApi();
    const { result } = renderHook(() => useStageFiles(repoId), {
      wrapper: makeWrapper(api),
    });
    await act(async () => {
      result.current.mutate({ paths: ["a.ts"] });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.stageFiles).toHaveBeenCalledWith(repoId, ["a.ts"], undefined);
  });
});
