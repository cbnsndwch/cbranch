import { Oid, RepoId } from "@cbranch/rpc-contract";
import { beforeEach, describe, expect, test } from "vitest";

import { useUiStore } from "./store";

beforeEach(() => {
  useUiStore.setState({ activeRepoId: null, selectedOid: null, paletteOpen: false, theme: "system" });
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
});
