// @vitest-environment jsdom
import {
  BranchInfo,
  BranchListing,
  Oid,
  RebasePlan,
  RebaseStatus,
  RebaseTodoCommit,
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
import { RebaseDialog } from "./RebaseDialog";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  }),
}));

const repoId = RepoId.make("rebase-repo");
const base = Oid.make("0".repeat(40));
const c1 = Oid.make("1".repeat(40));
const c2 = Oid.make("2".repeat(40));
const c3 = Oid.make("3".repeat(40));

const todo = (oid: Oid, subject: string, body = "") =>
  new RebaseTodoCommit({
    oid,
    authorName: "Ada",
    authorEmail: "ada@x.io",
    authorDate: "2023-11-14T22:13:20-05:00",
    subject,
    body,
  });

const plan = new RebasePlan({
  upstream: base,
  commits: [
    todo(c1, "first", "first body"),
    todo(c2, "second"),
    todo(c3, "third"),
  ],
});

const completed = new RebaseStatus({ inProgress: false, stopReason: "none" });

const branches = new BranchListing({
  localBranches: [
    new BranchInfo({
      name: "main",
      fullRef: "refs/heads/main",
      tipOid: base,
      tipSubject: "base",
      isCurrent: true,
      isRemote: false,
    }),
  ],
  remoteBranches: [],
  currentBranch: "main",
});

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    branchList: vi.fn(async () => branches),
    rebasePlan: vi.fn(async () => plan),
    rebaseStart: vi.fn(async () => completed),
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
        <RebaseDialog repoId={repoId} />
      </ApiProvider>
    </QueryClientProvider>,
  );
};

/** Set a row's action via its native select. */
const chooseAction = (shortOid: string, action: string) => {
  fireEvent.change(screen.getByLabelText(`Action for ${shortOid}`), {
    target: { value: action },
  });
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
  useUiStore.setState({ activeRepoId: repoId, rebaseDialog: null });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("RebaseDialog", () => {
  test("renders nothing when closed", () => {
    renderDialog(makeApi());
    expect(screen.queryByText("Interactive rebase")).toBeNull();
  });

  test("an empty base picker lists no commits and disables Start", async () => {
    renderDialog(makeApi());
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: null } });
    });
    expect(await screen.findByText("Interactive rebase")).toBeTruthy();
    expect(screen.getByText(/Choose a base above/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Start rebase",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("seeding an upstream fetches the plan and lists commits oldest-first as picks", async () => {
    const rebasePlan = vi.fn(async () => plan);
    renderDialog(makeApi({ rebasePlan }));
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });

    expect(await screen.findByText("first")).toBeTruthy();
    await waitFor(() => expect(rebasePlan).toHaveBeenCalledWith(repoId, base));
    // Oldest-first order: first, second, third.
    const subjects = screen
      .getAllByTitle(/first|second|third/)
      .map((el) => el.textContent);
    expect(subjects).toEqual(["first", "second", "third"]);
    expect(
      (
        screen.getByRole("button", {
          name: "Start rebase",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test("reordering rows submits steps in the displayed order", async () => {
    const rebaseStart = vi.fn(async () => completed);
    renderDialog(makeApi({ rebaseStart }));
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    // Move the first commit down: [first, second, third] → [second, first, third].
    fireEvent.click(screen.getByRole("button", { name: "Move 11111111 down" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start rebase" }));
    });

    await waitFor(() => expect(rebaseStart).toHaveBeenCalled());
    const [, upstreamArg, steps] = rebaseStart.mock.calls[0];
    expect(upstreamArg).toBe(base);
    expect(steps.map((s: { oid: string }) => s.oid)).toEqual([c2, c1, c3]);
    expect(steps.every((s: { action: string }) => s.action === "pick")).toBe(
      true,
    );
    // Completed → success toast + dialog closed.
    expect(useUiStore.getState().rebaseDialog).toBeNull();
  });

  test("reword opens the message editor seeded with the commit message", async () => {
    renderDialog(makeApi());
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    chooseAction("11111111", "reword");
    fireEvent.click(screen.getByRole("button", { name: "Message…" }));
    const textarea = (await screen.findByLabelText(
      "Commit message",
    )) as HTMLTextAreaElement;
    expect(textarea.value).toContain("first");
    expect(textarea.value).toContain("first body");
  });

  test("an empty reword message blocks Start with a validation alert", async () => {
    renderDialog(makeApi());
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    chooseAction("11111111", "reword");
    fireEvent.click(screen.getByRole("button", { name: "Message…" }));
    const textarea = await screen.findByLabelText("Commit message");
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save message" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/message/i),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Start rebase",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("a first-row squash is rejected with a validation alert", async () => {
    renderDialog(makeApi());
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    chooseAction("11111111", "squash");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /first commit can't be a squash/i,
      ),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Start rebase",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test("dropping every commit blocks Start", async () => {
    renderDialog(makeApi());
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    chooseAction("11111111", "drop");
    chooseAction("22222222", "drop");
    chooseAction("33333333", "drop");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/drops every/i),
    );
    const startBtn = screen.getByRole("button", {
      name: "Start rebase",
    }) as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
  });

  test("changing the replay target keeps the user's edited todo", async () => {
    const rebaseStart = vi.fn(async () => completed);
    renderDialog(makeApi({ rebaseStart }));
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    // Edit the plan, then change --onto: the edited order must survive (no re-seed).
    fireEvent.click(screen.getByRole("button", { name: "Move 11111111 down" }));
    fireEvent.click(screen.getByLabelText("Rebase onto a different base"));
    fireEvent.change(await screen.findByLabelText("New base"), {
      target: { value: "main" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start rebase" }));
    });

    await waitFor(() => expect(rebaseStart).toHaveBeenCalled());
    const [, , steps, opts] = rebaseStart.mock.calls[0];
    expect(steps.map((s: { oid: string }) => s.oid)).toEqual([c2, c1, c3]);
    expect(opts).toEqual({ onto: "main" });
  });

  test("a reword folded into a squash needs no reword message and shows one editor", async () => {
    renderDialog(makeApi());
    act(() => {
      useUiStore.setState({ rebaseDialog: { upstream: base } });
    });
    await screen.findByText("first");

    chooseAction("11111111", "reword"); // base of the group, absorbed by the squash
    chooseAction("22222222", "squash"); // the consumed (combined) message
    // Only the squash carries a message editor; the absorbed reword does not.
    expect(screen.getAllByRole("button", { name: "Message…" })).toHaveLength(1);
    // Start is NOT blocked despite the reword having no separate message.
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Start rebase",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });
});
