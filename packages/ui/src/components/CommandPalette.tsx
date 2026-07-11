import { Command } from 'cmdk';
import { type KeyboardEvent, useState } from 'react';

import { useUiStore } from '../state/store';
import { useMenuActions } from './menu/use-menu-actions';

// Run-a-command palette (NF-A11Y-6 / NF-UX-1): search and invoke any primary command by
// name. Repository open/switch is a separate surface, <RepoSwitcher> — kept apart so this
// list isn't buried under a dozen commands when the user just wants to switch repos (D18
// originally merged the two; split back out after the merged list crowded out recent
// repos). Shown only with a repo open (D18).
const PALETTE_COMMANDS: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'navigate.goto', label: 'Go to commit' },
    { id: 'commands.reset', label: 'Reset to commit' },
    { id: 'commands.undoLastCommit', label: 'Undo last commit' },
    { id: 'tools.commandLog', label: 'Git command log' },
    { id: 'repository.editGitignore', label: 'Edit .gitignore' },
    { id: 'repository.editGitattributes', label: 'Edit .gitattributes' },
    { id: 'repository.editMailmap', label: 'Edit .mailmap' },
    { id: 'repository.editExclude', label: 'Edit info/exclude' },
    { id: 'commands.editNote', label: 'Notes: edit' },
    { id: 'view.showNotes', label: 'Toggle git notes' },
    { id: 'commands.exportPatch', label: 'Export patch…' },
    { id: 'commands.applyPatch', label: 'Apply patch…' },
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
    const open = useUiStore(s => s.commandPaletteOpen);
    const setOpen = useUiStore(s => s.setCommandPaletteOpen);
    const activeRepoId = useUiStore(s => s.activeRepoId);
    const menuActions = useMenuActions();
    const [query, setQuery] = useState('');

    if (!open) return null;

    const term = query.trim().toLowerCase();
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
                <Command shouldFilter={false} label="Run a command">
                    <Command.Input
                        autoFocus
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Search commands…"
                        className="placeholder:text-muted-foreground w-full border-b bg-transparent px-3 py-2.5 text-sm outline-none"
                    />
                    <Command.List className="max-h-80 overflow-auto p-1">
                        {activeRepoId === null ? (
                            <div className="text-muted-foreground px-3 py-2 text-xs">
                                Open a repository to run commands.
                            </div>
                        ) : commandMatches.length === 0 ? (
                            <div className="text-muted-foreground px-3 py-2 text-xs">
                                No matching commands.
                            </div>
                        ) : (
                            commandMatches.map(c => (
                                <Command.Item
                                    key={c.id}
                                    value={`command:${c.id}`}
                                    onSelect={() => runCommand(c.id)}
                                    className="data-[selected=true]:bg-accent flex cursor-pointer items-center px-3 py-2 text-sm"
                                >
                                    {c.label}
                                </Command.Item>
                            ))
                        )}
                    </Command.List>
                </Command>
            </div>
        </div>
    );
}
