// @vitest-environment jsdom
import {
  CommitDetail,
  FileContent,
  Oid,
  RecentRepo,
  RepoHandle,
  RepoId,
  RepoState,
  Signature,
} from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { CommandPalette } from "./CommandPalette";
import { DetailsPanel } from "./DetailsPanel";
import { StatusSummary } from "./StatusSummary";

const repoId = RepoId.make("repo-1");
const oid = Oid.make("0123456789abcdef0123456789abcdef01234567");

const sig = (name: string) =>
  new Signature({ name, email: `${name}@example.test`, when: { epochSeconds: 1_700_000_000, tzOffsetMinutes: 0 } });

const repoState = new RepoState({
  isDetached: false,
  inProgress: "none",
  isBare: false,
  isEmpty: false,
  repoRoot: "/repos/demo",
  gitDir: "/repos/demo/.git",
  currentBranch: "main",
});

const makeFakeApi = (overrides: Partial<CbranchApi> = {}): CbranchApi => ({
  repoOpen: vi.fn(
    async (path: string) =>
      new RepoHandle({ repoId, root: path, gitDir: `${path}/.git`, commonDir: `${path}/.git`, state: repoState }),
  ),
  recentList: vi.fn(async () => [new RecentRepo({ path: "/repos/demo", name: "demo", repoId, lastOpenedAt: 1 })]),
  recentRemove: vi.fn(async () => undefined),
  repoState: vi.fn(async () => repoState),
  commitDetail: vi.fn(
    async () =>
      new CommitDetail({
        oid,
        parents: [],
        tree: oid,
        author: sig("Ada"),
        committer: sig("Ada"),
        subject: "first commit",
        body: "the body",
        messageRaw: "first commit -- the body",
        stats: { filesChanged: 1, additions: 1, deletions: 0 },
      }),
  ),
  commitDiff: vi.fn(async () => []),
  fileContentAtRev: vi.fn(
    async () => new FileContent({ path: "a.txt", size: 2, isBinary: false, encoding: "utf8", content: "a" }),
  ),
  logStream: vi.fn(() => () => undefined),
  subscribe: vi.fn(() => () => undefined),
  ...overrides,
});

const renderWithApi = (ui: ReactNode, api: CbranchApi) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  // jsdom lacks these; cmdk observes layout + scrolls the active item into view.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  useUiStore.setState({ activeRepoId: null, selectedOid: null, paletteOpen: false });
});
afterEach(() => cleanup());

describe("StatusSummary (NF-TEST-7)", () => {
  test("shows the current branch from repo.state", async () => {
    renderWithApi(<StatusSummary repoId={repoId} />, makeFakeApi());
    expect(await screen.findByText("main")).toBeTruthy();
  });
});

describe("DetailsPanel (NF-TEST-7)", () => {
  test("renders the selected commit's subject and author", async () => {
    renderWithApi(<DetailsPanel repoId={repoId} oid={oid} onSelectOid={() => undefined} />, makeFakeApi());
    expect(await screen.findByText("first commit")).toBeTruthy();
    // author/committer render as split text nodes; assert on the panel's text content.
    expect(document.body.textContent).toContain("Ada@example.test");
  });
});

describe("CommandPalette (NF-TEST-7 / P1-UI-OPEN-1)", () => {
  test("lists a recent repository and opens it on select", async () => {
    const api = makeFakeApi();
    useUiStore.setState({ paletteOpen: true });
    renderWithApi(<CommandPalette />, api);
    const item = await screen.findByText("demo");
    fireEvent.click(item);
    await waitFor(() => expect(api.repoOpen).toHaveBeenCalledWith("/repos/demo"));
  });
});
