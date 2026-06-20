import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";

interface ChangeListToolbarProps {
  title: string;
  count: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onAction: () => void;
  actionLabel: string;
  disabled?: boolean;
}

export function ChangeListToolbar({
  title,
  count,
  allSelected,
  onSelectAll,
  onAction,
  actionLabel,
  disabled,
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
      <div className="ml-auto">
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
