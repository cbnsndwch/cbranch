import { Oid, RepoId } from "@cbranch/rpc-contract";
import { beforeEach, describe, expect, test } from "vitest";

import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({
    activeRepoId: null,
    selectedOid: null,
    paletteOpen: false,
    theme: "system",
    commitDraft: { subject: "", body: "", amend: false, signoff: false },
    stagedSelection: new Set(),
    unstagedSelection: new Set(),
    selectedDiffFile: null,
  });
});

describe("useUiStore", () => {
  test("setActiveRepoId sets the repo and clears the prior selection (P1-OPEN-4)", () => {
    useUiStore.getState().setSelectedOid(Oid.make("deadbeef"));
    useUiStore.getState().setActiveRepoId(RepoId.make("repo-1"));
    expect(useUiStore.getState().activeRepoId).toBe("repo-1");
    expect(useUiStore.getState().selectedOid).toBeNull();
  });

  test("setSelectedOid and setPaletteOpen update transient state", () => {
    useUiStore.getState().setSelectedOid(Oid.make("c0ffee"));
    expect(useUiStore.getState().selectedOid).toBe("c0ffee");
    useUiStore.getState().setPaletteOpen(true);
    expect(useUiStore.getState().paletteOpen).toBe(true);
  });

  test("setTheme updates the preference", () => {
    useUiStore.getState().setTheme("dark");
    expect(useUiStore.getState().theme).toBe("dark");
  });

  // ── P2: commit draft ────────────────────────────────────────────────────────

  test("updateCommitDraft merges partial fields without touching others", () => {
    useUiStore.getState().updateCommitDraft({ subject: "feat: something" });
    const draft = useUiStore.getState().commitDraft;
    expect(draft.subject).toBe("feat: something");
    expect(draft.body).toBe("");
    expect(draft.amend).toBe(false);
  });

  test("resetCommitDraft returns to defaults", () => {
    useUiStore.getState().updateCommitDraft({ subject: "wip", amend: true });
    useUiStore.getState().resetCommitDraft();
    const draft = useUiStore.getState().commitDraft;
    expect(draft.subject).toBe("");
    expect(draft.amend).toBe(false);
  });

  // ── P2: file selection ──────────────────────────────────────────────────────

  test("toggleStagedSelection adds then removes a path", () => {
    useUiStore.getState().toggleStagedSelection("a.ts");
    expect(useUiStore.getState().stagedSelection.has("a.ts")).toBe(true);
    useUiStore.getState().toggleStagedSelection("a.ts");
    expect(useUiStore.getState().stagedSelection.has("a.ts")).toBe(false);
  });

  test("setStagedSelection replaces the entire set", () => {
    useUiStore.getState().toggleStagedSelection("old.ts");
    useUiStore.getState().setStagedSelection(["new1.ts", "new2.ts"]);
    expect(useUiStore.getState().stagedSelection.has("old.ts")).toBe(false);
    expect(useUiStore.getState().stagedSelection.size).toBe(2);
  });

  test("clearSelection empties both staged and unstaged sets", () => {
    useUiStore.getState().setStagedSelection(["a.ts"]);
    useUiStore.getState().setUnstagedSelection(["b.ts"]);
    useUiStore.getState().clearSelection();
    expect(useUiStore.getState().stagedSelection.size).toBe(0);
    expect(useUiStore.getState().unstagedSelection.size).toBe(0);
  });

  test("setActiveRepoId clears file selection and selectedDiffFile", () => {
    useUiStore.getState().setStagedSelection(["a.ts"]);
    useUiStore.getState().setSelectedDiffFile({ path: "a.ts", staged: true });
    useUiStore.getState().setActiveRepoId(RepoId.make("repo-2"));
    expect(useUiStore.getState().stagedSelection.size).toBe(0);
    expect(useUiStore.getState().selectedDiffFile).toBeNull();
  });

  test("toggleUnstagedSelection works independently from staged", () => {
    useUiStore.getState().toggleUnstagedSelection("b.ts");
    expect(useUiStore.getState().unstagedSelection.has("b.ts")).toBe(true);
    expect(useUiStore.getState().stagedSelection.has("b.ts")).toBe(false);
  });
});
