import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';

import { type MenuEntry, MENUS } from './menu/menu-model';
import { type MenuActions, useMenuActions } from './menu/use-menu-actions';
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
} from './ui/menubar';
import { ThemeToggle } from './ThemeToggle';
import { useApi } from '../rpc/ApiProvider';
import { useUiStore } from '../state/store';

// The desktop shell's menu bar. The full nine-menu chrome renders from day one
// (menu-hierarchy.md); items without a wired handler render greyed/disabled, driven by the
// capability layer in `useMenuActions` rather than per-item conditionals here.

function renderEntry(
    entry: MenuEntry,
    key: string,
    actions: MenuActions,
): ReactNode {
    if (entry.kind === 'separator') return <MenubarSeparator key={key} />;

    if (entry.kind === 'submenu') {
        const dynamic =
            entry.dynamic === 'recent'
                ? actions.recent
                : entry.dynamic === 'favorites'
                  ? actions.favorites
                  : null;
        return (
            <MenubarSub key={key}>
                {/* Static submenus stay browsable; dynamic (recent/favorite) ones grey out when empty. */}
                <MenubarSubTrigger
                    disabled={dynamic !== null && dynamic.length === 0}
                >
                    {entry.label}
                </MenubarSubTrigger>
                <MenubarSubContent>
                    {dynamic !== null ? (
                        dynamic.length === 0 ? (
                            <MenubarItem disabled>(none)</MenubarItem>
                        ) : (
                            dynamic.map(it => (
                                <MenubarItem key={it.id} onClick={it.onSelect}>
                                    {it.label}
                                </MenubarItem>
                            ))
                        )
                    ) : (
                        entry.items.map((child, i) =>
                            renderEntry(child, `${key}.${i}`, actions),
                        )
                    )}
                </MenubarSubContent>
            </MenubarSub>
        );
    }

    const enabled = actions.isEnabled(entry.id);
    const accel = entry.accelerator ? (
        <MenubarShortcut>{entry.accelerator}</MenubarShortcut>
    ) : null;

    if (entry.kind === 'checkbox') {
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

    const Icon = entry.icon;
    return (
        <MenubarItem
            key={key}
            disabled={!enabled}
            onClick={() => actions.run(entry.id)}
            icon={Icon ? <Icon /> : undefined}
        >
            {entry.label}
            {accel}
        </MenubarItem>
    );
}

export function MenuBar() {
    const actions = useMenuActions();
    return (
        <Menubar className="bg-background h-full gap-0 rounded-none border-0 p-0 px-1">
            {MENUS.map(menu => (
                <MenubarMenu key={menu.id}>
                    <MenubarTrigger className="h-full rounded-none px-2 py-0 text-[11px] font-normal">
                        {menu.label}
                    </MenubarTrigger>
                    <MenubarContent>
                        {menu.id === 'plugins' ? (
                            <PluginEntries actions={actions} />
                        ) : (
                            menu.items.map((entry, i) =>
                                renderEntry(entry, `${menu.id}.${i}`, actions),
                            )
                        )}
                    </MenubarContent>
                </MenubarMenu>
            ))}

            <div className="flex-1" />
            <ThemeToggle />
        </Menubar>
    );
}

function PluginEntries({ actions }: { readonly actions: MenuActions }) {
    return (
        <>
            <PluginCommandEntries />
            <MenubarSeparator />
            <MenubarItem onClick={() => actions.run('plugins.settings')}>
                Plugin settings…
            </MenubarItem>
        </>
    );
}

function PluginCommandEntries() {
    const api = useApi();
    const repoId = useUiStore(state => state.activeRepoId);
    const engagementId = useUiStore(state => state.activeEngagementId);
    const setResult = useUiStore(state => state.setPluginCommandResult);
    const plugins = useQuery({
        queryKey: ['plugins', 'installed'],
        queryFn: () => api.pluginList(),
    });
    const commands = (plugins.data ?? []).flatMap(plugin =>
        plugin.enabled
            ? plugin.contributions.commands.map(command => ({
                  plugin,
                  command,
              }))
            : [],
    );
    type Command = (typeof commands)[number];
    type MenuNode = {
        readonly commands: Command[];
        readonly children: Map<string, MenuNode>;
    };
    const root: MenuNode = { commands: [], children: new Map() };
    for (const command of commands) {
        let node = root;
        for (const label of command.command.submenu ?? []) {
            let child = node.children.get(label);
            if (!child) {
                child = { commands: [], children: new Map() };
                node.children.set(label, child);
            }
            node = child;
        }
        node.commands.push(command);
    }
    const renderCommand = ({ plugin, command }: Command) => (
        <MenubarItem
            key={command.id}
            onClick={() =>
                void api
                    .pluginInvoke({
                        pluginId: plugin.lock.pluginId,
                        commandId: command.id,
                        repoId: String(repoId ?? 'global'),
                        engagementId: engagementId ?? undefined,
                    })
                    .then(result => {
                        if (result.result?._tag === 'notice') {
                            toast.success(result.result.message);
                        } else if (result.result?._tag === 'dialog') {
                            setResult({
                                title: result.result.title,
                                output: result.result.body,
                            });
                        } else if (result.result?._tag === 'panel') {
                            toast.success('Plugin panel updated.');
                        } else {
                            setResult({
                                title: command.title,
                                output: result.output,
                            });
                        }
                    })
            }
        >
            {command.title}
        </MenubarItem>
    );
    const renderNode = (node: MenuNode, path: string): ReactNode[] => [
        ...[...node.children].map(([label, child]) => (
            <MenubarSub key={`${path}.${label}`}>
                <MenubarSubTrigger>{label}</MenubarSubTrigger>
                <MenubarSubContent>
                    {renderNode(child, `${path}.${label}`)}
                </MenubarSubContent>
            </MenubarSub>
        )),
        ...node.commands.map(renderCommand),
    ];
    return (
        <>
            {commands.length === 0 ? (
                <MenubarItem disabled>(no plugins loaded)</MenubarItem>
            ) : (
                renderNode(root, 'plugins')
            )}
        </>
    );
}
