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
import { RemotesManagerDialog } from "./RemotesManagerDialog";

const repoId = RepoId.make("repo-1");

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    remoteList: vi.fn(async () => [
      { name: "origin", fetchUrl: "git@example:repo.git" },
    ]),
    remoteAdd: vi.fn(async () => undefined),
    remoteRename: vi.fn(async () => undefined),
    remoteSetUrl: vi.fn(async () => undefined),
    remoteRemove: vi.fn(async () => undefined),
    ...overrides,
  }) as unknown as CbranchApi;

const renderDialog = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <RemotesManagerDialog
            repoId={repoId}
            open={true}
            onOpenChange={() => undefined}
          />
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RemotesManagerDialog remove confirmation (UI-008)", () => {
  test("Remove requires a second confirming click", async () => {
    const remoteRemove = vi.fn(async () => undefined);
    renderDialog(makeFakeApi({ remoteRemove }));

    const removeBtn = await screen.findByText("Remove");
    act(() => fireEvent.click(removeBtn));
    // First click only arms the confirm — no mutation yet.
    expect(remoteRemove).not.toHaveBeenCalled();

    const confirmBtn = await screen.findByText("Confirm remove");
    act(() => fireEvent.click(confirmBtn));
    await waitFor(() =>
      expect(remoteRemove).toHaveBeenCalledWith(repoId, "origin"),
    );
  });

  test("Cancel aborts the pending remove", async () => {
    const remoteRemove = vi.fn(async () => undefined);
    renderDialog(makeFakeApi({ remoteRemove }));

    const removeBtn = await screen.findByText("Remove");
    act(() => fireEvent.click(removeBtn));
    const cancelBtn = await screen.findByText("Cancel");
    act(() => fireEvent.click(cancelBtn));
    // Back to the un-armed state and nothing removed.
    expect(await screen.findByText("Remove")).toBeTruthy();
    expect(screen.queryByText("Confirm remove")).toBeNull();
    expect(remoteRemove).not.toHaveBeenCalled();
  });
});
