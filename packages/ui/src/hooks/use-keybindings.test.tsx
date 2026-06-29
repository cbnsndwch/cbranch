// @vitest-environment jsdom
import { AppSettings, KeyBinding } from "@cbranch/rpc-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../rpc/api";
import { ApiProvider } from "../rpc/ApiProvider";
import { setKeybindingCaptureActive, useKeybindings } from "./use-keybindings";

const makeApi = (keybindings: KeyBinding[]): CbranchApi =>
  ({
    appSettingsGet: vi.fn(
      async () =>
        new AppSettings({ theme: "system", locale: "en", keybindings }),
    ),
    recentList: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
  }) as unknown as CbranchApi;

function Harness({ actions }: { actions: Record<string, () => void> }) {
  useKeybindings(actions);
  return <input aria-label="field" />;
}

const mount = async (api: CbranchApi, actions: Record<string, () => void>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ApiProvider api={api}>
        <Harness actions={actions} />
      </ApiProvider>
    </QueryClientProvider>,
  );
  // Let the app-settings query resolve AND commit (a macrotask flush so React re-renders
  // and the dispatcher ref picks up the merged overrides) before we fire keys.
  await waitFor(() => expect(api.appSettingsGet).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const press = (init: KeyboardEventInit) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
  });

afterEach(() => {
  cleanup();
  setKeybindingCaptureActive(false);
});
beforeEach(() => vi.clearAllMocks());

describe("useKeybindings dispatcher", () => {
  test("regression: the migrated shortcuts fire through the dispatcher", async () => {
    const palette = vi.fn();
    const commit = vi.fn();
    const find = vi.fn();
    await mount(makeApi([]), {
      "view.commandPalette": palette,
      "commands.commit": commit,
      "history.find": find,
    });

    press({ key: "k", ctrlKey: true }); // Mod+K (subsumes App.tsx)
    press({ key: "Enter", metaKey: true, shiftKey: true }); // Mod+Shift+Enter (AppShell)
    press({ key: "f", ctrlKey: true }); // Mod+F (HistoryList)

    expect(palette).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledTimes(1);
  });

  test("a user-remapped chord dispatches its bound command", async () => {
    const find = vi.fn();
    await mount(
      makeApi([new KeyBinding({ commandId: "history.find", chord: "Mod+G" })]),
      {
        "history.find": find,
      },
    );

    press({ key: "g", ctrlKey: true }); // the remapped chord fires
    expect(find).toHaveBeenCalledTimes(1);

    press({ key: "f", ctrlKey: true }); // the old default no longer fires
    expect(find).toHaveBeenCalledTimes(1);
  });

  test("a cleared default no longer fires", async () => {
    const palette = vi.fn();
    await mount(
      makeApi([
        new KeyBinding({ commandId: "view.commandPalette", chord: "" }),
      ]),
      { "view.commandPalette": palette },
    );

    press({ key: "k", ctrlKey: true });
    expect(palette).not.toHaveBeenCalled();
  });

  test("an active chord capture suppresses the dispatcher entirely (modifiers included)", async () => {
    const palette = vi.fn();
    await mount(makeApi([]), { "view.commandPalette": palette });

    // While a chord-capture input is recording, even a modifier chord must not fire its
    // bound action (the SettingsDialog regression: Mod+K popping the palette over Settings).
    setKeybindingCaptureActive(true);
    press({ key: "k", ctrlKey: true });
    expect(palette).not.toHaveBeenCalled();

    // Recording over → the dispatcher resumes.
    setKeybindingCaptureActive(false);
    press({ key: "k", ctrlKey: true });
    expect(palette).toHaveBeenCalledTimes(1);
  });

  test("a remapped bare-key chord does not hijack typing in a field", async () => {
    const find = vi.fn();
    await mount(
      makeApi([new KeyBinding({ commandId: "history.find", chord: "F" })]),
      { "history.find": find },
    );

    // Bare "f" anywhere else fires the bound action…
    press({ key: "f" });
    expect(find).toHaveBeenCalledTimes(1);

    // …but the same press while focused in an input is left for text entry.
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "f" });
    expect(find).toHaveBeenCalledTimes(1);
  });
});
