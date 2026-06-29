// @vitest-environment jsdom
import { RepoId } from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { ConflictsPanel } from "./ConflictsPanel";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

const repoId = RepoId.make("repo-1");

const file = (over: Record<string, unknown>) => ({
  path: "x",
  classification: "bothModified",
  hasBase: true,
  hasOurs: true,
  hasTheirs: true,
  isBinary: false,
  isSubmodule: false,
  ...over,
});

const bothModified = file({ path: "a.txt" });
const bothAdded = file({
  path: "b.txt",
  classification: "bothAdded",
  hasBase: false,
});
const deletedByThem = file({
  path: "c.txt",
  classification: "deletedByThem",
  hasTheirs: false,
});
const binary = file({ path: "d.bin", isBinary: true });

const listing = (
  conflicted: unknown[],
  over: Record<string, unknown> = {},
) => ({
  operation: "merge",
  conflicted,
  conflictedCount: conflicted.length,
  canContinue: false,
  canSkip: false,
  ...over,
});

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    conflictList: vi.fn(async () => listing([bothModified])),
    conflictResolve: vi.fn(async () => undefined),
    opContinue: vi.fn(async () => ({
      outcome: "completed",
      operation: "merge",
      committed: 1,
    })),
    opAbort: vi.fn(async () => undefined),
    opSkip: vi.fn(async () => ({
      outcome: "completed",
      operation: "rebase",
      committed: 0,
    })),
    rebaseStatus: vi.fn(async () => ({
      inProgress: true,
      stopReason: "conflict",
    })),
    ...overrides,
  }) as unknown as CbranchApi;

const renderPanel = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <ConflictsPanel repoId={repoId} />
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

const openRow = async (path: string) => {
  await screen.findByText(path);
  act(() => fireEvent.click(screen.getByLabelText("Resolve conflict")));
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConflictsPanel", () => {
  test("lists conflicted files with classification badges (AC-6)", async () => {
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () => listing([bothModified, deletedByThem])),
      }),
    );
    expect(await screen.findByText("a.txt")).toBeTruthy();
    expect(screen.getByText("c.txt")).toBeTruthy();
    expect(screen.getByText("both modified")).toBeTruthy();
    expect(screen.getByText("deleted by them")).toBeTruthy();
  });

  test("Continue is disabled while a path is conflicted, enabled at zero (AC-8)", async () => {
    renderPanel(makeFakeApi());
    const cont = (await screen.findByText("Continue")) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    cleanup();

    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () => listing([], { canContinue: true })),
      }),
    );
    const cont2 = (await screen.findByText("Continue")) as HTMLButtonElement;
    expect(cont2.disabled).toBe(false);
  });

  test("Take base does not resolve when stage 1 is absent (REQ-UX-004)", async () => {
    const conflictResolve = vi.fn(async () => undefined);
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () => listing([bothAdded])),
        conflictResolve,
      }),
    );
    await openRow("b.txt");
    const takeBase = await screen.findByText("Take base");
    act(() => fireEvent.click(takeBase));
    expect(conflictResolve).not.toHaveBeenCalled();
  });

  test("delete/modify offers Keep file / Delete file, not ours/theirs", async () => {
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () => listing([deletedByThem])),
      }),
    );
    await openRow("c.txt");
    expect(await screen.findByText("Keep file")).toBeTruthy();
    expect(screen.getByText("Delete file")).toBeTruthy();
    expect(screen.queryByText("Take ours")).toBeNull();
  });

  test("a binary conflict hides Edit and explains why (REQ-MERGE-020)", async () => {
    renderPanel(
      makeFakeApi({ conflictList: vi.fn(async () => listing([binary])) }),
    );
    await screen.findByText("d.bin");
    expect(screen.getByText(/can't be merged line-by-line/)).toBeTruthy();
    await openRow("d.bin");
    expect(await screen.findByText("Take ours")).toBeTruthy();
    expect(screen.queryByText("Edit…")).toBeNull();
  });

  test("Delete file is gated by a confirmation dialog (REQ-UX-085)", async () => {
    const conflictResolve = vi.fn(async () => undefined);
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () => listing([deletedByThem])),
        conflictResolve,
      }),
    );
    await openRow("c.txt");
    act(() => fireEvent.click(screen.getByText("Delete file")));
    expect(
      await screen.findByText(/will be removed from the working tree/),
    ).toBeTruthy();
    expect(conflictResolve).not.toHaveBeenCalled();

    const confirms = screen.getAllByRole("button", { name: "Delete file" });
    act(() => fireEvent.click(confirms[confirms.length - 1]!));
    await waitFor(() =>
      expect(conflictResolve).toHaveBeenCalledWith(
        repoId,
        ["c.txt"],
        "deleteFile",
      ),
    );
  });

  test("Abort is gated by a confirmation dialog (AC-9)", async () => {
    const opAbort = vi.fn(async () => undefined);
    renderPanel(makeFakeApi({ opAbort }));
    const abortBtn = await screen.findByText("Abort");
    act(() => fireEvent.click(abortBtn));
    expect(await screen.findByText("Abort merge")).toBeTruthy();
    expect(opAbort).not.toHaveBeenCalled();

    const confirms = screen.getAllByRole("button", { name: "Abort" });
    act(() => fireEvent.click(confirms[confirms.length - 1]!));
    await waitFor(() => expect(opAbort).toHaveBeenCalledWith(repoId));
  });

  test("the banner is hidden when no operation is in progress", async () => {
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () =>
          listing([], { operation: "none", canContinue: false }),
        ),
      }),
    );
    await screen.findByText("No conflicted files.");
    expect(screen.queryByText("Continue")).toBeNull();
  });

  test("Skip shows only for rebase, with progress (AC-10)", async () => {
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () =>
          listing([bothModified], {
            operation: "rebase",
            canSkip: true,
            progress: { current: 2, total: 5 },
          }),
        ),
      }),
    );
    expect(await screen.findByText("Skip")).toBeTruthy();
    expect(screen.getByText(/step 2 of 5/)).toBeTruthy();
    cleanup();

    renderPanel(makeFakeApi());
    await screen.findByText("Continue");
    expect(screen.queryByText("Skip")).toBeNull();
  });

  test("a rebase edit stop shows the stop-reason copy and no message box", async () => {
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () =>
          listing([], {
            operation: "rebase",
            canContinue: true,
            canSkip: true,
            progress: { current: 3, total: 4 },
          }),
        ),
        rebaseStatus: vi.fn(async () => ({
          inProgress: true,
          stopReason: "edit",
        })),
      }),
    );
    expect(await screen.findByText(/Stopped to edit this commit/)).toBeTruthy();
    // Rebase bakes reword/squash messages into the todo — no commit-message box.
    expect(screen.queryByLabelText("Commit message")).toBeNull();
    const cont = screen.getByText("Continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
  });

  test("Continue stays disabled for a rebase until the stop reason loads", async () => {
    renderPanel(
      makeFakeApi({
        // A conflict-free rebase stop (canContinue true) where the reason hasn't loaded.
        conflictList: vi.fn(async () =>
          listing([], {
            operation: "rebase",
            canContinue: true,
            canSkip: true,
            progress: { current: 1, total: 2 },
          }),
        ),
        rebaseStatus: vi.fn(() => new Promise<never>(() => {})), // never resolves
      }),
    );
    const cont = (await screen.findByText("Continue")) as HTMLButtonElement;
    expect(cont.disabled).toBe(true); // no premature Continue before the reason is known
  });

  test("an execFailed rebase stop disables Continue and alerts to abort", async () => {
    renderPanel(
      makeFakeApi({
        conflictList: vi.fn(async () =>
          listing([], {
            operation: "rebase",
            canContinue: true,
            canSkip: true,
            progress: { current: 2, total: 3 },
          }),
        ),
        rebaseStatus: vi.fn(async () => ({
          inProgress: true,
          stopReason: "execFailed",
        })),
      }),
    );
    expect(
      await screen.findByText(/A scripted rebase step failed/),
    ).toBeTruthy();
    const cont = screen.getByText("Continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(screen.getByText("Abort")).toBeTruthy();
  });

  test("a failed resolution surfaces an error toast (REQ-UX-011)", async () => {
    renderPanel(
      makeFakeApi({
        conflictResolve: vi.fn(async () => {
          throw new Error("local changes would be overwritten");
        }),
      }),
    );
    await openRow("a.txt");
    const takeOurs = await screen.findByText("Take ours");
    act(() => fireEvent.click(takeOurs));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
