// Vendored from Base UI AlertDialog primitives (REQ-STACK-014), following the same
// shadcn base-lyra wrapper pattern as dropdown-menu.tsx.
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import * as React from 'react';

import { cn } from '@/lib/cn';

function AlertDialog({ ...props }: AlertDialogPrimitive.Root.Props) {
    return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: AlertDialogPrimitive.Trigger.Props) {
    return (
        <AlertDialogPrimitive.Trigger
            data-slot="alert-dialog-trigger"
            {...props}
        />
    );
}

function AlertDialogPortal({ ...props }: AlertDialogPrimitive.Portal.Props) {
    return (
        <AlertDialogPrimitive.Portal
            data-slot="alert-dialog-portal"
            {...props}
        />
    );
}

function AlertDialogBackdrop({
    className,
    ...props
}: AlertDialogPrimitive.Backdrop.Props) {
    return (
        <AlertDialogPrimitive.Backdrop
            data-slot="alert-dialog-backdrop"
            className={cn('fixed inset-0 z-50 bg-black/50', className)}
            {...props}
        />
    );
}

function AlertDialogContent({
    className,
    children,
    ...props
}: AlertDialogPrimitive.Popup.Props) {
    return (
        <AlertDialogPortal>
            <AlertDialogBackdrop />
            <AlertDialogPrimitive.Popup
                data-slot="alert-dialog-content"
                className={cn(
                    'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
                    'rounded-lg border bg-background p-6 shadow-lg',
                    className,
                )}
                {...props}
            >
                {children}
            </AlertDialogPrimitive.Popup>
        </AlertDialogPortal>
    );
}

function AlertDialogHeader({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            data-slot="alert-dialog-header"
            className={cn('flex flex-col gap-2 text-left', className)}
            {...props}
        />
    );
}

function AlertDialogFooter({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            data-slot="alert-dialog-footer"
            className={cn(
                'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
                className,
            )}
            {...props}
        />
    );
}

function AlertDialogTitle({
    className,
    ...props
}: AlertDialogPrimitive.Title.Props) {
    return (
        <AlertDialogPrimitive.Title
            data-slot="alert-dialog-title"
            className={cn('text-lg font-semibold', className)}
            {...props}
        />
    );
}

function AlertDialogDescription({
    className,
    ...props
}: AlertDialogPrimitive.Description.Props) {
    return (
        <AlertDialogPrimitive.Description
            data-slot="alert-dialog-description"
            className={cn('text-muted-foreground text-sm', className)}
            {...props}
        />
    );
}

function AlertDialogClose({
    className,
    ...props
}: AlertDialogPrimitive.Close.Props) {
    return (
        <AlertDialogPrimitive.Close
            data-slot="alert-dialog-cancel"
            className={cn(
                'inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium',
                'hover:bg-accent hover:text-accent-foreground',
                className,
            )}
            {...props}
        />
    );
}

function AlertDialogAction({
    className,
    onClick,
    children,
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button
            data-slot="alert-dialog-action"
            className={cn(
                'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium',
                'bg-destructive text-destructive-foreground hover:bg-destructive/90',
                className,
            )}
            onClick={onClick}
            {...props}
        >
            {children}
        </button>
    );
}

export {
    AlertDialog,
    AlertDialogAction,
    AlertDialogBackdrop,
    AlertDialogClose,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogPortal,
    AlertDialogTitle,
    AlertDialogTrigger,
};
