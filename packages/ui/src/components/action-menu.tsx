import { type LucideIcon } from 'lucide-react';
import { Fragment } from 'react';

import {
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
} from './ui/context-menu';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from './ui/dropdown-menu';

export type ActionMenuEntry =
    | { readonly kind: 'separator'; readonly id: string }
    | {
          readonly kind: 'action';
          readonly id: string;
          readonly label: string;
          readonly onSelect?: () => void;
          readonly disabledReason?: string;
          readonly variant?: 'default' | 'destructive';
          readonly accelerator?: string;
          readonly icon?: LucideIcon;
      }
    | {
          readonly kind: 'submenu';
          readonly id: string;
          readonly label: string;
          readonly entries: ReadonlyArray<ActionMenuEntry>;
          readonly disabledReason?: string;
          readonly icon?: LucideIcon;
      };

function ActionMenuIcon({ icon: Icon }: { readonly icon?: LucideIcon }) {
    return (
        <span
            data-slot="action-menu-icon"
            className="text-muted-foreground flex size-4 shrink-0 items-center justify-center"
            aria-hidden="true"
        >
            {Icon ? <Icon className="size-4" /> : null}
        </span>
    );
}

/** Shared rendering adapter so overflow and right-click menus consume one action model. */
export function ActionMenuItems({
    entries,
    surface,
}: {
    readonly entries: ReadonlyArray<ActionMenuEntry>;
    readonly surface: 'dropdown' | 'context';
}) {
    return entries.map(entry => {
        if (entry.kind === 'separator')
            return surface === 'context' ? (
                <ContextMenuSeparator key={entry.id} />
            ) : (
                <DropdownMenuSeparator key={entry.id} />
            );

        const disabled = Boolean(entry.disabledReason);
        const title = entry.disabledReason
            ? `${entry.label}: ${entry.disabledReason}`
            : undefined;

        if (entry.kind === 'submenu') {
            if (surface === 'context')
                return (
                    <ContextMenuSub key={entry.id}>
                        <ContextMenuSubTrigger
                            disabled={disabled}
                            title={title}
                            aria-label={title}
                        >
                            <ActionMenuIcon icon={entry.icon} />
                            <span className="flex min-w-0 flex-col">
                                <span>{entry.label}</span>
                                {entry.disabledReason ? (
                                    <span className="text-muted-foreground max-w-72 whitespace-normal text-[10px] font-normal">
                                        {entry.disabledReason}
                                    </span>
                                ) : null}
                            </span>
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            <ActionMenuItems
                                entries={entry.entries}
                                surface="context"
                            />
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                );
            return (
                <DropdownMenuSub key={entry.id}>
                    <DropdownMenuSubTrigger
                        disabled={disabled}
                        title={title}
                        aria-label={title}
                    >
                        <ActionMenuIcon icon={entry.icon} />
                        <span className="flex min-w-0 flex-col">
                            <span>{entry.label}</span>
                            {entry.disabledReason ? (
                                <span className="text-muted-foreground max-w-72 whitespace-normal text-[10px] font-normal">
                                    {entry.disabledReason}
                                </span>
                            ) : null}
                        </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <ActionMenuItems
                            entries={entry.entries}
                            surface="dropdown"
                        />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            );
        }

        const content = (
            <Fragment>
                <ActionMenuIcon icon={entry.icon} />
                <span className="flex min-w-0 flex-col">
                    <span>{entry.label}</span>
                    {entry.disabledReason ? (
                        <span className="text-muted-foreground max-w-72 whitespace-normal text-[10px] font-normal">
                            {entry.disabledReason}
                        </span>
                    ) : null}
                </span>
                {entry.accelerator ? (
                    <span className="text-muted-foreground ml-auto pl-4">
                        {entry.accelerator}
                    </span>
                ) : null}
            </Fragment>
        );
        const common = {
            disabled,
            title,
            'aria-label': title ?? entry.label,
            onClick: entry.onSelect,
            variant: entry.variant,
        } as const;
        return surface === 'context' ? (
            <ContextMenuItem key={entry.id} {...common}>
                {content}
            </ContextMenuItem>
        ) : (
            <DropdownMenuItem key={entry.id} {...common}>
                {content}
            </DropdownMenuItem>
        );
    });
}
