import type {
    WorkspaceIntelligenceGraphNeighborhood,
    WorkspaceIntelligenceGraphPosition,
} from '@cbranch/rpc-contract';
import {
    Background,
    Controls,
    ReactFlow,
    type Edge,
    type Node,
    useNodesState,
} from '@xyflow/react';
import { useEffect, useMemo } from 'react';

import '@xyflow/react/dist/style.css';

const COLUMN_COUNT = 5;
const X_GAP = 230;
const Y_GAP = 120;
const emptyPositions: ReadonlyArray<WorkspaceIntelligenceGraphPosition> = [];

export const workspaceIntelligenceFlow = (
    neighborhood: WorkspaceIntelligenceGraphNeighborhood,
): {
    readonly nodes: Node[];
    readonly edges: Edge[];
} => {
    const knownNodeIds = new Set(neighborhood.nodes.map(node => node.id));
    return {
        nodes: neighborhood.nodes.map((node, index) => ({
            id: node.id,
            position: {
                x: (index % COLUMN_COUNT) * X_GAP,
                y: Math.floor(index / COLUMN_COUNT) * Y_GAP,
            },
            data: {
                label: `${node.label}\n${node.kind}`,
            },
        })),
        edges: neighborhood.edges
            .filter(
                edge =>
                    knownNodeIds.has(edge.from) && knownNodeIds.has(edge.to),
            )
            .map((edge, index) => ({
                id: `${edge.from}\0${edge.kind}\0${edge.to}\0${index}`,
                source: edge.from,
                target: edge.to,
                label: edge.kind,
                animated: false,
            })),
    };
};

/**
 * Bounded architecture-neighborhood renderer. The host limits this input to a
 * small expansion, so browser rendering never receives the full graph.
 */
export function WorkspaceIntelligenceGraph({
    neighborhood,
    positions = emptyPositions,
    onPositionsChange,
}: {
    readonly neighborhood: WorkspaceIntelligenceGraphNeighborhood;
    readonly positions?: ReadonlyArray<WorkspaceIntelligenceGraphPosition>;
    readonly onPositionsChange?: (
        positions: ReadonlyArray<WorkspaceIntelligenceGraphPosition>,
    ) => void;
}) {
    const graph = useMemo(
        () => workspaceIntelligenceFlow(neighborhood),
        [neighborhood],
    );
    const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
    const positionsByNodeId = useMemo(
        () => new Map(positions.map(position => [position.nodeId, position])),
        [positions],
    );

    useEffect(() => {
        setNodes(
            graph.nodes.map(node => {
                const position = positionsByNodeId.get(node.id);
                return position === undefined
                    ? node
                    : {
                          ...node,
                          position: { x: position.x, y: position.y },
                      };
            }),
        );
    }, [graph.nodes, positionsByNodeId, setNodes]);

    return (
        <div
            className="mt-3 h-96 overflow-hidden rounded-md border"
            aria-label="Architecture graph"
        >
            <ReactFlow
                aria-label="Architecture graph"
                nodes={nodes}
                edges={graph.edges}
                onNodesChange={onNodesChange}
                onNodeDragStop={(_event, node) =>
                    onPositionsChange?.([
                        {
                            nodeId: node.id,
                            x: node.position.x,
                            y: node.position.y,
                        },
                    ])
                }
                fitView
                minZoom={0.2}
                maxZoom={2}
                nodesConnectable={false}
                nodesDraggable
                elementsSelectable
                proOptions={{ hideAttribution: true }}
            >
                <Background gap={16} />
                <Controls showInteractive={false} />
            </ReactFlow>
        </div>
    );
}
