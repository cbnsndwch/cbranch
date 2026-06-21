// @vitest-environment jsdom
import { Oid, RepoId } from "@cbranch/rpc-contract";
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toast } from "sonner";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { BlamePanel } from "./BlamePanel";

// Keep Shiki out of the unit tests: the highlighter resolves to no tokens (offline,
// deterministic) so lines render as plain text.
vi.mock("../lib/shiki-highlighter", () => ({
  languageForPath: () => "typescript",
  loadShikiLines: async () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

const repoId = RepoId.make("repo-1");
const headOid = Oid.make("0123456789abcdef0123456789abcdef01234567");
const A = "a".repeat(40);
const B = "b".repeat(40);
const PREV = "c".repeat(40);

const commit = (over: Record<string, unknown>) => ({
  oid: A,
  authorName: "Ada",
  authorEmail: "ada@x",
  authorTime: 1_700_000_000,
  authorTzMinutes: 0,
  summary: "first commit",
  filename: "src/a.ts",
  ...over,
});

// Two contiguous blocks: lines 0-1 owned by A, line 2 owned by B.
const blameData = {
  path: "src/a.ts",
  rev: headOid,
  commits: [
    commit({ oid: A, previousOid: PREV, previousPath: "src/old.ts" }),
    commit({ oid: B, authorName: "Bo", summary: "second commit" }),
  ],
  lines: [
    { ownerOid: A, finalLineNo: 1, origLineNo: 1, content: "const one = 1;" },
    { ownerOid: A, finalLineNo: 2, origLineNo: 2, content: "const two = 2;" },
    { ownerOid: B, finalLineNo: 3, origLineNo: 3, content: "const three = 3;" },
  ],
};

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    blame: vi.fn(async () => blameData),
    ...over,
  }) as unknown as CbranchApi;

const renderPanel = (
  api: CbranchApi,
  props: Partial<Parameters<typeof BlamePanel>[0]> = {},
) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const onOpenCommit = props.onOpenCommit ?? vi.fn();
  const ui: ReactNode = (
    <QueryClientProvider client={qc}>
      <ApiProvider api={api}>
        <BlamePanel
          repoId={repoId}
          rev={props.rev ?? headOid}
          path={props.path ?? "src/a.ts"}
          onClose={onClose}
          onOpenCommit={onOpenCommit}
        />
      </ApiProvider>
    </QueryClientProvider>
  );
  return { ...render(ui), onClose, onOpenCommit };
};

beforeEach(() => {
  // react-virtual needs a measurable scroll element in jsdom.
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    value: 800,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetHeight;
  delete (HTMLElement.prototype as Partial<HTMLElement>).offsetWidth;
});

describe("BlamePanel (REQ-UX-009)", () => {
  test("renders one attribution per contiguous block, beside the lines (AC-11)", async () => {
    renderPanel(makeApi());
    expect(await screen.findByText("const one = 1;")).toBeTruthy();
    expect(screen.getByText("const three = 3;")).toBeTruthy();
    // Block A (lines 0-1) shows its short oid once; block B once; the continuation line none.
    expect(screen.getAllByText("aaaaaaaa")).toHaveLength(1);
    expect(screen.getAllByText("bbbbbbbb")).toHaveLength(1);
    expect(screen.getByText("Ada")).toBeTruthy();
    expect(screen.getByText("Bo")).toBeTruthy();
  });

  test("a block popover reveals full details and opens the commit (REQ-BL-005)", async () => {
    const { onOpenCommit, onClose } = renderPanel(makeApi());
    await screen.findByText("const one = 1;");
    act(() =>
      fireEvent.click(screen.getByLabelText("Blame details for aaaaaaaa")),
    );
    expect(await screen.findByText(A)).toBeTruthy(); // full SHA
    expect(screen.getByText(/ada@x/)).toBeTruthy();
    act(() => fireEvent.click(screen.getByText("Open commit")));
    expect(onOpenCommit).toHaveBeenCalledWith(A);
    expect(onClose).toHaveBeenCalled();
  });

  test("Blame previous re-blames the parent at the prior path (REQ-BL-004/AC-12)", async () => {
    const blame = vi.fn(async () => blameData);
    renderPanel(makeApi({ blame }));
    await screen.findByText("const one = 1;");
    act(() =>
      fireEvent.click(screen.getByLabelText("Blame details for aaaaaaaa")),
    );
    const prevBtn = await screen.findByText("Blame previous");
    act(() => fireEvent.click(prevBtn));
    await waitFor(() =>
      expect(blame).toHaveBeenCalledWith(
        repoId,
        "src/old.ts",
        expect.objectContaining({ rev: PREV }),
      ),
    );
    // The header reflects the walked-back frame.
    expect(await screen.findByText(/src\/old\.ts/)).toBeTruthy();
    // "← Back" pops the stack to the root frame, where the control disappears.
    act(() => fireEvent.click(screen.getByLabelText("Back to previous blame")));
    await waitFor(() =>
      expect(screen.queryByLabelText("Back to previous blame")).toBeNull(),
    );
  });

  test("shows a loading skeleton while blame is pending (REQ-BL-006/UX-011)", async () => {
    const blame = vi.fn(() => new Promise(() => {})); // never resolves
    renderPanel(makeApi({ blame: blame as unknown as CbranchApi["blame"] }));
    await waitFor(() =>
      expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy(),
    );
    expect(screen.queryByText("const one = 1;")).toBeNull();
  });

  test("Blame previous is disabled at a root with no previous (boundary)", async () => {
    renderPanel(makeApi());
    await screen.findByText("const three = 3;");
    act(() =>
      fireEvent.click(screen.getByLabelText("Blame details for bbbbbbbb")),
    );
    const prev = (await screen.findByText("Blame previous")).closest(
      "button",
    ) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
  });

  test("the too-large cap arm offers a forced re-request (REQ-EDGE-010)", async () => {
    const blame = vi.fn(
      async (_r: unknown, _p: unknown, opts: { force?: boolean }) =>
        opts.force
          ? blameData
          : {
              path: "src/a.ts",
              rev: headOid,
              byteSize: 99_000_000,
              lineCount: 0,
            },
    );
    renderPanel(makeApi({ blame: blame as unknown as CbranchApi["blame"] }));
    expect(
      await screen.findByText("File too large to blame in app"),
    ).toBeTruthy();
    act(() => fireEvent.click(screen.getByText("Blame anyway")));
    await waitFor(() =>
      expect(blame).toHaveBeenCalledWith(
        repoId,
        "src/a.ts",
        expect.objectContaining({ force: true }),
      ),
    );
    expect(await screen.findByText("const one = 1;")).toBeTruthy();
  });

  test("a blame failure surfaces a toast and a retry (REQ-UX-011)", async () => {
    const blame = vi.fn(async () => {
      throw new Error("fatal: no such path");
    });
    renderPanel(makeApi({ blame: blame as unknown as CbranchApi["blame"] }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByText("Could not blame this file.")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
  });

  test("the syntax-highlighting toggle is available and lines stay rendered when off", async () => {
    renderPanel(makeApi());
    await screen.findByText("const one = 1;");
    const toggle = screen.getByLabelText(
      "Syntax highlighting",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    act(() => fireEvent.click(toggle));
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("const one = 1;")).toBeTruthy();
  });
});
