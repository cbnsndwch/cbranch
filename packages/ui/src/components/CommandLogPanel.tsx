// Git command log panel (docs/spec/17 REQ-P6-CLOG-001..005). A newest-first, virtualized
// list of the host `git` invocations cbranch has run: the exact argument vector (monospace),
// the working directory, duration, and a success/failure badge. Failed rows expand to a
// bounded stderr excerpt. A repo filter scopes to the active repository, and a live-tail
// toggle streams new invocations as they happen. The log stores no stdout/object bytes and
// no secrets (redaction happens host-side).

import { type CommandLogEntry, type RepoId } from '@cbranch/rpc-contract';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState } from 'react';

import { useCommandLog } from '../rpc/hooks';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';

const ROW_HEIGHT = 40;

function CommandRow({ entry }: { entry: CommandLogEntry }) {
    const [expanded, setExpanded] = useState(false);
    const failed = !entry.success;
    return (
        <div className="border-b px-3 py-1 text-xs">
            <div className="flex items-center gap-2">
                <Badge tone={failed ? 'danger' : 'muted'}>
                    {failed ? `exit ${entry.exitCode ?? 'killed'}` : 'ok'}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono">
                    git {entry.argv.join(' ')}
                </span>
                <span className="text-muted-foreground shrink-0">
                    {entry.durationMs} ms
                </span>
                {failed && entry.stderrExcerpt !== undefined && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-1.5 text-xs"
                        onClick={() => setExpanded(v => !v)}
                    >
                        {expanded ? 'Hide' : 'stderr'}
                    </Button>
                )}
            </div>
            <div className="text-muted-foreground truncate font-mono text-[10px]">
                {entry.cwd}
            </div>
            {expanded && entry.stderrExcerpt !== undefined && (
                <pre className="bg-muted/40 mt-1 max-h-40 overflow-auto whitespace-pre-wrap border p-1 text-[10px]">
                    {entry.stderrExcerpt}
                </pre>
            )}
        </div>
    );
}

export function CommandLogPanel({ repoId }: { repoId: RepoId }) {
    const [thisRepoOnly, setThisRepoOnly] = useState(true);
    const [live, setLive] = useState(true);
    const entries = useCommandLog(thisRepoOnly ? repoId : undefined, live);

    const parentRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: entries.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 12,
    });

    const summary = useMemo(() => {
        const failed = entries.filter(e => !e.success).length;
        return { total: entries.length, failed };
    }, [entries]);

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-3 border-b px-3 py-2 text-xs">
                <span className="font-medium">Git command log</span>
                <Badge tone="muted">{summary.total}</Badge>
                {summary.failed > 0 && (
                    <Badge tone="danger">{summary.failed} failed</Badge>
                )}
                <label className="ml-auto flex items-center gap-1.5">
                    <Checkbox
                        aria-label="This repository only"
                        checked={thisRepoOnly}
                        onCheckedChange={c => setThisRepoOnly(c === true)}
                    />
                    This repo only
                </label>
                <label className="flex items-center gap-1.5">
                    <Checkbox
                        aria-label="Live tail"
                        checked={live}
                        onCheckedChange={c => setLive(c === true)}
                    />
                    Live tail
                </label>
            </div>

            {entries.length === 0 ? (
                <p className="text-muted-foreground px-3 py-4 text-xs">
                    No git commands recorded yet.
                </p>
            ) : (
                <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            position: 'relative',
                            width: '100%',
                        }}
                    >
                        {virtualizer.getVirtualItems().map(item => {
                            const entry = entries[item.index]!;
                            return (
                                <div
                                    key={entry.seq}
                                    className="absolute top-0 left-0 w-full"
                                    style={{
                                        transform: `translateY(${item.start}px)`,
                                    }}
                                >
                                    <CommandRow entry={entry} />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
