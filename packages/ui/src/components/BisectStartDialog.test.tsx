// @vitest-environment jsdom
import {
  BisectStatus,
  CommitSummary,
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { BisectStartDialog } from "./BisectStartDialog";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const repoId = RepoId.make("bisect-start-repo");
const bad = Oid.make("a".repeat(40));
const mid = Oid.make("c".repeat(40));

const started = new BisectStatus({
  state: "bisecting",
  current: new CommitSummary({
    oid: mid,
    parents: [],
    authorName: "A",
    authorEmail: "a@x",
    authorDate: "2023-11-14T22:13:20-05:00",
    committerDate: "2023-11-14T22:13:20-05:00",
    subject: "midpoint",
    refs: [],
  }),
  badTerm: "bad",
  goodTerm: "good",
});

const onSelectOid = vi.fn();

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    bisectStart: vi.fn(async () => started),
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
        <BisectStartDialog repoId={repoId} onSelectOid={onSelectOid} />
      </ApiProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  useUiStore.setState({ activeRepoId: repoId, bisectStartDialog: null });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("BisectStartDialog", () => {
  test("renders nothing when closed", () => {
    renderDialog(makeApi());
    expect(screen.queryByText("Start bisect")).toBeNull();
  });

  test("opens pre-seeded with the bad commit and starts, then navigates", async () => {
    const bisectStart = vi.fn(async () => started);
    renderDialog(makeApi({ bisectStart }));
    act(() => {
      useUiStore.setState({ bisectStartDialog: { bad } });
    });

    expect(await screen.findByText("Start bisect")).toBeTruthy();
    expect(
      (screen.getByLabelText("Known bad commit") as HTMLInputElement).value,
    ).toBe(bad);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
    });

    await waitFor(() =>
      expect(bisectStart).toHaveBeenCalledWith(
        repoId,
        expect.objectContaining({ bad }),
      ),
    );
    await waitFor(() => expect(onSelectOid).toHaveBeenCalledWith(mid));
    // Closed after a successful start.
    expect(useUiStore.getState().bisectStartDialog).toBeNull();
  });
});
