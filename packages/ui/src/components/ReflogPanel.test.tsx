// @vitest-environment jsdom
import { BranchInfo, BranchListing, Oid, RepoId } from "@cbranch/rpc-contract";
import { ReflogEntry, ReflogPage } from "@cbranch/rpc-contract";
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

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { ReflogPanel } from "./ReflogPanel";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const repoId = RepoId.make("reflog-repo");
const oid = Oid.make("a".repeat(40));

const page = new ReflogPage({
  entries: [
    new ReflogEntry({
      selector: "HEAD@{0}",
      oid,
      action: "commit",
      message: "init",
    }),
  ],
});

const branchListing = new BranchListing({
  localBranches: [
    new BranchInfo({
      name: "main",
      fullRef: "refs/heads/main",
      tipOid: oid,
      tipSubject: "init",
      isCurrent: true,
      isRemote: false,
    }),
  ],
  remoteBranches: [],
  currentBranch: "main",
});

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    reflogList: vi.fn(async () => page),
    branchList: vi.fn(async () => branchListing),
    branchCreate: vi.fn(async () => branchListing.localBranches[0]),
    resetTo: vi.fn(async () => undefined),
    recentList: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
    logStream: vi.fn(() => () => undefined),
    ...overrides,
  }) as unknown as CbranchApi;

const onSelectOid = vi.fn();

const renderPanel = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiProvider api={api}>
        <ReflogPanel repoId={repoId} onSelectOid={onSelectOid} />
      </ApiProvider>
    </QueryClientProvider>,
  );
};

const openRowMenu = () =>
  act(() => fireEvent.click(screen.getByLabelText("Actions for HEAD@{0}")));

beforeEach(() => {
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("ReflogPanel", () => {
  test("lists entries (selector, action, message) for HEAD by default", async () => {
    const reflogList = vi.fn(async () => page);
    renderPanel(makeApi({ reflogList }));
    expect(await screen.findByText("HEAD@{0}")).toBeTruthy();
    expect(screen.getByText("commit")).toBeTruthy();
    expect(screen.getByText("init")).toBeTruthy();
    await waitFor(() =>
      expect(reflogList).toHaveBeenCalledWith(
        repoId,
        expect.objectContaining({ ref: "HEAD" }),
      ),
    );
  });

  test("clicking the short hash navigates to the commit (read-only)", async () => {
    renderPanel(makeApi());
    const hash = await screen.findByText(oid.slice(0, 8));
    act(() => fireEvent.click(hash));
    expect(onSelectOid).toHaveBeenCalledWith(oid);
  });

  test("Create branch here uses the entry's resolved oid as the start point", async () => {
    const branchCreate = vi.fn(async () => branchListing.localBranches[0]);
    renderPanel(makeApi({ branchCreate }));
    await screen.findByText("HEAD@{0}");
    openRowMenu();
    act(() => fireEvent.click(screen.getByText("Create branch here…")));
    const input = await screen.findByLabelText("Branch name");
    act(() => fireEvent.change(input, { target: { value: "recovered" } }));
    act(() => fireEvent.click(screen.getByRole("button", { name: "Create" })));

    await waitFor(() =>
      expect(branchCreate).toHaveBeenCalledWith(
        repoId,
        "recovered",
        oid,
        undefined,
        false,
      ),
    );
  });

  test("soft reset proceeds directly; hard reset is confirmation-gated", async () => {
    const resetTo = vi.fn(async () => undefined);
    renderPanel(makeApi({ resetTo }));
    await screen.findByText("HEAD@{0}");

    openRowMenu();
    act(() => fireEvent.click(screen.getByText("Reset (soft) to here")));
    await waitFor(() =>
      expect(resetTo).toHaveBeenCalledWith(repoId, "soft", oid),
    );

    openRowMenu();
    act(() => fireEvent.click(screen.getByText("Reset (hard) to here…")));
    // First action only opens the destructive confirmation.
    expect(resetTo).toHaveBeenCalledTimes(1);
    const confirm = await screen.findByText("Hard reset");
    act(() => fireEvent.click(confirm));
    await waitFor(() =>
      expect(resetTo).toHaveBeenCalledWith(repoId, "hard", oid),
    );
  });
});
