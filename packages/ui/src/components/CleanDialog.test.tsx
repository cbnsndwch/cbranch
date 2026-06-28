// @vitest-environment jsdom
import {
  CleanEntry,
  CleanPreview,
  CleanResult,
  RepoId,
} from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { CleanDialog } from "./CleanDialog";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const repoId = RepoId.make("clean-repo");

const previewOf = (...paths: Array<[string, boolean]>) =>
  new CleanPreview({
    entries: paths.map(
      ([path, isDirectory]) => new CleanEntry({ path, isDirectory }),
    ),
  });

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    cleanPreview: vi.fn(async () =>
      previewOf(["build.log", false], ["dist/", true]),
    ),
    clean: vi.fn(async () => new CleanResult({ removed: 2 })),
    recentList: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
    logStream: vi.fn(() => () => undefined),
    ...overrides,
  }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiProvider api={api}>
        <CleanDialog />
      </ApiProvider>
    </QueryClientProvider>,
  );
};

const openDialog = () =>
  act(() => {
    useUiStore.setState({ activeRepoId: repoId, cleanDialogOpen: true });
  });

const removeButton = () =>
  Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.startsWith("Remove "),
  );

beforeEach(() => {
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  useUiStore.setState({ activeRepoId: null, cleanDialogOpen: false });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("CleanDialog", () => {
  test("renders nothing when closed", () => {
    renderDialog(makeApi());
    expect(screen.queryByText("Clean working directory")).toBeNull();
  });

  test("opens with options + Preview, and Remove disabled before a preview", async () => {
    renderDialog(makeApi());
    openDialog();
    expect(await screen.findByText("Clean working directory")).toBeTruthy();
    expect(screen.getByLabelText("Untracked directories")).toBeTruthy();
    expect(screen.getByLabelText("Ignored files")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    expect(removeButton()?.disabled).toBe(true);
  });

  test("Preview lists would-remove entries and enables Remove with the count", async () => {
    const cleanPreview = vi.fn(async () =>
      previewOf(["build.log", false], ["dist/", true]),
    );
    renderDialog(makeApi({ cleanPreview }));
    openDialog();
    await screen.findByText("Clean working directory");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });

    await waitFor(() =>
      expect(cleanPreview).toHaveBeenCalledWith(repoId, false, false),
    );
    expect(await screen.findByText("build.log")).toBeTruthy();
    expect(screen.getByText("dist/")).toBeTruthy();
    await waitFor(() => expect(removeButton()?.disabled).toBe(false));
    expect(removeButton()?.textContent).toBe("Remove 2 entries");
  });

  test("changing an option after preview invalidates it (Remove re-disabled)", async () => {
    renderDialog(makeApi());
    openDialog();
    await screen.findByText("Clean working directory");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    await waitFor(() => expect(removeButton()?.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Ignored files"));
    });

    await waitFor(() => expect(removeButton()?.disabled).toBe(true));
    expect(screen.getByText(/Options changed/i)).toBeTruthy();
  });

  test("empty preview shows 'Nothing to clean' and keeps Remove disabled", async () => {
    renderDialog(makeApi({ cleanPreview: vi.fn(async () => previewOf()) }));
    openDialog();
    await screen.findByText("Clean working directory");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    expect(await screen.findByText("Nothing to clean.")).toBeTruthy();
    expect(removeButton()?.disabled).toBe(true);
  });

  test("Remove is confirmation-gated, then cleans the previewed paths and toasts", async () => {
    const clean = vi.fn(async () => new CleanResult({ removed: 2 }));
    renderDialog(makeApi({ clean }));
    openDialog();
    await screen.findByText("Clean working directory");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    await waitFor(() => expect(removeButton()?.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(removeButton()!);
    });
    // First action only opens the destructive confirmation — no clean yet.
    expect(clean).not.toHaveBeenCalled();
    const confirm = await screen.findByText("Delete 2");
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() =>
      expect(clean).toHaveBeenCalledWith(
        repoId,
        ["build.log", "dist/"],
        false,
        false,
      ),
    );
    expect(toast.success).toHaveBeenCalled();
  });
});
