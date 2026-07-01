import { Command } from 'cmdk';
import { type KeyboardEvent, useState } from 'react';

import { useOpenRepo, useRecentList } from '../rpc/hooks';
import { useNavigation } from '../state/navigation';
import { useUiStore } from '../state/store';
import { useMenuActions } from './menu/use-menu-actions';

// Repo open / switcher (P1-UI-OPEN-1/4): fuzzy-match recent repositories or type an
// absolute path to open. A custom overlay hosts the cmdk menu (keyboard nav + filtering)
// so styling/focus stay under our control. Open failures keep the palette open (P1-UI-OPEN-4).
const looksLikePath = (value: string): boolean =>
    value.startsWith('/') || (value.length > 2 && value[1] === ':');

// The primary power-feature commands the palette must surface by name (spec §Entry points
// / NF-A11Y-6). Each dispatches its existing menu command id through the shared handler
// map, so the palette adds no new behavior. Shown only with a repo open (D18).
const PALETTE_COMMANDS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'commands.rebase', label: 'Interactive rebase' },
    { id: 'commands.reflog', label: 'Reflog' },
    { id: 'commands.bisect', label: 'Bisect: start' },
    { id: 'commands.archive', label: 'Export archive' },
    { id: 'commands.clean', label: 'Clean working directory' },
    { id: 'repository.maintenance.compress', label: 'Run maintenance' },
    { id: 'repository.submodulesManage', label: 'Submodules' },
    { id: 'tools.settings', label: 'Settings' },
];

export function CommandPalette() {
    const open = useUiStore(s => s.paletteOpen);
    const setOpen = useUiStore(s => s.setPaletteOpen);
    const activeRepoId = useUiStore(s => s.activeRepoId);
    const { openRepo } = useNavigation();
    const recent = useRecentList();
    const openRepoMutation = useOpenRepo();
    const menuActions = useMenuActions();
    const [query, setQuery] = useState('');

    if (!open) return null;

    const activate = (path: string) =>
        openRepoMutation.mutate(path, {
            onSuccess: handle => {
                // Navigate to the repo route; <SyncRouteToStore> mirrors it into the store (D13).
                openRepo(handle.repoId);
                setOpen(false);
                setQuery('');
            },
        });

    const term = query.trim().toLowerCase();
    const matches = (recent.data ?? []).filter(
        r =>
            term === '' ||
            r.name.toLowerCase().includes(term) ||
            r.path.toLowerCase().includes(term),
    );
    const commandMatches =
        activeRepoId === null
            ? []
            : PALETTE_COMMANDS.filter(
                  c =>
                      menuActions.isEnabled(c.id) &&
                      (term === '' || c.label.toLowerCase().includes(term)),
              );

    const runCommand = (id: string) => {
        menuActions.run(id);
        setOpen(false);
        setQuery('');
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape') setOpen(false);
    };

    return (
        <div
            className="fixed inset-0 z-50 bg-black/40"
            onClick={() => setOpen(false)}
        >
            <div
                className="bg-popover text-popover-foreground mx-auto mt-[15vh] w-[min(640px,90vw)] overflow-hidden border shadow-lg"
                onClick={event => event.stopPropagation()}
                onKeyDown={onKeyDown}
            >
                <Command shouldFilter={false} label="Open or switch repository">
                    <Command.Input
                        autoFocus
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Search recent repositories or type an absolute path…"
                        className="placeholder:text-muted-foreground w-full border-b bg-transparent px-3 py-2.5 text-sm outline-none"
                    />
                    <Command.List className="max-h-80 overflow-auto p-1">
                        {openRepoMutation.isError ? (
                            <div className="text-destructive px-3 py-2 text-xs">
                                Could not open that path.
                            </div>
                        ) : null}
                        {commandMatches.length > 0 ? (
                            <Command.Group
                                heading="Commands"
                                className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs"
                            >
                                {commandMatches.map(c => (
                                    <Command.Item
                                        key={c.id}
                                        value={`command:${c.id}`}
                                        onSelect={() => runCommand(c.id)}
                                        className="data-[selected=true]:bg-accent flex cursor-pointer items-center px-3 py-2 text-sm"
                                    >
                                        {c.label}
                                    </Command.Item>
                                ))}
                            </Command.Group>
                        ) : null}
                        {looksLikePath(query) ? (
                            <Command.Item
                                value="open-path"
                                onSelect={() => activate(query.trim())}
                                className="data-[selected=true]:bg-accent flex cursor-pointer items-center gap-2 px-3 py-2 text-sm"
                            >
                                Open path:{' '}
                                <span className="font-mono text-xs">
                                    {query.trim()}
                                </span>
                            </Command.Item>
                        ) : null}
                        {matches.length === 0 && !looksLikePath(query) ? (
                            <div className="text-muted-foreground px-3 py-2 text-xs">
                                No recent repositories.
                            </div>
                        ) : null}
                        {matches.map(repo => (
                            <Command.Item
                                key={repo.repoId}
                                value={repo.repoId}
                                onSelect={() => activate(repo.path)}
                                className="data-[selected=true]:bg-accent flex cursor-pointer flex-col px-3 py-2"
                            >
                                <span className="text-sm font-medium">
                                    {repo.name}
                                </span>
                                <span className="text-muted-foreground truncate text-xs">
                                    {repo.path}
                                </span>
                            </Command.Item>
                        ))}
                    </Command.List>
                </Command>
            </div>
        </div>
    );
}
