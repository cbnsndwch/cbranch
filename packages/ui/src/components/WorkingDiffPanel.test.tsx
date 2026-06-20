// @vitest-environment jsdom
import { DiffFile, DiffLine, Hunk, HunkSelection, PatchSelection, RepoId } from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { WorkingDiffPanel } from "./WorkingDiffPanel";

const repoId = RepoId.make("repo-1");

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi => ({
  repoOpen: vi.fn(async () => {
    throw new Error("not used");
  }),
  recentList: vi.fn(async () => []),
  recentRemove: vi.fn(async () => undefined),
  repoState: vi.fn(async () => {
    throw new Error("not used");
  }),
  commitDetail: vi.fn(async () => {
    throw new Error("not used");
  }),
  commitDiff: vi.fn(async () => []),
  workingFileDiff: vi.fn(async () => {
    throw new Error("not implemented");
  }),
  fileContentAtRev: vi.fn(async () => {
    throw new Error("not used");
  }),
  statusGet: vi.fn(async () => {
    throw new Error("not used");
  }),
  stageFiles: vi.fn(async () => undefined),
  unstageFiles: vi.fn(async () => undefined),
  discardFiles: vi.fn(async () => undefined),
  deleteUntracked: vi.fn(async () => undefined),
  resetTo: vi.fn(async () => undefined),
  stageHunks: vi.fn(async () => undefined),
  unstageHunks: vi.fn(async () => undefined),
  discardHunks: vi.fn(async () => undefined),
  commitCreate: vi.fn(async () => {
    throw new Error("not used");
  }),
  commitLastMessage: vi.fn(async () => {
    throw new Error("not used");
  }),
  logStream: vi.fn(() => () => undefined),
  subscribe: vi.fn(() => () => undefined),
  ...overrides,
});

const renderWithApi = (ui: ReactNode, api: CbranchApi) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ApiProvider api={api}>{ui}</ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

const makeHunk = (): Hunk =>
  new Hunk({
    header: "@@ -1,3 +1,3 @@",
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [
      new DiffLine({ kind: "context", content: "ctx", oldLineNo: 1, newLineNo: 1 }),
      new DiffLine({ kind: "delete", content: "old line", oldLineNo: 2 }),
      new DiffLine({ kind: "add", content: "new line", newLineNo: 2 }),
    ],
  });

const makeDiffFile = (): DiffFile =>
  new DiffFile({
    oldPath: "a.txt",
    newPath: "a.txt",
    status: "modified",
    isBinary: false,
    additions: 1,
    deletions: 1,
    hunks: [makeHunk()],
  });

beforeEach(() => {
  useUiStore.setState({ selectedDiffFile: null });
});
afterEach(() => cleanup());

describe("WorkingDiffPanel", () => {
  test("shows placeholder when no file is selected", () => {
    renderWithApi(<WorkingDiffPanel repoId={repoId} />, makeFakeApi());
    expect(screen.getByText(/select a file/i)).toBeTruthy();
  });

  test("shows hunk header when diff loads", async () => {
    const api = makeFakeApi({ workingFileDiff: vi.fn(async () => makeDiffFile()) });
    act(() => {
      useUiStore.setState({ selectedDiffFile: { path: "a.txt", staged: false } });
    });
    renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
    expect(await screen.findByText("@@ -1,3 +1,3 @@")).toBeTruthy();
  });

  test("shows Stage Hunk button for worktree side (staged=false)", async () => {
    const api = makeFakeApi({ workingFileDiff: vi.fn(async () => makeDiffFile()) });
    act(() => {
      useUiStore.setState({ selectedDiffFile: { path: "a.txt", staged: false } });
    });
    renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
    expect(await screen.findByRole("button", { name: /stage hunk/i })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /discard hunk/i })).toBeTruthy();
  });

  test("shows Unstage Hunk button for staged side (staged=true)", async () => {
    const api = makeFakeApi({ workingFileDiff: vi.fn(async () => makeDiffFile()) });
    act(() => {
      useUiStore.setState({ selectedDiffFile: { path: "a.txt", staged: true } });
    });
    renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
    expect(await screen.findByRole("button", { name: /unstage hunk/i })).toBeTruthy();
  });

  test("Stage Hunk button calls stageHunks with correct PatchSelection", async () => {
    const stageHunksFn = vi.fn(async () => undefined);
    const api = makeFakeApi({
      workingFileDiff: vi.fn(async () => makeDiffFile()),
      stageHunks: stageHunksFn,
    });
    act(() => {
      useUiStore.setState({ selectedDiffFile: { path: "a.txt", staged: false } });
    });
    renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
    const btn = await screen.findByRole("button", { name: /stage hunk/i });
    await userEvent.click(btn);
    await waitFor(() => expect(stageHunksFn).toHaveBeenCalledTimes(1));
    const called = stageHunksFn.mock.calls[0][0] as PatchSelection;
    expect(called.path).toBe("a.txt");
    expect(called.hunks).toHaveLength(1);
    expect(called.hunks[0]).toBeInstanceOf(HunkSelection);
    expect(called.hunks[0].oldStart).toBe(1);
    expect(called.hunks[0].selectedLines).toHaveLength(0);
  });

  test("toggling to staged side calls setSelectedDiffFile with staged=true", async () => {
    const api = makeFakeApi({ workingFileDiff: vi.fn(async () => makeDiffFile()) });
    act(() => {
      useUiStore.setState({ selectedDiffFile: { path: "a.txt", staged: false } });
    });
    renderWithApi(<WorkingDiffPanel repoId={repoId} />, api);
    await screen.findByText("@@ -1,3 +1,3 @@");
    const stagedBtn = screen.getByRole("button", { name: /^staged$/i });
    await userEvent.click(stagedBtn);
    await waitFor(() => {
      const state = useUiStore.getState();
      expect(state.selectedDiffFile).toEqual({ path: "a.txt", staged: true });
    });
  });
});
