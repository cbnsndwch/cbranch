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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { CommandPalette } from "./CommandPalette";

const repoId = RepoId.make("palette-repo");

const makeApi = (): CbranchApi =>
  ({
    recentList: vi.fn(async () => []),
    repoOpen: vi.fn(async () => ({ repoId })),
  }) as unknown as CbranchApi;

const renderPalette = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ApiProvider api={makeApi()}>
          <CommandPalette />
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
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
  useUiStore.setState({
    activeRepoId: null,
    paletteOpen: false,
    gcDialogOpen: false,
    settingsDialogOpen: false,
    activeView: "history",
  });
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("CommandPalette P5 commands (spec §Entry points / NF-A11Y-6)", () => {
  test("with an active repo, the wired primary commands are listed", async () => {
    act(() => {
      useUiStore.setState({ activeRepoId: repoId, paletteOpen: true });
    });
    renderPalette();
    for (const label of [
      "Reflog",
      "Bisect: start",
      "Export archive",
      "Clean working directory",
      "Run maintenance",
      "Submodules",
      "Settings",
    ]) {
      expect(await screen.findByText(label)).toBeTruthy();
    }
    // "Interactive rebase" (commands.rebase) is not wired until S8, so the palette
    // hides it (filtered by menuActions.isEnabled) rather than offering a silent no-op.
    expect(screen.queryByText("Interactive rebase")).toBeNull();
  });

  test("a command dispatches its menu id and closes the palette", async () => {
    act(() => {
      useUiStore.setState({ activeRepoId: repoId, paletteOpen: true });
    });
    renderPalette();
    fireEvent.click(await screen.findByText("Run maintenance"));
    await waitFor(() => {
      expect(useUiStore.getState().gcDialogOpen).toBe(true);
    });
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  test("Settings + Reflog route through the shared handler map", async () => {
    act(() => {
      useUiStore.setState({ activeRepoId: repoId, paletteOpen: true });
    });
    renderPalette();
    fireEvent.click(await screen.findByText("Reflog"));
    await waitFor(() => {
      expect(useUiStore.getState().activeView).toBe("reflog");
    });
  });

  test("with no active repo, the commands are hidden (switcher only)", () => {
    act(() => {
      useUiStore.setState({ activeRepoId: null, paletteOpen: true });
    });
    renderPalette();
    expect(screen.queryByText("Run maintenance")).toBeNull();
    expect(screen.queryByText("Interactive rebase")).toBeNull();
  });
});
