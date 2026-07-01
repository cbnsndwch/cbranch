import { type PropsWithChildren } from 'react';

import { cn } from '../../lib/cn';

export type BadgeTone = 'default' | 'muted' | 'warn' | 'danger';

const toneClass: Record<BadgeTone, string> = {
    default: 'border-border bg-secondary text-secondary-foreground',
    muted: 'border-border text-muted-foreground',
    warn: 'border-border text-status-behind',
    danger: 'border-border text-destructive',
};

/** A compact status pill (P1-UI-STAT-1). Uses theme tokens, not hardcoded colors. */
export function Badge({
    tone = 'default',
    children,
}: PropsWithChildren<{ readonly tone?: BadgeTone }>) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs font-medium',
                toneClass[tone],
            )}
        >
            {children}
        </span>
    );
}
