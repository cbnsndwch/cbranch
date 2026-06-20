// @vitest-environment jsdom
import {
  CommitCreated,
  CommitMessage,
  Oid,
  RepoId,
  StatusEntry,
  WorkingTreeStatus,
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
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { CommitPanel } from "./CommitPanel";

const repoId = RepoId.make("test-repo");
const oid = Oid.make("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

const stagedEntry = new StatusEntry({
  path: "file.ts",
  staged: "modified",
  unstaged: "unmodified",
  isConflicted: false,
  isUntracked: false,
  isIgnored: false,
  isSubmodule: false,
});

const makeStatus = (entries: StatusEntry[] = []): WorkingTreeStatus =>
  new WorkingTreeStatus({ entries, hasConflicts: false });

const makeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi => ({
  repoOpen: vi.fn(async () => {
    throw new Error("noop");
  }),
  recentList: vi.fn(async () => []),
  recentRemove: vi.fn(async () => undefined),
  repoState: vi.fn(async () => {
    throw new Error("noop");
  }),
  commitDetail: vi.fn(async () => {
    throw new Error("noop");
  }),
  commitDiff: vi.fn(async () => []),
  workingFileDiff: vi.fn(async () => {
    throw new Error("noop");
  }),
  fileContentAtRev: vi.fn(async () => {
    throw new Error("noop");
  }),
  statusGet: vi.fn(async () => makeStatus()),
  stageFiles: vi.fn(async () => undefined),
  unstageFiles: vi.fn(async () => undefined),
  discardFiles: vi.fn(async () => undefined),
  deleteUntracked: vi.fn(async () => undefined),
  resetTo: vi.fn(async () => undefined),
  stageHunks: vi.fn(async () => undefined),
  unstageHunks: vi.fn(async () => undefined),
  discardHunks: vi.fn(async () => undefined),
  commitCreate: vi.fn(
    async () =>
      new CommitCreated({ oid, shortOid: "aaaaaaa", subject: "test" }),
  ),
  commitLastMessage: vi.fn(async () => {
    throw new Error("noop");
  }),
  logStream: vi.fn(() => () => undefined),
  subscribe: vi.fn(() => () => undefined),
  ...overrides,
});

const renderPanel = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ApiProvider api={api}>
          <CommitPanel repoId={repoId} />
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
    commitDraft: { subject: "", body: "", amend: false, signoff: false },
    activeRepoId: null,
  });
});
afterEach(() => cleanup());

describe("CommitPanel", () => {
  test("Commit button is disabled when no staged changes", async () => {
    const api = makeApi({ statusGet: vi.fn(async () => makeStatus([])) });
    renderPanel(api);
    await waitFor(() => expect(api.statusGet).toHaveBeenCalled());
    // set a non-empty subject
    const subjectInput = screen.getByLabelText("Commit subject");
    await act(async () => {
      fireEvent.change(subjectInput, { target: { value: "my commit" } });
    });
    // The commit button (not "Reuse Last Message") should be disabled
    const commitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Commit",
    );
    expect(commitBtn).toBeDefined();
    expect(commitBtn?.disabled).toBe(true);
  });

  test("Commit button is disabled when subject is empty", async () => {
    const api = makeApi({
      statusGet: vi.fn(async () => makeStatus([stagedEntry])),
    });
    renderPanel(api);
    await waitFor(() => expect(api.statusGet).toHaveBeenCalled());
    // subject is empty (default)
    const commitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Commit",
    );
    expect(commitBtn?.disabled).toBe(true);
  });

  test("Commit button is enabled when staged changes present and subject non-empty", async () => {
    const api = makeApi({
      statusGet: vi.fn(async () => makeStatus([stagedEntry])),
    });
    renderPanel(api);
    await waitFor(() => expect(api.statusGet).toHaveBeenCalled());
    const subjectInput = screen.getByLabelText("Commit subject");
    await act(async () => {
      fireEvent.change(subjectInput, { target: { value: "my commit" } });
    });
    const commitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Commit",
    );
    expect(commitBtn?.disabled).toBe(false);
  });

  test("clicking Commit calls commitCreate with correct input", async () => {
    const api = makeApi({
      statusGet: vi.fn(async () => makeStatus([stagedEntry])),
    });
    renderPanel(api);
    await waitFor(() => expect(api.statusGet).toHaveBeenCalled());
    const subjectInput = screen.getByLabelText("Commit subject");
    await act(async () => {
      fireEvent.change(subjectInput, { target: { value: "add feature" } });
    });
    const commitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Commit",
    );
    await act(async () => {
      fireEvent.click(commitBtn!);
    });
    await waitFor(() =>
      expect(api.commitCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          repoId,
          subject: "add feature",
          amend: false,
          signoff: false,
        }),
      ),
    );
  });

  test("Reuse Last Message fills the subject from last commit", async () => {
    const msg = new CommitMessage({
      subject: "prev subject",
      body: "prev body",
      raw: "prev subject\n\nprev body",
    });
    const api = makeApi({
      statusGet: vi.fn(async () => makeStatus([stagedEntry])),
      commitLastMessage: vi.fn(async () => msg),
    });
    renderPanel(api);
    // Wait for the button to become enabled (data loaded)
    const reuseBtn = await waitFor(() => {
      const btn = screen.getByRole("button", { name: /reuse last message/i });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      return btn;
    });
    await act(async () => {
      fireEvent.click(reuseBtn);
    });
    await waitFor(() => {
      const subjectInput = screen.getByLabelText(
        "Commit subject",
      ) as HTMLInputElement;
      expect(subjectInput.value).toBe("prev subject");
    });
  });

  test("amend commit passes amend flag to commitCreate", async () => {
    const api = makeApi({ statusGet: vi.fn(async () => makeStatus([])) });
    renderPanel(api);
    await waitFor(() => expect(api.statusGet).toHaveBeenCalled());
    // Set subject
    const subjectInput = screen.getByLabelText("Commit subject");
    await act(async () => {
      fireEvent.change(subjectInput, { target: { value: "amended" } });
    });
    // Toggle amend switch (click the Switch)
    const amendSwitch = screen.getByLabelText("Amend");
    await act(async () => {
      fireEvent.click(amendSwitch);
    });
    // With amend=true, commit should be enabled even with no staged changes
    const commitBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Commit",
    );
    // Click commit
    await act(async () => {
      fireEvent.click(commitBtn!);
    });
    await waitFor(() =>
      expect(api.commitCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amend: true }),
      ),
    );
  });

  test("shows 72-char limit warning when subject exceeds limit", async () => {
    const api = makeApi({ statusGet: vi.fn(async () => makeStatus([])) });
    renderPanel(api);
    const subjectInput = screen.getByLabelText("Commit subject");
    const longSubject = "a".repeat(73);
    await act(async () => {
      fireEvent.change(subjectInput, { target: { value: longSubject } });
    });
    expect(screen.getByText("73/72")).toBeTruthy();
  });
});
