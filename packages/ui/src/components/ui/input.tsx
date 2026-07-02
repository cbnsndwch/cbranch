import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

function Input({ className, ...props }: ComponentProps<'input'>) {
    return (
        <input
            data-slot="input"
            className={cn(
                'flex h-8 w-full min-w-0 rounded-none border border-input bg-transparent px-2 py-1 text-sm transition-colors outline-none selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
                className,
            )}
            {...props}
        />
    );
}

export { Input };
