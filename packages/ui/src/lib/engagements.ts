import { type EngagementColor } from '@cbranch/rpc-contract';

export const ENGAGEMENT_COLORS: ReadonlyArray<EngagementColor> = [
    'teal',
    'blue',
    'violet',
    'amber',
    'rose',
    'slate',
];

export const engagementColorClass: Record<EngagementColor, string> = {
    teal: 'bg-teal-600 text-white',
    blue: 'bg-blue-600 text-white',
    violet: 'bg-violet-600 text-white',
    amber: 'bg-amber-500 text-black',
    rose: 'bg-rose-600 text-white',
    slate: 'bg-slate-600 text-white',
};

export const engagementSwatchClass: Record<EngagementColor, string> = {
    teal: 'bg-teal-600',
    blue: 'bg-blue-600',
    violet: 'bg-violet-600',
    amber: 'bg-amber-500',
    rose: 'bg-rose-600',
    slate: 'bg-slate-600',
};

export const engagementInitials = (name: string): string => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
    return `${words[0]![0] ?? ''}${words.at(-1)![0] ?? ''}`.toUpperCase();
};

/** Move one persisted workspace id before another without mutating query-owned data. */
export const moveWorkspaceId = <T>(
    items: ReadonlyArray<T>,
    source: T,
    target: T,
): T[] => {
    const from = items.indexOf(source);
    const to = items.indexOf(target);
    if (from < 0 || to < 0 || from === to) return [...items];
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    return next;
};
