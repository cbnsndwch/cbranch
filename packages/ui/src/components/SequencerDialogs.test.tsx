// @vitest-environment jsdom
import {
  CommitDetail,
  Oid,
  RepoId,
  SequencerResult,
  Signature,
} from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { useUiStore } from "../state/store";
import { PickDialogs } from "./SequencerDialogs";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

const repoId = RepoId.make("repo-1");
const OID = Oid.make("c0ffee");

const sig = new Signature({
  name: "A",
  email: "a@b.c",
  when: { epochSeconds: 0, tzOffsetMinutes: 0 },
});

const detail = (parents: string[], subject = "the subject"): CommitDetail =>
  new CommitDetail({
    oid: OID,
    parents: parents.map((p) => Oid.make(p)),
    tree: Oid.make("tree00"),
    author: sig,
    committer: sig,
    subject,
    body: "",
    messageRaw: subject,
    stats: { filesChanged: 0, additions: 0, deletions: 0 },
  });

const seq = (over: Partial<SequencerResult> = {}): SequencerResult =>
  new SequencerResult({
    outcome: "completed",
    operation: "cherryPick",
    committed: 1,
    ...over,
  });

const makeApi = (over: Partial<CbranchApi> = {}): CbranchApi =>
  ({
    commitDetail: vi.fn(async () => detail(["p0"])),
    cherryPick: vi.fn(async () => seq()),
    revert: vi.fn(async () => seq({ operation: "revert" })),
    opSkip: vi.fn(async () => seq()),
    opContinue: vi.fn(async () => seq()),
    ...over,
  }) as unknown as CbranchApi;

const renderDialogs = (api: CbranchApi) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApiProvider api={api}>
        <PickDialogs />
      </ApiProvider>
    </QueryClientProvider>,
  );
};

const openCherryPick = (subject = "the subject") =>
  useUiStore.setState({
    pickDialog: { kind: "cherryPick", commits: [{ oid: OID, subject }] },
  });

const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({
    activeRepoId: repoId,
    selectedOid: null,
    pickDialog: null,
    activeView: "history",
  });
});
afterEach(() => cleanup());

describe("CherryPickDialog (REQ-UX-001/002, AC-3/5)", () => {
  test("applies a non-merge commit, toasts success, and closes", async () => {
    const cherryPick = vi.fn(
      (_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
        Promise.resolve(seq()),
    );
    openCherryPick();
    renderDialogs(makeApi({ cherryPick }));

    await waitFor(() => expect(button("Cherry-pick").disabled).toBe(false));
    fireEvent.click(button("Cherry-pick"));

    await waitFor(() =>
      expect(cherryPick).toHaveBeenCalledWith(
        repoId,
        [OID],
        expect.objectContaining({ noCommit: undefined, mainline: undefined }),
      ),
    );
    expect(toast.success).toHaveBeenCalled();
    await waitFor(() => expect(useUiStore.getState().pickDialog).toBeNull());
  });

  test("a merge commit gates submit on choosing a mainline (AC-3)", async () => {
    const cherryPick = vi.fn(
      (_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
        Promise.resolve(seq()),
    );
    openCherryPick();
    renderDialogs(
      makeApi({
        cherryPick,
        commitDetail: vi.fn(async () => detail(["p0", "p1"])),
      }),
    );

    const select = (await screen.findByLabelText(
      "Mainline parent",
    )) as HTMLSelectElement;
    expect(button("Cherry-pick").disabled).toBe(true);

    fireEvent.change(select, { target: { value: "2" } });
    expect(button("Cherry-pick").disabled).toBe(false);
    fireEvent.click(button("Cherry-pick"));

    await waitFor(() =>
      expect(cherryPick).toHaveBeenCalledWith(
        repoId,
        [OID],
        expect.objectContaining({ mainline: 2 }),
      ),
    );
  });

  test("record source sends -x", async () => {
    const cherryPick = vi.fn(
      (_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
        Promise.resolve(seq()),
    );
    openCherryPick();
    renderDialogs(makeApi({ cherryPick }));

    await waitFor(() => expect(button("Cherry-pick").disabled).toBe(false));
    fireEvent.click(screen.getByLabelText(/Record source/));
    fireEvent.click(button("Cherry-pick"));

    await waitFor(() =>
      expect(cherryPick).toHaveBeenCalledWith(
        repoId,
        [OID],
        expect.objectContaining({ recordOrigin: true }),
      ),
    );
  });

  test("the do-not-commit option stages only (AC-4)", async () => {
    const cherryPick = vi.fn(
      (_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
        Promise.resolve(seq({ outcome: "staged", committed: 0 })),
    );
    openCherryPick();
    renderDialogs(makeApi({ cherryPick }));

    await waitFor(() => expect(button("Cherry-pick").disabled).toBe(false));
    fireEvent.click(
      screen.getByLabelText("Do not commit (stage changes only)"),
    );
    fireEvent.click(button("Stage changes"));

    await waitFor(() =>
      expect(cherryPick).toHaveBeenCalledWith(
        repoId,
        [OID],
        expect.objectContaining({ noCommit: true }),
      ),
    );
  });

  test("an empty pick opens the Skip / Commit-anyway prompt (REQ-UX-008)", async () => {
    const cherryPick = vi.fn(async () =>
      seq({
        outcome: "empty",
        committed: 0,
        currentOid: Oid.make("dead"),
        currentSubject: "already applied",
      }),
    );
    openCherryPick();
    renderDialogs(makeApi({ cherryPick }));

    await waitFor(() => expect(button("Cherry-pick").disabled).toBe(false));
    fireEvent.click(button("Cherry-pick"));

    await waitFor(() =>
      expect(useUiStore.getState().pickDialog?.kind).toBe("empty"),
    );
    expect(await screen.findByText("Nothing to apply")).toBeTruthy();
  });

  test("a conflicting pick routes into the Conflicts view", async () => {
    const cherryPick = vi.fn(async () =>
      seq({ outcome: "conflicts", committed: 0 }),
    );
    openCherryPick();
    renderDialogs(makeApi({ cherryPick }));

    await waitFor(() => expect(button("Cherry-pick").disabled).toBe(false));
    fireEvent.click(button("Cherry-pick"));

    await waitFor(() =>
      expect(useUiStore.getState().activeView).toBe("solveConflicts"),
    );
    expect(useUiStore.getState().pickDialog).toBeNull();
  });

  test("a failure toasts and keeps the dialog open (REQ-UX-011)", async () => {
    const cherryPick = vi.fn(async () => {
      throw new Error("dirty working tree");
    });
    openCherryPick();
    renderDialogs(makeApi({ cherryPick }));

    await waitFor(() => expect(button("Cherry-pick").disabled).toBe(false));
    fireEvent.click(button("Cherry-pick"));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(useUiStore.getState().pickDialog).not.toBeNull();
  });

  test("a failed commit-detail load blocks submit so the mainline gate is not skipped", async () => {
    openCherryPick();
    renderDialogs(
      makeApi({
        commitDetail: vi.fn(async () => {
          throw new Error("commit not found");
        }),
      }),
    );

    await screen.findByText(/Could not load this commit/);
    // parents are unknown, so submit stays disabled rather than dispatching with no -m.
    expect(button("Cherry-pick").disabled).toBe(true);
  });
});

describe("RevertDialog (REQ-RV-001/002)", () => {
  test("a single-commit revert sends an editable default message", async () => {
    const revert = vi.fn((_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
      Promise.resolve(seq({ operation: "revert" })),
    );
    useUiStore.setState({
      pickDialog: { kind: "revert", commits: [{ oid: OID, subject: "Add x" }] },
    });
    renderDialogs(makeApi({ revert }));

    const message = (await screen.findByLabelText(
      "Commit message",
    )) as HTMLTextAreaElement;
    expect(message.value).toContain("This reverts commit");

    await waitFor(() => expect(button("Revert").disabled).toBe(false));
    fireEvent.click(button("Revert"));

    await waitFor(() =>
      expect(revert).toHaveBeenCalledWith(
        repoId,
        [OID],
        expect.objectContaining({
          message: expect.stringContaining("This reverts commit"),
        }),
      ),
    );
  });

  test("a merge revert gates submit on a mainline (AC-5)", async () => {
    const revert = vi.fn((_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
      Promise.resolve(seq({ operation: "revert" })),
    );
    useUiStore.setState({
      pickDialog: { kind: "revert", commits: [{ oid: OID, subject: "merge" }] },
    });
    renderDialogs(
      makeApi({
        revert,
        commitDetail: vi.fn(async () => detail(["p0", "p1"])),
      }),
    );

    const select = (await screen.findByLabelText(
      "Mainline parent",
    )) as HTMLSelectElement;
    expect(button("Revert").disabled).toBe(true);
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(button("Revert"));

    await waitFor(() =>
      expect(revert).toHaveBeenCalledWith(
        repoId,
        [OID],
        expect.objectContaining({ mainline: 1 }),
      ),
    );
  });

  test("an empty revert preserves the typed message through Commit anyway", async () => {
    const revert = vi.fn((_r: RepoId, _c: ReadonlyArray<Oid>, _o?: unknown) =>
      Promise.resolve(
        seq({
          operation: "revert",
          outcome: "empty",
          committed: 0,
          currentOid: OID,
        }),
      ),
    );
    const opContinue = vi.fn((_r: RepoId, _o?: unknown) =>
      Promise.resolve(seq({ operation: "revert" })),
    );
    useUiStore.setState({
      pickDialog: { kind: "revert", commits: [{ oid: OID, subject: "Add x" }] },
    });
    renderDialogs(makeApi({ revert, opContinue }));

    await screen.findByLabelText("Commit message");
    await waitFor(() => expect(button("Revert").disabled).toBe(false));
    fireEvent.click(button("Revert"));

    await screen.findByText("Nothing to apply");
    fireEvent.click(button("Commit anyway"));

    await waitFor(() =>
      expect(opContinue).toHaveBeenCalledWith(
        repoId,
        expect.objectContaining({
          allowEmpty: true,
          message: expect.stringContaining("This reverts commit"),
        }),
      ),
    );
  });
});

describe("EmptyPickDialog (REQ-UX-008, REQ-EDGE-005)", () => {
  const openEmpty = () =>
    useUiStore.setState({
      pickDialog: {
        kind: "empty",
        mode: "cherryPick",
        currentOid: OID,
        currentSubject: "already applied",
      },
    });

  test("Skip this commit calls opSkip and closes", async () => {
    const opSkip = vi.fn(async () => seq({ committed: 0 }));
    openEmpty();
    renderDialogs(makeApi({ opSkip }));

    fireEvent.click(button("Skip this commit"));
    await waitFor(() => expect(opSkip).toHaveBeenCalled());
    await waitFor(() => expect(useUiStore.getState().pickDialog).toBeNull());
  });

  test("Commit anyway records an empty commit via opContinue", async () => {
    const opContinue = vi.fn((_r: RepoId, _o?: unknown) =>
      Promise.resolve(seq()),
    );
    openEmpty();
    renderDialogs(makeApi({ opContinue }));

    fireEvent.click(button("Commit anyway"));
    await waitFor(() =>
      expect(opContinue).toHaveBeenCalledWith(
        repoId,
        expect.objectContaining({ allowEmpty: true }),
      ),
    );
  });

  test("dismissing the prompt surfaces the in-progress Conflicts view", () => {
    openEmpty();
    renderDialogs(makeApi());

    fireEvent.click(button("Cancel"));
    expect(useUiStore.getState().pickDialog).toBeNull();
    expect(useUiStore.getState().activeView).toBe("solveConflicts");
  });
});
