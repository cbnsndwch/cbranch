// @vitest-environment jsdom
import {
  CommitDetail,
  DiffFile,
  Oid,
  RepoId,
  Signature,
} from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { ChangedFileList } from "./ChangedFileList";
import { DiffPanel } from "./DiffPanel";

// Keep Shiki out of the unit tests: react-diff-view still renders the patch plainly, the
// on-demand highlighter resolves to no tokens (offline, deterministic).
vi.mock("../lib/shiki-highlighter", () => ({
  languageForPath: () => "typescript",
  loadShikiRefractor: async () => null,
}));

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

const sig = new Signature({
  name: "Ada",
  email: "ada@x",
  when: { epochSeconds: 1, tzOffsetMinutes: 0 },
});

const fakeApi = (
  files: ReadonlyArray<DiffFile>,
  parents: ReadonlyArray<Oid>,
): CbranchApi =>
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
          stats: {
            filesChanged: files.length,
            additions: 1,
            deletions: 0,
          },
        }),
    ),
  }) as unknown as CbranchApi;

const renderWithApi = (ui: ReactNode, api: CbranchApi) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 400,
  });
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = () => undefined;
  useUiStore.setState({ diffView: "inline", blameTarget: null });
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

  test("a file row's … menu blames that file (REQ-UX-012)", async () => {
    const onBlame = vi.fn();
    render(
      <ChangedFileList
        files={[file({ newPath: "src/a.ts" })]}
        selectedPath={null}
        onSelect={vi.fn()}
        onBlame={onBlame}
      />,
    );
    fireEvent.click(await screen.findByLabelText("Actions for src/a.ts"));
    fireEvent.click(await screen.findByText("Blame"));
    expect(onBlame).toHaveBeenCalledWith("src/a.ts");
  });
});

describe("DiffPanel (P1-DIFF-*)", () => {
  test("renders the selected file's hunk and the layout controls", async () => {
    renderWithApi(
      <DiffPanel repoId={repoId} oid={oid} />,
      fakeApi([file({ newPath: "a.ts" })], []),
    );
    expect(await screen.findByText(/added line/)).toBeTruthy();
    expect(screen.getByLabelText("Side-by-side diff")).toBeTruthy();
  });

  test("a merge commit exposes the base/parent selector (P1-DET-3)", async () => {
    const p1 = Oid.make("1111111111111111111111111111111111111111");
    const p2 = Oid.make("2222222222222222222222222222222222222222");
    renderWithApi(
      <DiffPanel repoId={repoId} oid={oid} />,
      fakeApi([file({ newPath: "a.ts" })], [p1, p2]),
    );
    expect(await screen.findByLabelText("Diff base")).toBeTruthy();
    expect(screen.getByText("combined")).toBeTruthy();
  });

  test("submodule entries render as a placeholder, not text (P1-DIFF-10)", async () => {
    const api = fakeApi(
      [file({ newPath: "vendor/lib", newMode: "160000", hunks: [] })],
      [],
    );
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, api);
    expect(await screen.findByText(/Submodule/)).toBeTruthy();
  });

  test("binary changes render the binary card (P1-DIFF-8)", async () => {
    const api = fakeApi(
      [file({ newPath: "logo.png", isBinary: true, hunks: [] })],
      [],
    );
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, api);
    expect(await screen.findByText("Binary file")).toBeTruthy();
  });

  test("large diffs are deferred behind Load anyway (P1-DIFF-9)", async () => {
    const big = file({
      newPath: "big.ts",
      additions: 3000,
      deletions: 100,
    });
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, fakeApi([big], []));
    expect(await screen.findByText("Large diff deferred")).toBeTruthy();
    fireEvent.click(screen.getByText("Load anyway"));
    expect(await screen.findByText(/added line/)).toBeTruthy();
  });

  test("the toolbar Blame button blames the active file at the commit (REQ-UX-012)", async () => {
    renderWithApi(
      <DiffPanel repoId={repoId} oid={oid} />,
      fakeApi([file({ newPath: "a.ts" })], []),
    );
    await screen.findByText(/added line/);
    fireEvent.click(screen.getByText("Blame"));
    expect(useUiStore.getState().blameTarget).toEqual({
      rev: oid,
      path: "a.ts",
    });
  });

  test("the layout toggle switches react-diff-view between unified and split", async () => {
    const { container } = renderWithApi(
      <DiffPanel repoId={repoId} oid={oid} />,
      fakeApi([file({ newPath: "a.ts" })], []),
    );
    expect(await screen.findByText(/added line/)).toBeTruthy();
    expect(container.querySelector(".diff-unified")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Side-by-side diff"));
    expect(await screen.findByText(/added line/)).toBeTruthy();
    expect(container.querySelector(".diff-split")).toBeTruthy();
  });
});
