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

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { SubmodulesPanel } from "./SubmodulesPanel";

const repoId = RepoId.make("repo-1");

const upToDate = {
  path: "vendor/a",
  name: "vendor/a",
  absPath: "/repo/vendor/a",
  recordedOid: "a".repeat(40),
  checkedOutOid: "a".repeat(40),
  status: "upToDate",
  url: "https://x/a.git",
};
const uninit = {
  path: "vendor/b",
  name: "vendor/b",
  absPath: "/repo/vendor/b",
  recordedOid: "b".repeat(40),
  status: "uninitialized",
  url: "https://x/b.git",
};
const outOfSync = {
  path: "vendor/c",
  name: "vendor/c",
  absPath: "/repo/vendor/c",
  recordedOid: "c".repeat(40),
  checkedOutOid: "d".repeat(40),
  status: "outOfSync",
  url: "https://x/c.git",
};

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    submoduleList: vi.fn(async () => [upToDate, uninit, outOfSync]),
    submoduleUpdate: vi.fn(async () => undefined),
    submoduleSync: vi.fn(async () => undefined),
    submoduleAdd: vi.fn(async () => undefined),
    submoduleRemove: vi.fn(async () => undefined),
    repoOpen: vi.fn(async () => ({ repoId: RepoId.make("opened") })),
    recentList: vi.fn(async () => []),
    ...overrides,
  }) as unknown as CbranchApi;

const renderPanel = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <SubmodulesPanel repoId={repoId} />
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

/** The dropdown item element wrapping a label, for attribute assertions. */
const itemFor = (label: string): Element | null =>
  screen.getByText(label).closest('[data-slot="dropdown-menu-item"]');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SubmodulesPanel", () => {
  test("lists submodules with status badge and recorded/checked-out oids (SM-001)", async () => {
    renderPanel(makeFakeApi());

    expect(await screen.findByText("vendor/a")).toBeTruthy();
    expect(screen.getByText("vendor/b")).toBeTruthy();
    expect(screen.getByText("vendor/c")).toBeTruthy();
    // Status badges.
    expect(screen.getByText("up to date")).toBeTruthy();
    expect(screen.getByText("uninitialized")).toBeTruthy();
    expect(screen.getByText("out of sync")).toBeTruthy();
    // outOfSync shows recorded ≠ checked-out (short oids).
    expect(screen.getByText("ccccccc")).toBeTruthy();
    expect(screen.getByText("ddddddd")).toBeTruthy();
  });

  test("shows an empty state when there are no submodules", async () => {
    renderPanel(makeFakeApi({ submoduleList: vi.fn(async () => []) }));
    expect(await screen.findByText("No submodules.")).toBeTruthy();
  });

  test("an uninitialized submodule disables Sync and Open; Update passes init:true", async () => {
    const submoduleUpdate = vi.fn(async () => undefined);
    renderPanel(
      makeFakeApi({
        submoduleList: vi.fn(async () => [uninit]),
        submoduleUpdate,
      }),
    );

    await screen.findByText("vendor/b");
    act(() => fireEvent.click(screen.getByLabelText("Submodule actions")));

    expect(itemFor("Sync")?.hasAttribute("data-disabled")).toBe(true);
    expect(itemFor("Open")?.hasAttribute("data-disabled")).toBe(true);

    act(() => fireEvent.click(screen.getByText("Update")));
    await waitFor(() =>
      expect(submoduleUpdate).toHaveBeenCalledWith(repoId, {
        paths: ["vendor/b"],
        init: true,
        force: false,
      }),
    );
  });

  test("an initialized submodule enables Open, which opens it as a repo (SM-006)", async () => {
    const repoOpen = vi.fn(async () => ({ repoId: RepoId.make("opened") }));
    renderPanel(
      makeFakeApi({
        submoduleList: vi.fn(async () => [outOfSync]),
        repoOpen,
      }),
    );

    await screen.findByText("vendor/c");
    act(() => fireEvent.click(screen.getByLabelText("Submodule actions")));
    expect(itemFor("Open")?.hasAttribute("data-disabled")).toBe(false);

    act(() => fireEvent.click(screen.getByText("Open")));
    await waitFor(() =>
      expect(repoOpen).toHaveBeenCalledWith("/repo/vendor/c"),
    );
  });

  test("force update confirms first, then updates with force:true", async () => {
    const submoduleUpdate = vi.fn(async () => undefined);
    renderPanel(
      makeFakeApi({
        submoduleList: vi.fn(async () => [outOfSync]),
        submoduleUpdate,
      }),
    );

    await screen.findByText("vendor/c");
    act(() => fireEvent.click(screen.getByLabelText("Submodule actions")));
    act(() => fireEvent.click(screen.getByText("Force update…")));

    // A confirmation gates the destructive force update.
    expect(await screen.findByText("Force update submodule")).toBeTruthy();
    expect(submoduleUpdate).not.toHaveBeenCalled();

    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "Force update" })),
    );
    await waitFor(() =>
      expect(submoduleUpdate).toHaveBeenCalledWith(repoId, {
        paths: ["vendor/c"],
        init: false,
        force: true,
      }),
    );
  });

  test("removing a submodule confirms first, then calls submoduleRemove (SM-005)", async () => {
    const submoduleRemove = vi.fn(async () => undefined);
    renderPanel(
      makeFakeApi({
        submoduleList: vi.fn(async () => [upToDate]),
        submoduleRemove,
      }),
    );

    await screen.findByText("vendor/a");
    act(() => fireEvent.click(screen.getByLabelText("Submodule actions")));
    act(() => fireEvent.click(screen.getByText("Remove")));

    expect(await screen.findByText("Remove submodule")).toBeTruthy();
    expect(submoduleRemove).not.toHaveBeenCalled();

    act(() => fireEvent.click(screen.getByRole("button", { name: "Remove" })));
    await waitFor(() =>
      expect(submoduleRemove).toHaveBeenCalledWith(repoId, "vendor/a"),
    );
  });

  test("Add validates url + path, then calls submoduleAdd (SM-004)", async () => {
    const submoduleAdd = vi.fn(async () => undefined);
    renderPanel(makeFakeApi({ submoduleAdd }));

    await screen.findByText("vendor/a");
    act(() => fireEvent.click(screen.getByText("+ Add")));

    const urlInput = await screen.findByPlaceholderText(
      "https://example.com/lib.git",
    );
    // Add stays disabled until both url and path are present.
    const addBtn = screen.getByRole("button", { name: "Add" });
    expect(addBtn.hasAttribute("disabled")).toBe(true);

    act(() =>
      fireEvent.change(urlInput, { target: { value: "https://x/new.git" } }),
    );
    act(() =>
      fireEvent.change(screen.getByPlaceholderText("vendor/lib"), {
        target: { value: "vendor/new" },
      }),
    );
    act(() => fireEvent.click(screen.getByRole("button", { name: "Add" })));

    await waitFor(() =>
      expect(submoduleAdd).toHaveBeenCalledWith(
        repoId,
        "https://x/new.git",
        "vendor/new",
        undefined,
      ),
    );
  });

  test("bulk Update all / Sync all fire submoduleUpdate(init) / submoduleSync", async () => {
    const submoduleUpdate = vi.fn(async () => undefined);
    const submoduleSync = vi.fn(async () => undefined);
    renderPanel(makeFakeApi({ submoduleUpdate, submoduleSync }));

    await screen.findByText("vendor/a");
    act(() => fireEvent.click(screen.getByText("Update all")));
    await waitFor(() =>
      expect(submoduleUpdate).toHaveBeenCalledWith(repoId, { init: true }),
    );

    act(() => fireEvent.click(screen.getByText("Sync all")));
    await waitFor(() => expect(submoduleSync).toHaveBeenCalledWith(repoId, {}));
  });
});
