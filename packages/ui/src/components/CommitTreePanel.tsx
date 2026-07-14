import { type Oid, type RepoId } from '@cbranch/rpc-contract';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { cn } from '../lib/cn';
import { useCommitTree } from '../rpc/hooks';
import { Placeholder } from './ui/placeholder';

const ROW_HEIGHT = 24;

interface TreeDirectory {
    readonly directories: Map<string, TreeDirectory>;
    readonly files: string[];
}

interface TreeRow {
    readonly kind: 'directory' | 'file';
    readonly depth: number;
    readonly name: string;
    readonly path: string;
}

const createDirectory = (): TreeDirectory => ({
    directories: new Map(),
    files: [],
});

const buildTree = (paths: ReadonlyArray<string>): TreeDirectory => {
    const root = createDirectory();
    for (const path of paths) {
        const segments = path.split('/');
        let directory = root;
        for (let index = 0; index < segments.length - 1; index += 1) {
            const name = segments[index]!;
            let child = directory.directories.get(name);
            if (child === undefined) {
                child = createDirectory();
                directory.directories.set(name, child);
            }
            directory = child;
        }
        directory.files.push(segments[segments.length - 1]!);
    }
    return root;
};

const treeRows = (
    directory: TreeDirectory,
    collapsed: ReadonlySet<string>,
    prefix = '',
    depth = 0,
): ReadonlyArray<TreeRow> => {
    const rows: TreeRow[] = [];
    for (const [name, child] of [...directory.directories.entries()].toSorted(
        ([a], [b]) => a.localeCompare(b),
    )) {
        const path = prefix === '' ? name : `${prefix}/${name}`;
        rows.push({ kind: 'directory', depth, name, path });
        if (!collapsed.has(path))
            rows.push(...treeRows(child, collapsed, path, depth + 1));
    }
    for (const name of directory.files.toSorted((a, b) => a.localeCompare(b))) {
        rows.push({
            kind: 'file',
            depth,
            name,
            path: prefix === '' ? name : `${prefix}/${name}`,
        });
    }
    return rows;
};

/** Display-only hierarchy of every tracked path in the selected commit's tree. */
export function CommitTreePanel({
    repoId,
    oid,
}: {
    readonly repoId: RepoId;
    readonly oid: Oid | null;
}) {
    const { data, isLoading, isError } = useCommitTree(repoId, oid);
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const tree = useMemo(() => buildTree(data?.paths ?? []), [data?.paths]);
    const rows = useMemo(() => treeRows(tree, collapsed), [tree, collapsed]);
    const parentRef = useRef<HTMLDivElement>(null);
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => parentRef.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 16,
    });

    if (oid === null)
        return <Placeholder>Select a commit to see its file tree.</Placeholder>;
    if (isLoading) return <Placeholder>Loading file tree…</Placeholder>;
    if (isError || !data)
        return (
            <Placeholder tone="danger">
                Could not load the file tree.
            </Placeholder>
        );
    if (data.paths.length === 0)
        return <Placeholder>This commit has no files.</Placeholder>;

    const toggleDirectory = (path: string) =>
        setCollapsed(previous => {
            const next = new Set(previous);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });

    return (
        <div className="flex h-full flex-col">
            <div className="text-muted-foreground border-b px-2 py-1 text-[11px]">
                {data.paths.length.toLocaleString()} file
                {data.paths.length === 1 ? '' : 's'}
            </div>
            <div
                ref={parentRef}
                className="min-h-0 flex-1 overflow-auto text-xs"
                role="tree"
                aria-label="Files at selected commit"
            >
                <div
                    style={{
                        height: virtualizer.getTotalSize(),
                        position: 'relative',
                        width: '100%',
                    }}
                >
                    {virtualizer.getVirtualItems().map(item => {
                        const row = rows[item.index]!;
                        const paddingLeft = 8 + row.depth * 16;
                        const isDirectory = row.kind === 'directory';
                        return (
                            <div
                                key={`${row.kind}:${row.path}`}
                                className="absolute top-0 left-0 w-full"
                                style={{
                                    height: item.size,
                                    transform: `translateY(${item.start}px)`,
                                }}
                            >
                                {isDirectory ? (
                                    <button
                                        type="button"
                                        role="treeitem"
                                        aria-level={row.depth + 1}
                                        aria-expanded={!collapsed.has(row.path)}
                                        onClick={() =>
                                            toggleDirectory(row.path)
                                        }
                                        style={{ paddingLeft }}
                                        className="hover:bg-accent flex h-full w-full items-center gap-1.5 pr-2 text-left"
                                    >
                                        {collapsed.has(row.path) ? (
                                            <ChevronRight
                                                className="text-muted-foreground size-3 shrink-0"
                                                aria-hidden="true"
                                            />
                                        ) : (
                                            <ChevronDown
                                                className="text-muted-foreground size-3 shrink-0"
                                                aria-hidden="true"
                                            />
                                        )}
                                        <Folder
                                            className="text-muted-foreground size-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                        <span className="truncate">
                                            {row.name}
                                        </span>
                                    </button>
                                ) : (
                                    <div
                                        role="treeitem"
                                        aria-level={row.depth + 1}
                                        style={{ paddingLeft }}
                                        className={cn(
                                            'flex h-full items-center gap-1.5 pr-2',
                                            'text-muted-foreground',
                                        )}
                                    >
                                        <File
                                            className="size-3.5 shrink-0"
                                            aria-hidden="true"
                                        />
                                        <span className="truncate">
                                            {row.name}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
