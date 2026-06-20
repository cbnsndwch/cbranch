// @vitest-environment jsdom
import {
  CommitCreated,
  CommitInput,
  Oid,
  RepoId,
  StatusEntry,
  WorkingTreeStatus,
} from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "./api";
import { ApiProvider } from "./ApiProvider";
import { useCommitCreate, useStageFiles, useStatus } from "./hooks";

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

describe("useCommitCreate optimistic status clear", () => {
  const commitInput = new CommitInput({
    repoId,
    subject: "do thing",
    amend: false,
    signoff: false,
    allowEmpty: false,
    noVerify: false,
  });

  test("clears the staged portion immediately, before the commit settles", async () => {
    const mixedStatus = new WorkingTreeStatus({
      entries: [
        // staged-only → fully committed → removed
        makeEntry({
          path: "staged.ts",
          staged: "modified",
          unstaged: "unmodified",
        }),
        // staged + unstaged → staged committed, unstaged edit remains → kept
        makeEntry({
          path: "mixed.ts",
          staged: "modified",
          unstaged: "modified",
        }),
        // untracked → unaffected → kept
        makeEntry({
          path: "new.ts",
          staged: "unmodified",
          unstaged: "untracked",
          isUntracked: true,
        }),
      ],
      hasConflicts: false,
    });
    // A commit that stays in flight, so onSettled's refetch can't mask the optimistic state.
    let resolve!: (v: CommitCreated) => void;
    const api = makeFakeApi({
      statusGet: vi.fn(async () => mixedStatus),
      commitCreate: vi.fn(
        () => new Promise<CommitCreated>((r) => (resolve = r)),
      ),
    });
    const wrapper = makeWrapper(api);
    const { result } = renderHook(
      () => ({ status: useStatus(repoId), commit: useCommitCreate(repoId) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.status.isSuccess).toBe(true));
    expect(result.current.status.data?.entries).toHaveLength(3);

    await act(async () => {
      result.current.commit.mutate(commitInput);
    });

    await waitFor(() =>
      expect(result.current.status.data?.entries.map((e) => e.path)).toEqual([
        "mixed.ts",
        "new.ts",
      ]),
    );
    // The surviving mixed entry has its staged side cleared.
    const mixed = result.current.status.data?.entries.find(
      (e) => e.path === "mixed.ts",
    );
    expect(mixed?.staged).toBe("unmodified");
    expect(mixed?.unstaged).toBe("modified");

    await act(async () => {
      resolve(
        new CommitCreated({
          oid: Oid.make("a".repeat(40)),
          shortOid: "aaaaaaa",
          subject: "do thing",
        }),
      );
    });
  });

  test("rolls back the optimistic clear if the commit fails", async () => {
    const api = makeFakeApi({
      statusGet: vi.fn(async () => fakeStatus),
      commitCreate: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { result } = renderHook(
      () => ({ status: useStatus(repoId), commit: useCommitCreate(repoId) }),
      { wrapper: makeWrapper(api) },
    );
    await waitFor(() => expect(result.current.status.isSuccess).toBe(true));
    await act(async () => {
      result.current.commit.mutate(commitInput);
    });
    // After the failure rolls back and onSettled refetches, the staged entry is back.
    await waitFor(() =>
      expect(result.current.status.data?.entries.map((e) => e.path)).toEqual([
        "a.ts",
      ]),
    );
  });
});
