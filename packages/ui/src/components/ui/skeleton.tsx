import { cn } from '@/lib/cn';

/** A pulsing placeholder block for pending content (REQ-UX-011 loading state). */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
    return (
        <div
            data-slot="skeleton"
            className={cn('bg-muted animate-pulse rounded-none', className)}
            {...props}
        />
    );
}

export { Skeleton };
