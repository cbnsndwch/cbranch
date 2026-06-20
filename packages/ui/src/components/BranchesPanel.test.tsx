// @vitest-environment jsdom
import {
  BranchInfo,
  BranchListing,
  BranchUpstream,
  Oid,
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
import { type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { BranchesPanel } from "./BranchesPanel";

const repoId = RepoId.make("repo-1");
const oid = (hex: string) => Oid.make(hex.padEnd(40, "0"));

const makeBranch = (overrides: Partial<BranchInfo>): BranchInfo =>
  new BranchInfo({
    name: "main",
    fullRef: "refs/heads/main",
    tipOid: oid("a"),
    tipSubject: "tip",
    isCurrent: false,
    isRemote: false,
    ...overrides,
  });

const listing = new BranchListing({
  localBranches: [
    makeBranch({
      name: "main",
      fullRef: "refs/heads/main",
      isCurrent: true,
      upstream: new BranchUpstream({
        ref: "refs/remotes/origin/main",
        name: "origin/main",
        ahead: 2,
        behind: 1,
      }),
    }),
    makeBranch({ name: "feature", fullRef: "refs/heads/feature" }),
  ],
  remoteBranches: [
    makeBranch({
      name: "origin/main",
      fullRef: "refs/remotes/origin/main",
      isRemote: true,
      remoteName: "origin",
    }),
  ],
  currentBranch: "main",
});

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    branchList: vi.fn(async () => listing),
    remoteList: vi.fn(async () => [
      { name: "origin", fetchUrl: "git@example:repo.git" },
    ]),
    branchCreate: vi.fn(async () => listing.localBranches[0]),
    branchSwitch: vi.fn(async () => undefined),
    branchRename: vi.fn(async () => undefined),
    branchDelete: vi.fn(async () => undefined),
    branchSetUpstream: vi.fn(async () => undefined),
    branchCheckoutDetached: vi.fn(async () => undefined),
    mergeCreate: vi.fn(async () => ({ mode: "fastForward" })),
    pushDeleteRemoteRef: vi.fn(async () => undefined),
    pushStream: vi.fn(() => () => undefined),
    pullStream: vi.fn(() => () => undefined),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  }) as unknown as CbranchApi;

const renderPanel = (
  api: CbranchApi,
  ui: ReactNode = <BranchesPanel repoId={repoId} />,
) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>{ui}</ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  // @tanstack/react-virtual measures the scroll element; jsdom has no layout, so
  // give it a ResizeObserver + a non-zero viewport for a window of rows to render.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(element: Element) {
        this.cb(
          [{ target: element } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    };
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => undefined;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 400,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetHeight;
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
});

describe("BranchesPanel (UI-001/002/004)", () => {
  test("renders local and remote groups with counts", async () => {
    renderPanel(makeFakeApi());
    expect(await screen.findByText("Local (2)")).toBeTruthy();
    expect(await screen.findByText("Remote (1)")).toBeTruthy();
    expect(await screen.findByText("feature")).toBeTruthy();
  });

  test("shows ahead/behind divergence and the upstream label", async () => {
    renderPanel(makeFakeApi());
    // Upstream label rendered on the tracking branch (title is unique to it).
    expect(await screen.findByTitle("Tracking origin/main")).toBeTruthy();
    // Directional ahead/behind indicators.
    expect(await screen.findByText("↑2")).toBeTruthy();
    expect(await screen.findByText("↓1")).toBeTruthy();
  });

  test("collapsing the Local group hides its branches", async () => {
    renderPanel(makeFakeApi());
    const header = await screen.findByText("Local (2)");
    expect(await screen.findByText("feature")).toBeTruthy();
    act(() => fireEvent.click(header));
    await waitFor(() => expect(screen.queryByText("feature")).toBeNull());
  });

  test("row menu surfaces the new branch actions", async () => {
    renderPanel(makeFakeApi());
    await screen.findByText("feature");
    const triggers = screen.getAllByLabelText("Branch actions");
    // [main, feature, origin/main] — open the non-current local row.
    act(() => fireEvent.click(triggers[1]!));
    expect(await screen.findByText("Create branch from here")).toBeTruthy();
    expect(await screen.findByText("Merge into current")).toBeTruthy();
    expect(await screen.findByText("Set / change upstream")).toBeTruthy();
    expect(await screen.findByText("Push")).toBeTruthy();
  });

  test("discard switch path requires a second explicit confirmation", async () => {
    const branchSwitch = vi
      .fn()
      .mockRejectedValueOnce(new Error("dirtyWorkingTree"))
      .mockResolvedValue(undefined);
    renderPanel(makeFakeApi({ branchSwitch }));
    await screen.findByText("feature");
    const triggers = screen.getAllByLabelText("Branch actions");
    act(() => fireEvent.click(triggers[1]!));
    const switchItem = await screen.findByText("Switch to");
    act(() => fireEvent.click(switchItem));

    // First gate: the uncommitted-changes strategy dialog.
    expect(await screen.findByText("Uncommitted changes")).toBeTruthy();
    act(() => fireEvent.click(screen.getByText("Discard")));

    // Second gate: an explicit destructive confirmation before discarding.
    expect(await screen.findByText("Discard local changes?")).toBeTruthy();
    act(() => fireEvent.click(screen.getByText("Discard and switch")));

    await waitFor(() =>
      expect(branchSwitch).toHaveBeenCalledWith(
        repoId,
        "feature",
        "discard",
        undefined,
      ),
    );
  });
});
