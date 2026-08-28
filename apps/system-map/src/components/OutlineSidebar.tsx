import {
    AppWindow,
    Blocks,
    Box,
    Braces,
    ChevronRight,
    CircleDotDashed,
    Cloud,
    Database,
    HardDrive,
    Network,
    Search,
    Server,
    Workflow,
} from 'lucide-react';
import { useMemo } from 'react';

import type {
    ArchitectureFlow,
    ArchitectureNode,
    ArchitectureScene,
    NodeKind,
} from '../types';

const kindIcon: Readonly<
    Record<NodeKind, React.ComponentType<{ className?: string }>>
> = {
    app: AppWindow,
    client: AppWindow,
    contract: Braces,
    database: Database,
    external: Cloud,
    package: Box,
    queue: CircleDotDashed,
    service: Server,
    storage: HardDrive,
    worker: Blocks,
};

const searchableText = (node: ArchitectureNode): string =>
    [
        node.label,
        node.eyebrow,
        node.group,
        node.kind,
        node.summary,
        node.description,
        ...node.builtWith,
        ...node.citations.flatMap(source => [source.path, source.label]),
    ]
        .join(' ')
        .toLocaleLowerCase();

interface OutlineSidebarProps {
    readonly scene: ArchitectureScene;
    readonly query: string;
    readonly selectedNodeId: string | undefined;
    readonly activeFlowId: string;
    readonly onQueryChange: (value: string) => void;
    readonly onNodeSelect: (nodeId: string) => void;
    readonly onNodeOpen: (node: ArchitectureNode) => void;
    readonly onFlowSelect: (flow: ArchitectureFlow) => void;
}

export function OutlineSidebar({
    scene,
    query,
    selectedNodeId,
    activeFlowId,
    onQueryChange,
    onNodeSelect,
    onNodeOpen,
    onFlowSelect,
}: OutlineSidebarProps) {
    const normalized = query.trim().toLocaleLowerCase();
    const groups = useMemo(() => {
        const result = new Map<string, ArchitectureNode[]>();
        for (const node of scene.nodes) {
            if (normalized !== '' && !searchableText(node).includes(normalized))
                continue;
            const group = result.get(node.group) ?? [];
            group.push(node);
            result.set(node.group, group);
        }
        return result;
    }, [normalized, scene]);

    const resultCount = [...groups.values()].reduce(
        (total, group) => total + group.length,
        0,
    );

    return (
        <aside className="outline-panel" aria-label="System outline">
            <div className="outline-heading">
                <div>
                    <span className="panel-kicker">System outline</span>
                    <h2>{scene.shortLabel}</h2>
                </div>
                <span
                    className="count-badge"
                    aria-label={`${scene.nodes.length} nodes`}
                >
                    {scene.nodes.length}
                </span>
            </div>

            <label className="search-field">
                <Search aria-hidden="true" />
                <span className="sr-only">Search system outline</span>
                <input
                    value={query}
                    onChange={event => onQueryChange(event.target.value)}
                    placeholder="Search nodes or source…"
                />
                {normalized !== '' ? (
                    <span className="search-count">{resultCount}</span>
                ) : null}
            </label>

            <div className="outline-scroll">
                {resultCount === 0 ? (
                    <div className="empty-search">
                        <Search aria-hidden="true" />
                        <strong>No matching system nodes</strong>
                        <span>Try a package, role, or source path.</span>
                    </div>
                ) : (
                    [...groups.entries()].map(([group, nodes]) => (
                        <section className="outline-group" key={group}>
                            <h3>{group}</h3>
                            <div className="outline-items">
                                {nodes.map(node => {
                                    const Icon = kindIcon[node.kind];
                                    const selected = node.id === selectedNodeId;
                                    return (
                                        <button
                                            type="button"
                                            className={`outline-item${
                                                selected ? ' is-selected' : ''
                                            }`}
                                            aria-pressed={selected}
                                            title={node.summary}
                                            key={node.id}
                                            onClick={() =>
                                                onNodeSelect(node.id)
                                            }
                                            onDoubleClick={() =>
                                                onNodeOpen(node)
                                            }
                                        >
                                            <span
                                                className={`kind-icon kind-${node.kind}`}
                                            >
                                                <Icon aria-hidden="true" />
                                            </span>
                                            <span className="outline-item-copy">
                                                <strong>{node.label}</strong>
                                                <small>{node.eyebrow}</small>
                                            </span>
                                            {node.childSceneId !== undefined ? (
                                                <ChevronRight
                                                    className="drill-indicator"
                                                    aria-label="Has drill-down"
                                                />
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        </section>
                    ))
                )}
            </div>

            <section className="flow-outline" aria-labelledby="flow-heading">
                <div className="flow-outline-heading">
                    <div>
                        <span className="panel-kicker">Packet traces</span>
                        <h3 id="flow-heading">Real paths</h3>
                    </div>
                    <Network aria-hidden="true" />
                </div>
                <div className="flow-list">
                    {scene.flows.map((flow, index) => (
                        <button
                            type="button"
                            key={flow.id}
                            aria-pressed={flow.id === activeFlowId}
                            className={`flow-list-item${
                                flow.id === activeFlowId ? ' is-active' : ''
                            }`}
                            onClick={() => onFlowSelect(flow)}
                        >
                            <span
                                className="flow-index"
                                style={
                                    {
                                        '--flow-color': flow.color,
                                    } as React.CSSProperties
                                }
                            >
                                {String(index + 1).padStart(2, '0')}
                            </span>
                            <span>
                                <strong>{flow.shortLabel}</strong>
                                <small>{flow.steps.length} packet hops</small>
                            </span>
                            <Workflow aria-hidden="true" />
                        </button>
                    ))}
                </div>
            </section>
        </aside>
    );
}
