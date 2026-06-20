import { type ReactNode } from "react";

import { type MenuEntry, MENUS } from "./menu/menu-model";
import { type MenuActions, useMenuActions } from "./menu/use-menu-actions";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "./ui/menubar";

// The desktop shell's menu bar. The full nine-menu chrome renders from day one
// (menu-hierarchy.md); items without a wired handler render greyed/disabled, driven by the
// capability layer in `useMenuActions` rather than per-item conditionals here.

function renderEntry(entry: MenuEntry, key: string, actions: MenuActions): ReactNode {
  if (entry.kind === "separator") return <MenubarSeparator key={key} />;

  if (entry.kind === "submenu") {
    const dynamic =
      entry.dynamic === "recent" ? actions.recent : entry.dynamic === "favorites" ? actions.favorites : null;
    return (
      <MenubarSub key={key}>
        {/* Static submenus stay browsable; dynamic (recent/favorite) ones grey out when empty. */}
        <MenubarSubTrigger disabled={dynamic !== null && dynamic.length === 0}>{entry.label}</MenubarSubTrigger>
        <MenubarSubContent>
          {dynamic !== null ? (
            dynamic.length === 0 ? (
              <MenubarItem disabled>(none)</MenubarItem>
            ) : (
              dynamic.map((it) => (
                <MenubarItem key={it.id} onClick={it.onSelect}>
                  {it.label}
                </MenubarItem>
              ))
            )
          ) : (
            entry.items.map((child, i) => renderEntry(child, `${key}.${i}`, actions))
          )}
        </MenubarSubContent>
      </MenubarSub>
    );
  }

  const enabled = actions.isEnabled(entry.id);
  const accel = entry.accelerator ? <MenubarShortcut>{entry.accelerator}</MenubarShortcut> : null;

  if (entry.kind === "checkbox") {
    return (
      <MenubarCheckboxItem
        key={key}
        disabled={!enabled}
        checked={actions.checkboxState(entry.id) ?? false}
        onClick={() => actions.run(entry.id)}
      >
        {entry.label}
        {accel}
      </MenubarCheckboxItem>
    );
  }

  return (
    <MenubarItem key={key} disabled={!enabled} onClick={() => actions.run(entry.id)}>
      {entry.label}
      {accel}
    </MenubarItem>
  );
}

export function MenuBar() {
  const actions = useMenuActions();
  return (
    <Menubar className="bg-background h-full gap-0 rounded-none border-0 border-b p-0 px-1">
      {MENUS.map((menu) => (
        <MenubarMenu key={menu.id}>
          <MenubarTrigger className="h-full rounded-none px-2 py-0 text-[11px] font-normal">
            {menu.label}
          </MenubarTrigger>
          <MenubarContent>
            {menu.items.map((entry, i) => renderEntry(entry, `${menu.id}.${i}`, actions))}
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  );
}
