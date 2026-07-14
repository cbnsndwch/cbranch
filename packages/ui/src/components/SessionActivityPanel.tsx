import { Activity, Pin, PinOff, Terminal, X } from 'lucide-react';
import { useEffect } from 'react';

import { useCommandLog } from '../rpc/hooks';
import { useUiStore } from '../state/store';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from './ui/tooltip';

const statusTone = {
    running: 'muted',
    success: 'muted',
    error: 'danger',
    cancelled: 'warn',
} as const;

const formatTime = (time: number): string =>
    new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(time);

const redact = (text: string): string =>
    text.replace(/(https?:\/\/)[^\s/@]+@/g, '$1***@');

/** Global session activity and completed host command records for remote Git work. */
export function SessionActivityPanel() {
    const activities = useUiStore(s => s.sessionActivities);
    const open = useUiStore(s => s.sessionActivityOpen);
    const pinned = useUiStore(s => s.sessionActivityPinned);
    const setOpen = useUiStore(s => s.setSessionActivityOpen);
    const setPinned = useUiStore(s => s.setSessionActivityPinned);
    const commands = useCommandLog(undefined, true);
    const latestEnd = activities.find(activity => activity.endedAt)?.endedAt;
    const hasRunning = activities.some(
        activity => activity.status === 'running',
    );
    const hasFailure = activities.some(activity => activity.status === 'error');

    useEffect(() => {
        if (
            !open ||
            pinned ||
            hasRunning ||
            hasFailure ||
            latestEnd === undefined
        )
            return;
        const timer = setTimeout(() => setOpen(false), 6_000);
        return () => clearTimeout(timer);
    }, [hasFailure, hasRunning, latestEnd, open, pinned, setOpen]);

    if (!open) return null;

    return (
        <TooltipProvider>
            <aside
                role="dialog"
                aria-label="Session activity"
                className="bg-background fixed right-4 bottom-4 z-50 flex h-[min(560px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] flex-col border shadow-xl"
            >
                <header className="flex items-center gap-2 border-b px-3 py-2">
                    <Activity className="size-4" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-semibold">
                            Session activity
                        </h2>
                        <p className="text-muted-foreground text-[11px]">
                            Live sync output and completed Git commands
                        </p>
                    </div>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-7"
                                    aria-label={
                                        pinned
                                            ? 'Allow activity panel to close automatically'
                                            : 'Keep activity panel open'
                                    }
                                    onClick={() => setPinned(!pinned)}
                                >
                                    {pinned ? (
                                        <Pin className="size-3.5" />
                                    ) : (
                                        <PinOff className="size-3.5" />
                                    )}
                                </Button>
                            }
                        />
                        <TooltipContent>
                            {pinned
                                ? 'Unpin activity panel'
                                : 'Keep panel open'}
                        </TooltipContent>
                    </Tooltip>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Close session activity"
                        onClick={() => setOpen(false)}
                    >
                        <X className="size-3.5" />
                    </Button>
                </header>
                <div className="min-h-0 flex-1 overflow-auto">
                    <section className="border-b py-1.5">
                        <h3 className="text-muted-foreground px-3 py-1 text-[10px] font-medium tracking-wide uppercase">
                            Remote operations
                        </h3>
                        {activities.length === 0 ? (
                            <p className="text-muted-foreground px-3 py-2 text-xs">
                                Sync activity will appear here.
                            </p>
                        ) : (
                            activities.map(activity => (
                                <details
                                    key={activity.id}
                                    open={activity.status === 'running'}
                                    className="border-t first:border-t-0"
                                >
                                    <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs">
                                        <Badge
                                            tone={statusTone[activity.status]}
                                        >
                                            {activity.status === 'running'
                                                ? activity.kind
                                                : activity.status}
                                        </Badge>
                                        <span className="min-w-0 flex-1 truncate font-medium">
                                            {activity.label}
                                        </span>
                                        <time className="text-muted-foreground shrink-0 text-[10px]">
                                            {formatTime(activity.startedAt)}
                                        </time>
                                    </summary>
                                    <pre className="bg-muted/30 max-h-40 overflow-auto border-t px-3 py-2 whitespace-pre-wrap text-[11px]">
                                        {activity.events.map(redact).join('\n')}
                                    </pre>
                                </details>
                            ))
                        )}
                    </section>
                    <section className="py-1.5">
                        <h3 className="text-muted-foreground flex items-center gap-1.5 px-3 py-1 text-[10px] font-medium tracking-wide uppercase">
                            <Terminal className="size-3" aria-hidden="true" />
                            Git command log
                        </h3>
                        {commands.slice(0, 12).map(command => (
                            <div
                                key={command.seq}
                                className="flex items-center gap-2 px-3 py-1 text-[11px]"
                            >
                                <Badge
                                    tone={command.success ? 'muted' : 'danger'}
                                >
                                    {command.success
                                        ? 'ok'
                                        : `exit ${command.exitCode ?? 'killed'}`}
                                </Badge>
                                <span className="min-w-0 flex-1 truncate font-mono">
                                    git {command.argv.join(' ')}
                                </span>
                                <span className="text-muted-foreground shrink-0">
                                    {command.durationMs} ms
                                </span>
                            </div>
                        ))}
                        {commands.length === 0 ? (
                            <p className="text-muted-foreground px-3 py-2 text-xs">
                                No Git commands recorded yet.
                            </p>
                        ) : null}
                    </section>
                </div>
            </aside>
        </TooltipProvider>
    );
}
