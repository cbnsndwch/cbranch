import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogClose,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from './ui/alert-dialog';

interface DestructiveConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description: string;
    confirmLabel?: string;
    onConfirm: () => void;
    /**
     * Optional set of affected paths, enumerated in a scrollable list beneath the
     * description so a bulk destructive action names exactly what it will act on
     * (REQ-P6-GUARD-001/003). A <ul> cannot live inside the description <p>, so it
     * is rendered as a sibling block.
     */
    paths?: readonly string[];
}

export function DestructiveConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel = 'Confirm',
    onConfirm,
    paths,
}: DestructiveConfirmDialogProps) {
    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{title}</AlertDialogTitle>
                    <AlertDialogDescription>
                        {description}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                {paths && paths.length > 0 && (
                    <ul className="bg-muted/30 my-2 max-h-48 overflow-auto rounded border p-2 text-xs">
                        {paths.map(p => (
                            <li key={p} className="truncate font-mono">
                                {p}
                            </li>
                        ))}
                    </ul>
                )}
                <AlertDialogFooter>
                    <AlertDialogClose onClick={() => onOpenChange(false)}>
                        Cancel
                    </AlertDialogClose>
                    <AlertDialogAction
                        onClick={() => {
                            onOpenChange(false);
                            onConfirm();
                        }}
                    >
                        {confirmLabel}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
