import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';

interface ChangeListToolbarProps {
    title: string;
    count: number;
    allSelected: boolean;
    onSelectAll: () => void;
    onAction: () => void;
    actionLabel: string;
    disabled?: boolean;
    /** An optional secondary action button shown before the primary one (e.g. "Clean…"). */
    secondaryAction?: { label: string; onClick: () => void };
    /**
     * An optional destructive action (e.g. "Discard Selected") shown before the
     * primary one and styled distinctly. Used for bulk discard/delete over the
     * current multi-selection (REQ-P6-GUARD-003).
     */
    destructiveAction?: { label: string; onClick: () => void };
}

export function ChangeListToolbar({
    title,
    count,
    allSelected,
    onSelectAll,
    onAction,
    actionLabel,
    disabled,
    secondaryAction,
    destructiveAction,
}: ChangeListToolbarProps) {
    return (
        <div className="flex items-center gap-2 px-2 py-1">
            <Checkbox
                checked={allSelected}
                onCheckedChange={onSelectAll}
                aria-label={`Select all ${title}`}
            />
            <span className="text-xs font-medium">{title}</span>
            <Badge tone="muted">{count}</Badge>
            <div className="ml-auto flex items-center gap-1">
                {destructiveAction && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive h-6 px-2 text-xs"
                        onClick={destructiveAction.onClick}
                    >
                        {destructiveAction.label}
                    </Button>
                )}
                {secondaryAction && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-xs"
                        onClick={secondaryAction.onClick}
                    >
                        {secondaryAction.label}
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    onClick={onAction}
                    disabled={disabled}
                >
                    {actionLabel}
                </Button>
            </div>
        </div>
    );
}
