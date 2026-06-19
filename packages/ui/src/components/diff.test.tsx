// @vitest-environment jsdom
import { CommitDetail, DiffFile, Oid, RepoId, Signature } from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { ChangedFileList } from "./ChangedFileList";
import { DiffPanel } from "./DiffPanel";

const repoId = RepoId.make("repo-1");
const oid = Oid.make("0123456789abcdef0123456789abcdef01234567");

const hunk = (header: string) => ({
  header,
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 2,
  lines: [
    { kind: "context" as const, content: "ctx" },
    { kind: "add" as const, content: "added line" },
  ],
});

const file = (over: Partial<DiffFile> & { newPath: string }): DiffFile =>
  new DiffFile({
    oldPath: over.oldPath ?? over.newPath,
    newPath: over.newPath,
    status: over.status ?? "modified",
    isBinary: over.isBinary ?? false,
    additions: over.additions ?? 1,
    deletions: over.deletions ?? 0,
    hunks: over.hunks ?? [hunk("@@ -1 +1,2 @@")],
    oldMode: over.oldMode,
    newMode: over.newMode,
  });

const sig = new Signature({ name: "Ada", email: "ada@x", when: { epochSeconds: 1, tzOffsetMinutes: 0 } });

const fakeApi = (files: ReadonlyArray<DiffFile>, parents: ReadonlyArray<Oid>): CbranchApi =>
  ({
    commitDiff: vi.fn(async () => files),
    commitDetail: vi.fn(
      async () =>
        new CommitDetail({
          oid,
          parents,
          tree: oid,
          author: sig,
          committer: sig,
          subject: "s",
          body: "",
          messageRaw: "s",
          stats: { filesChanged: files.length, additions: 1, deletions: 0 },
        }),
    ),
  }) as unknown as CbranchApi;

const renderWithApi = (ui: ReactNode, api: CbranchApi) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 400 });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => undefined;
  useUiStore.setState({ diffView: "inline" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetHeight;
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
});

describe("ChangedFileList (P1-UI-DIFF-1)", () => {
  test("shows totals and a status entry; selecting a file calls back", async () => {
    const onSelect = vi.fn();
    render(
      <ChangedFileList
        files={[file({ newPath: "src/a.ts", additions: 2, deletions: 1 })]}
        selectedPath={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText("1 file")).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    fireEvent.click(await screen.findByText("src/a.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });
});

describe("DiffPanel (P1-DIFF-*)", () => {
  test("renders the selected file's hunk and the layout controls", async () => {
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, fakeApi([file({ newPath: "a.ts" })], []));
    expect(await screen.findByText(/added line/)).toBeTruthy();
    expect(screen.getByLabelText("Side-by-side diff")).toBeTruthy();
  });

  test("a merge commit exposes the base/parent selector (P1-DET-3)", async () => {
    const p1 = Oid.make("1111111111111111111111111111111111111111");
    const p2 = Oid.make("2222222222222222222222222222222222222222");
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, fakeApi([file({ newPath: "a.ts" })], [p1, p2]));
    expect(await screen.findByLabelText("Diff base")).toBeTruthy();
    expect(screen.getByText("combined")).toBeTruthy();
  });

  test("submodule entries render as a placeholder, not text (P1-DIFF-10)", async () => {
    const api = fakeApi([file({ newPath: "vendor/lib", newMode: "160000", hunks: [] })], []);
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, api);
    expect(await screen.findByText(/Submodule/)).toBeTruthy();
  });
});
