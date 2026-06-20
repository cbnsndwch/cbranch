// @vitest-environment jsdom
import {
  CommitDetail,
  DiffFile,
  DownloadDescriptor,
  FileContent,
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
import { DiffPanel } from "./DiffPanel";
import { FileAtRevision } from "./FileAtRevision";

// Keep Shiki offline/deterministic for both the diff surface and the file view.
vi.mock("../lib/shiki-highlighter", () => ({
  languageForPath: () => "typescript",
  loadShikiLines: async () => null,
  loadShikiRefractor: async () => null,
}));

// Minimal CodeMirror stubs so the read-only editor mounts without the real (lazy) engine.
vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: ({ doc }: { doc?: string }) => ({
      doc: {
        _text: doc ?? "",
        lines: 1,
        line: () => ({ from: 0, to: 0 }),
      },
    }),
    readOnly: { of: () => ({}) },
  },
  StateField: { define: () => ({}) },
  RangeSetBuilder: class {
    add() {}
    finish() {
      return {};
    }
  },
}));
vi.mock("@codemirror/view", () => ({
  EditorView: class {
    constructor({
      parent,
      state,
    }: {
      parent: HTMLElement;
      state: { doc: { _text: string } };
    }) {
      const el = document.createElement("div");
      el.className = "cm-content";
      el.textContent = state.doc._text;
      parent.appendChild(el);
    }
    destroy() {}
    static editable = { of: () => ({}) };
    static decorations = { from: () => ({}) };
    static theme = () => ({});
  },
  lineNumbers: () => ({}),
  Decoration: { mark: () => ({}) },
}));

const repoId = RepoId.make("repo-1");
const oid = Oid.make("0123456789abcdef0123456789abcdef01234567");

const file = (newPath: string): DiffFile =>
  new DiffFile({
    oldPath: newPath,
    newPath,
    status: "modified",
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [
      {
        header: "@@ -1 +1,2 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: [{ kind: "add" as const, content: "added line" }],
      },
    ],
  });

const sig = new Signature({
  name: "Ada",
  email: "ada@x",
  when: { epochSeconds: 1, tzOffsetMinutes: 0 },
});

const makeApi = (over: Partial<CbranchApi>): CbranchApi =>
  ({
    commitDiff: vi.fn(async () => [file("a.ts")]),
    commitDetail: vi.fn(
      async () =>
        new CommitDetail({
          oid,
          parents: [],
          tree: oid,
          author: sig,
          committer: sig,
          subject: "s",
          body: "",
          messageRaw: "s",
          stats: { filesChanged: 1, additions: 1, deletions: 0 },
        }),
    ),
    fileContentAtRev: vi.fn(
      async () =>
        new FileContent({
          path: "a.ts",
          size: 3,
          isBinary: false,
          encoding: "utf8",
          content: "hello world",
        }),
    ),
    ...over,
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
  useUiStore.setState({ diffView: "inline", theme: "light" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetHeight;
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
});

describe("FileAtRevision (P1-DIFF-7 / P1-UI-DIFF-3)", () => {
  test("renders inline utf8 content in the editor", async () => {
    renderWithApi(
      <FileAtRevision repoId={repoId} rev={oid} path="a.ts" />,
      makeApi({}),
    );
    expect(await screen.findByText("hello world")).toBeTruthy();
  });

  test("a large blob shows a side-channel download link, not the editor", async () => {
    const api = makeApi({
      fileContentAtRev: vi.fn(
        async () =>
          new DownloadDescriptor({
            url: "/sidechannel/blob?x=1",
            size: 999999,
          }),
      ),
    });
    renderWithApi(
      <FileAtRevision repoId={repoId} rev={oid} path="big.bin" />,
      api,
    );
    const link = await screen.findByText("Download file");
    expect(link.getAttribute("href")).toBe("/sidechannel/blob?x=1");
  });

  test("a base64 (binary) blob shows the binary placeholder", async () => {
    const api = makeApi({
      fileContentAtRev: vi.fn(
        async () =>
          new FileContent({
            path: "x.png",
            size: 10,
            isBinary: true,
            encoding: "base64",
            content: "AAAA",
          }),
      ),
    });
    renderWithApi(
      <FileAtRevision repoId={repoId} rev={oid} path="x.png" />,
      api,
    );
    expect(await screen.findByText("Binary file")).toBeTruthy();
  });
});

describe("DiffPanel view-at-revision toggle (P1-UI-DIFF-3)", () => {
  test("toggles into the file view and back to the diff", async () => {
    renderWithApi(<DiffPanel repoId={repoId} oid={oid} />, makeApi({}));
    expect(await screen.findByText(/added line/)).toBeTruthy();
    fireEvent.click(screen.getByText("View at revision"));
    expect(await screen.findByText("hello world")).toBeTruthy();
    fireEvent.click(screen.getByText("Back to diff"));
    expect(await screen.findByText(/added line/)).toBeTruthy();
  });
});
