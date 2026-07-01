// History-grid column visibility menu (docs/spec/17 REQ-P6-COL-001..003). A header
// dropdown with one checkbox per optional column (author name, avatar, date, SHA). The
// graph cell and commit summary are always present and are not toggleable. The choice is
// persisted as an app setting via config.appSet — never in git config (REQ-P6-COL-003).

import { HistoryColumnVisibility } from '@cbranch/rpc-contract';

import { useAppSettings, useSetAppSettings } from '../rpc/hooks';
import { Button } from './ui/button';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from './ui/dropdown-menu';

/** Column visibility with every column shown — the default when settings haven't loaded. */
export const DEFAULT_HISTORY_COLUMNS: HistoryColumnVisibility =
    new HistoryColumnVisibility({
        authorName: true,
        avatar: true,
        date: true,
        sha: true,
    });

const COLUMN_LABELS: ReadonlyArray<{
    key: keyof HistoryColumnVisibility;
    label: string;
}> = [
    { key: 'authorName', label: 'Author name' },
    { key: 'avatar', label: 'Author avatar' },
    { key: 'date', label: 'Date' },
    { key: 'sha', label: 'SHA' },
];

/** Read the persisted column visibility, defaulting every column to shown. */
export function useHistoryColumns(): HistoryColumnVisibility {
    const settings = useAppSettings();
    return settings.data?.columns ?? DEFAULT_HISTORY_COLUMNS;
}

export function HistoryColumnMenu() {
    const columns = useHistoryColumns();
    const save = useSetAppSettings();

    const toggle = (key: keyof HistoryColumnVisibility) =>
        save.mutate({
            columns: new HistoryColumnVisibility({
                ...columns,
                [key]: !columns[key],
            }),
        });

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                    >
                        Columns
                    </Button>
                }
            />
            <DropdownMenuContent side="bottom" align="end">
                {COLUMN_LABELS.map(({ key, label }) => (
                    <DropdownMenuCheckboxItem
                        key={key}
                        checked={columns[key]}
                        onCheckedChange={() => toggle(key)}
                        // Keep the menu open so several columns can be toggled at once.
                        closeOnClick={false}
                    >
                        {label}
                    </DropdownMenuCheckboxItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
