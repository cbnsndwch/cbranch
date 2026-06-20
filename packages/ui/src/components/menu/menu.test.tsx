// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, test, vi } from "vitest";

import { type CbranchApi } from "../../rpc/api";
import { ApiProvider } from "../../rpc/ApiProvider";
import { MenuBar } from "../MenuBar";
import { type MenuEntry, MENUS } from "./menu-model";

const TOP_MENUS = [
  "Start",
  "Repository",
  "Navigate",
  "View",
  "Commands",
  "GitHub",
  "Plugins",
  "Tools",
  "Help",
];

const fakeApi = { recentList: vi.fn(async () => []) } as unknown as CbranchApi;

const renderMenuBar = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ApiProvider api={fakeApi}>
          <MenuBar />
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

afterEach(() => cleanup());

describe("menu model (menu-hierarchy.md)", () => {
  test("defines all nine top-level menus in order", () => {
    expect(MENUS.map((m) => m.label)).toEqual(TOP_MENUS);
  });

  test("every command/checkbox/submenu id is unique (ids drive the action registry)", () => {
    const ids: string[] = [];
    const walk = (entries: ReadonlyArray<MenuEntry>) => {
      for (const e of entries) {
        if (e.kind === "separator") continue;
        ids.push(e.id);
        if (e.kind === "submenu") walk(e.items);
      }
    };
    MENUS.forEach((m) => walk(m.items));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("MenuBar (full chrome from day one)", () => {
  test("renders all nine top-level menu triggers", () => {
    renderMenuBar();
    for (const label of TOP_MENUS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});
