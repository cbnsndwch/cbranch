import { LocateFixed, Minus, MousePointer2, Plus } from 'lucide-react';
import {
    type CSSProperties,
    type KeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type WheelEvent,
    useMemo,
    useRef,
    useState,
} from 'react';

import { evidenceLabel } from '../data';
import type {
    ArchitectureEdge,
    ArchitectureFlow,
    ArchitectureNode,
    ArchitectureScene,
    MapTransform,
} from '../types';

const CANVAS_WIDTH = 1120;
const CANVAS_HEIGHT = 660;
const ORIGIN_X = 410;
const ORIGIN_Y = 172;
const TILE_WIDTH = 142;
const TILE_HEIGHT = 70;

interface Point {
    readonly x: number;
    readonly y: number;
}

interface EdgeGeometry {
    readonly start: Point;
    readonly control: Point;
    readonly end: Point;
    readonly path: string;
}

const project = (node: ArchitectureNode): Point => ({
    x: ORIGIN_X + (node.position.column - node.position.row) * (TILE_WIDTH / 2),
    y:
        ORIGIN_Y +
        (node.position.column + node.position.row) * (TILE_HEIGHT / 2),
});

const anchor = (node: ArchitectureNode): Point => {
    const point = project(node);
    return { x: point.x, y: point.y - node.height * 0.48 };
};

const edgeGeometry = (
    scene: ArchitectureScene,
    edge: ArchitectureEdge,
): EdgeGeometry => {
    const from = scene.nodes.find(node => node.id === edge.from);
    const to = scene.nodes.find(node => node.id === edge.to);
    if (from === undefined || to === undefined)
        throw new Error(`Edge ${edge.id} references a missing node.`);

    const start = anchor(from);
    const end = anchor(to);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(Math.hypot(dx, dy), 1);
    const defaultBend = edge.kind === 'dependency' ? -18 : 0;
    const bend = edge.bend ?? defaultBend;
    const control = {
        x: (start.x + end.x) / 2 + (-dy / length) * bend,
        y: (start.y + end.y) / 2 + (dx / length) * bend,
    };
    return {
        start,
        control,
        end,
        path: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
    };
};

const quadraticPoint = (geometry: EdgeGeometry, rawProgress: number): Point => {
    const progress = Math.min(1, Math.max(0, rawProgress));
    const inverse = 1 - progress;
    return {
        x:
            inverse * inverse * geometry.start.x +
            2 * inverse * progress * geometry.control.x +
            progress * progress * geometry.end.x,
        y:
            inverse * inverse * geometry.start.y +
            2 * inverse * progress * geometry.control.y +
            progress * progress * geometry.end.y,
    };
};

interface IsometricMapProps {
    readonly scene: ArchitectureScene;
    readonly selectedNodeId: string | undefined;
    readonly matchedNodeIds: ReadonlySet<string>;
    readonly hasSearch: boolean;
    readonly activeFlow: ArchitectureFlow;
    readonly stepIndex: number;
    readonly stepProgress: number;
    readonly playing: boolean;
    readonly transform: MapTransform;
    readonly onTransformChange: (next: MapTransform) => void;
    readonly onNodeSelect: (nodeId: string) => void;
    readonly onNodeOpen: (node: ArchitectureNode) => void;
    readonly onPacketSelect: (flowId: string, stepIndex: number) => void;
    readonly onResetTransform: () => void;
}

export function IsometricMap({
    scene,
    selectedNodeId,
    matchedNodeIds,
    hasSearch,
    activeFlow,
    stepIndex,
    stepProgress,
    playing,
    transform,
    onTransformChange,
    onNodeSelect,
    onNodeOpen,
    onPacketSelect,
    onResetTransform,
}: IsometricMapProps) {
    const [hoveredNodeId, setHoveredNodeId] = useState<string>();
    const [panning, setPanning] = useState(false);
    const pan = useRef<
        | {
              readonly pointerId: number;
              readonly startX: number;
              readonly startY: number;
              readonly transform: MapTransform;
          }
        | undefined
    >(undefined);

    const geometries = useMemo(
        () =>
            new Map(
                scene.edges.map(edge => [edge.id, edgeGeometry(scene, edge)]),
            ),
        [scene],
    );
    const activeEdgeIds = useMemo(
        () => new Set(activeFlow.steps.map(step => step.edgeId)),
        [activeFlow],
    );
    const currentStep = activeFlow.steps[stepIndex];
    const currentGeometry = geometries.get(currentStep.edgeId);
    const packetProgress =
        currentStep.direction === 'reverse' ? 1 - stepProgress : stepProgress;
    const packetPoint =
        currentGeometry === undefined
            ? { x: 0, y: 0 }
            : quadraticPoint(currentGeometry, packetProgress);
    const hoveredNode = scene.nodes.find(node => node.id === hoveredNodeId);

    const beginPan = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (event.button !== 0) return;
        pan.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            transform,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setPanning(true);
    };

    const movePan = (event: ReactPointerEvent<SVGSVGElement>) => {
        const start = pan.current;
        if (start === undefined || start.pointerId !== event.pointerId) return;
        const svg = event.currentTarget.getBoundingClientRect();
        const unitX = CANVAS_WIDTH / Math.max(svg.width, 1);
        const unitY = CANVAS_HEIGHT / Math.max(svg.height, 1);
        onTransformChange({
            ...start.transform,
            x:
                start.transform.x +
                ((event.clientX - start.startX) * unitX) /
                    start.transform.scale,
            y:
                start.transform.y +
                ((event.clientY - start.startY) * unitY) /
                    start.transform.scale,
        });
    };

    const endPan = (event: ReactPointerEvent<SVGSVGElement>) => {
        if (pan.current?.pointerId !== event.pointerId) return;
        pan.current = undefined;
        setPanning(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
    };

    const zoom = (factor: number) =>
        onTransformChange({
            ...transform,
            scale: Math.min(1.8, Math.max(0.62, transform.scale * factor)),
        });

    const wheel = (event: WheelEvent<SVGSVGElement>) => {
        event.preventDefault();
        zoom(event.deltaY > 0 ? 0.92 : 1.08);
    };

    return (
        <section className="map-stage" aria-label="Architecture map canvas">
            <div className="map-context-bar">
                <div className="map-context-copy">
                    <div className="map-state-badges">
                        <span
                            className={`play-state${playing ? ' is-playing' : ''}`}
                        >
                            <span />
                            {playing ? 'Flow moving' : 'Flow paused'}
                        </span>
                        {currentStep.phaseBreak === undefined ? null : (
                            <span
                                className="phase-badge"
                                title={currentStep.phaseBreak}
                            >
                                New phase
                            </span>
                        )}
                    </div>
                    <strong>{activeFlow.label}</strong>
                    <small>{activeFlow.summary}</small>
                </div>
                <div className="map-step-count">
                    <span>{String(stepIndex + 1).padStart(2, '0')}</span>
                    <small>
                        / {String(activeFlow.steps.length).padStart(2, '0')}
                    </small>
                </div>
            </div>

            <p id="map-instructions" className="sr-only">
                {scene.description} Select a building to inspect it. Press Arrow
                Right on a building with a drill marker to explore it. Drag to
                pan and use the labeled controls to zoom.
            </p>

            <svg
                className={`isometric-canvas${panning ? ' is-panning' : ''}`}
                viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`}
                role="group"
                aria-label={`Isometric map: ${scene.label}`}
                aria-describedby="map-instructions"
                onPointerDown={beginPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                onWheel={wheel}
            >
                <defs>
                    <linearGradient
                        id="packet-body"
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="1"
                    >
                        <stop
                            offset="0"
                            stopColor="#ffffff"
                            stopOpacity="0.96"
                        />
                        <stop
                            offset="1"
                            stopColor="#cbd4dc"
                            stopOpacity="0.9"
                        />
                    </linearGradient>
                    <filter
                        id="building-shadow"
                        x="-80%"
                        y="-80%"
                        width="260%"
                        height="260%"
                    >
                        <feDropShadow
                            dx="0"
                            dy="10"
                            stdDeviation="9"
                            floodColor="#000000"
                            floodOpacity="0.42"
                        />
                    </filter>
                    <filter
                        id="selection-glow"
                        x="-100%"
                        y="-100%"
                        width="300%"
                        height="300%"
                    >
                        <feDropShadow
                            dx="0"
                            dy="0"
                            stdDeviation="7"
                            floodColor="#65e6d3"
                            floodOpacity="0.68"
                        />
                    </filter>
                    {[
                        'call',
                        'dependency',
                        'filesystem',
                        'network',
                        'rpc',
                        'spawn',
                        'stream',
                    ].map(kind => (
                        <marker
                            key={kind}
                            id={`arrow-${kind}`}
                            viewBox="0 0 10 10"
                            refX="8"
                            refY="5"
                            markerWidth="5"
                            markerHeight="5"
                            orient="auto-start-reverse"
                        >
                            <path d="M 0 0 L 10 5 L 0 10 z" />
                        </marker>
                    ))}
                    <pattern
                        id="micro-grid"
                        width="18"
                        height="18"
                        patternUnits="userSpaceOnUse"
                    >
                        <circle
                            cx="1"
                            cy="1"
                            r="0.75"
                            fill="#8a98a6"
                            opacity="0.14"
                        />
                    </pattern>
                </defs>

                <rect
                    width={CANVAS_WIDTH}
                    height={CANVAS_HEIGHT}
                    fill="url(#micro-grid)"
                />

                <g
                    className="map-world"
                    transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}
                >
                    <Grid />
                    <g className="connection-layer">
                        {scene.edges.map(edge => {
                            const geometry = geometries.get(edge.id)!;
                            const active = activeEdgeIds.has(edge.id);
                            const current = currentStep.edgeId === edge.id;
                            const labelPoint = quadraticPoint(geometry, 0.5);
                            return (
                                <g
                                    key={edge.id}
                                    className={`connection edge-${edge.kind}${
                                        active ? ' is-flow-edge' : ''
                                    }${current ? ' is-current-edge' : ''}`}
                                >
                                    <path
                                        className="connection-hit"
                                        d={geometry.path}
                                    >
                                        <title>{edge.label}</title>
                                    </path>
                                    <path
                                        className="connection-path"
                                        d={geometry.path}
                                        markerEnd={`url(#arrow-${edge.kind})`}
                                        markerStart={
                                            edge.bidirectional
                                                ? `url(#arrow-${edge.kind})`
                                                : undefined
                                        }
                                    />
                                    <g
                                        className="connection-label"
                                        transform={`translate(${labelPoint.x} ${labelPoint.y})`}
                                    >
                                        <rect
                                            x={
                                                -Math.min(
                                                    edge.label.length * 3.3 + 9,
                                                    78,
                                                )
                                            }
                                            y="-8"
                                            width={Math.min(
                                                edge.label.length * 6.6 + 18,
                                                156,
                                            )}
                                            height="16"
                                            rx="5"
                                        />
                                        <text
                                            textAnchor="middle"
                                            dominantBaseline="central"
                                        >
                                            {edge.label}
                                        </text>
                                    </g>
                                </g>
                            );
                        })}
                    </g>

                    <g className="building-layer">
                        {[...scene.nodes]
                            .toSorted((left, right) => {
                                const leftPoint = project(left);
                                const rightPoint = project(right);
                                return leftPoint.y - rightPoint.y;
                            })
                            .map(node => (
                                <Building
                                    key={node.id}
                                    node={node}
                                    selected={node.id === selectedNodeId}
                                    dimmed={
                                        hasSearch &&
                                        !matchedNodeIds.has(node.id)
                                    }
                                    onSelect={() => onNodeSelect(node.id)}
                                    onOpen={() => onNodeOpen(node)}
                                    onHover={setHoveredNodeId}
                                />
                            ))}
                    </g>

                    {currentGeometry === undefined ? null : (
                        <g
                            className={`flow-packet${playing ? ' is-moving' : ''}`}
                            transform={`translate(${packetPoint.x} ${packetPoint.y})`}
                            role="button"
                            tabIndex={0}
                            aria-label={`Inspect packet: ${currentStep.label}`}
                            onPointerDown={event => event.stopPropagation()}
                            onClick={event => {
                                event.stopPropagation();
                                onPacketSelect(activeFlow.id, stepIndex);
                            }}
                            onKeyDown={event => {
                                if (
                                    event.key === 'Enter' ||
                                    event.key === ' '
                                ) {
                                    event.preventDefault();
                                    onPacketSelect(activeFlow.id, stepIndex);
                                }
                            }}
                            style={
                                {
                                    '--flow-color': activeFlow.color,
                                    '--packet-opacity':
                                        currentStep.phaseBreak === undefined
                                            ? 1
                                            : Math.min(1, stepProgress / 0.16),
                                } as CSSProperties
                            }
                        >
                            <circle className="packet-halo" r="18" />
                            <rect
                                className="packet-shell"
                                x="-13"
                                y="-8"
                                width="26"
                                height="16"
                                rx="6"
                            />
                            <path
                                className="packet-signal"
                                d="M -6 -2 H 6 M -6 3 H 2"
                            />
                            <text x="18" y="4">
                                {stepIndex + 1}
                            </text>
                            <title>
                                {currentStep.label} —{' '}
                                {evidenceLabel[currentStep.evidence]}
                            </title>
                        </g>
                    )}
                </g>
            </svg>

            <div className="map-tools" aria-label="Map zoom controls">
                <button
                    type="button"
                    aria-label="Zoom in"
                    title="Zoom in"
                    onClick={() => zoom(1.14)}
                >
                    <Plus aria-hidden="true" />
                </button>
                <span
                    aria-label={`Map zoom ${Math.round(transform.scale * 100)}%`}
                >
                    {Math.round(transform.scale * 100)}%
                </span>
                <button
                    type="button"
                    aria-label="Zoom out"
                    title="Zoom out"
                    onClick={() => zoom(0.88)}
                >
                    <Minus aria-hidden="true" />
                </button>
                <button
                    type="button"
                    aria-label="Center map"
                    title="Center map"
                    onClick={onResetTransform}
                >
                    <LocateFixed aria-hidden="true" />
                </button>
            </div>

            <div className="pan-hint">
                <MousePointer2 aria-hidden="true" />
                Drag to pan · scroll to zoom · double-click to drill in
            </div>

            {hoveredNode === undefined ? null : (
                <div className="hover-description" role="status">
                    <span>{hoveredNode.kind}</span>
                    <strong>{hoveredNode.label}</strong>
                    <p>{hoveredNode.summary}</p>
                    {hoveredNode.childSceneId === undefined ? null : (
                        <small>Double-click to explore internals</small>
                    )}
                </div>
            )}
        </section>
    );
}

function Grid() {
    const tiles: React.ReactNode[] = [];
    for (let row = -1; row <= 6; row += 1) {
        for (let column = -1; column <= 9; column += 1) {
            const point = {
                x: ORIGIN_X + (column - row) * (TILE_WIDTH / 2),
                y: ORIGIN_Y + (column + row) * (TILE_HEIGHT / 2),
            };
            tiles.push(
                <polygon
                    key={`${column}:${row}`}
                    className="grid-tile"
                    points={`${point.x},${point.y - TILE_HEIGHT / 2} ${
                        point.x + TILE_WIDTH / 2
                    },${point.y} ${point.x},${point.y + TILE_HEIGHT / 2} ${
                        point.x - TILE_WIDTH / 2
                    },${point.y}`}
                />,
            );
        }
    }
    return <g className="grid-layer">{tiles}</g>;
}

function Building({
    node,
    selected,
    dimmed,
    onSelect,
    onOpen,
    onHover,
}: {
    readonly node: ArchitectureNode;
    readonly selected: boolean;
    readonly dimmed: boolean;
    readonly onSelect: () => void;
    readonly onOpen: () => void;
    readonly onHover: (nodeId: string | undefined) => void;
}) {
    const point = project(node);
    const keyDown = (event: KeyboardEvent<SVGGElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
        }
        if (event.key === 'ArrowRight' && node.childSceneId !== undefined) {
            event.preventDefault();
            onOpen();
        }
    };

    return (
        <g
            transform={`translate(${point.x} ${point.y})`}
            className={`building building-${node.kind}${
                selected ? ' is-selected' : ''
            }${dimmed ? ' is-dimmed' : ''}${
                node.status === 'scaffold' ? ' is-scaffold' : ''
            }`}
            role="button"
            tabIndex={0}
            aria-label={`${node.label}, ${node.kind}`}
            aria-pressed={selected}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
                event.stopPropagation();
                onSelect();
            }}
            onDoubleClick={event => {
                event.stopPropagation();
                onOpen();
            }}
            onKeyDown={keyDown}
            onMouseEnter={() => onHover(node.id)}
            onMouseLeave={() => onHover(undefined)}
            onFocus={() => onHover(node.id)}
            onBlur={() => onHover(undefined)}
        >
            <ellipse
                className="building-ground-shadow"
                cx="0"
                cy="8"
                rx="58"
                ry="25"
            />
            <polygon
                className="building-pad"
                points={`0,-37 75,0 0,37 -75,0`}
            />
            <BuildingShape node={node} />
            {node.childSceneId === undefined ? null : (
                <g className="drill-marker" transform="translate(49 -17)">
                    <circle r="12" />
                    <path d="M -4 0 H 4 M 1 -4 L 5 0 L 1 4" />
                </g>
            )}
            <foreignObject
                className="building-label-object"
                x="-78"
                y="16"
                width="156"
                height="64"
                aria-hidden="true"
            >
                <div className="building-label">
                    <strong>{node.label}</strong>
                    <span>{node.eyebrow}</span>
                </div>
            </foreignObject>
        </g>
    );
}

function BuildingShape({ node }: { readonly node: ArchitectureNode }) {
    if (node.kind === 'database') return <DatabaseShape node={node} />;
    if (node.kind === 'contract') return <ContractShape node={node} />;

    const width = node.width ?? 92;
    const depth = node.depth ?? 56;
    const height = node.height;
    const top = `0,${-height - depth / 2} ${width / 2},${-height} 0,${
        -height + depth / 2
    } ${-width / 2},${-height}`;
    const left = `${-width / 2},${-height} 0,${
        -height + depth / 2
    } 0,${depth / 2} ${-width / 2},0`;
    const right = `0,${-height + depth / 2} ${width / 2},${-height} ${width / 2},0 0,${depth / 2}`;

    return (
        <g className="building-volume" filter="url(#building-shadow)">
            <polygon className="face-left" points={left} />
            <polygon className="face-right" points={right} />
            <polygon className="face-top" points={top} />
            <ShapeDecoration node={node} width={width} depth={depth} />
        </g>
    );
}

function DatabaseShape({ node }: { readonly node: ArchitectureNode }) {
    const width = node.width ?? 106;
    const depth = node.depth ?? 60;
    const height = node.height;
    return (
        <g
            className="building-volume database-volume"
            filter="url(#building-shadow)"
        >
            <path
                className="database-body"
                d={`M ${-width / 2} ${-height} V 0 C ${-width / 2} ${
                    depth / 2
                }, ${width / 2} ${depth / 2}, ${width / 2} 0 V ${-height} Z`}
            />
            <ellipse
                className="database-rim"
                cx="0"
                cy={-height}
                rx={width / 2}
                ry={depth / 3}
            />
            <ellipse
                className="database-core"
                cx="0"
                cy={-height}
                rx={width / 2 - 8}
                ry={depth / 3 - 5}
            />
            <path
                className="database-band"
                d={`M ${-width / 2} ${-height * 0.58} C ${-width / 2} ${
                    -height * 0.38
                }, ${width / 2} ${-height * 0.38}, ${width / 2} ${
                    -height * 0.58
                }`}
            />
        </g>
    );
}

function ContractShape({ node }: { readonly node: ArchitectureNode }) {
    const width = node.width ?? 94;
    const depth = node.depth ?? 58;
    const height = node.height;
    return (
        <g
            className="building-volume contract-volume"
            filter="url(#building-shadow)"
        >
            {[0, 8, 16].map(offset => (
                <g key={offset} transform={`translate(0 ${-offset})`}>
                    <polygon
                        className="contract-sheet-side"
                        points={`${-width / 2},${-height + depth / 3} 0,${
                            -height + (2 * depth) / 3
                        } ${width / 2},${-height + depth / 3} 0,${
                            -height + depth
                        }`}
                    />
                    <polygon
                        className="contract-sheet"
                        points={`0,${-height} ${width / 2},${
                            -height + depth / 3
                        } 0,${-height + (2 * depth) / 3} ${-width / 2},${
                            -height + depth / 3
                        }`}
                    />
                </g>
            ))}
            <path
                className="contract-glyph"
                d={`M -20 ${-height + 7} L -8 ${-height + 14} M 20 ${
                    -height + 20
                } L 8 ${-height + 27}`}
            />
        </g>
    );
}

function ShapeDecoration({
    node,
    width,
    depth,
}: {
    readonly node: ArchitectureNode;
    readonly width: number;
    readonly depth: number;
}) {
    const height = node.height;
    switch (node.kind) {
        case 'client':
        case 'app':
            return (
                <>
                    <polygon
                        className="screen-panel"
                        points={`${-width / 2 + 9},${-height + 15} -8,${
                            -height + depth / 2 + 12
                        } -8,${depth / 2 - 12} ${-width / 2 + 9},-18`}
                    />
                    <path
                        className="screen-line"
                        d={`M ${-width / 2 + 16} ${-height + 28} L -15 ${
                            -height + depth / 2 + 24
                        } M ${-width / 2 + 16} ${-height + 39} L -22 ${
                            -height + depth / 2 + 35
                        }`}
                    />
                </>
            );
        case 'service':
            return (
                <>
                    <polygon
                        className="roof-unit"
                        points={`0,${-height - depth / 2 - 15} 20,${
                            -height - depth / 2 - 5
                        } 0,${-height - depth / 2 + 5} -20,${
                            -height - depth / 2 - 5
                        }`}
                    />
                    <path
                        className="service-windows"
                        d={`M 12 ${-height + depth / 2 + 15} L ${
                            width / 2 - 10
                        } ${-height + 2} M 12 ${-height + depth / 2 + 30} L ${
                            width / 2 - 10
                        } ${-height + 17} M 12 ${-height + depth / 2 + 45} L ${
                            width / 2 - 10
                        } ${-height + 32}`}
                    />
                </>
            );
        case 'worker':
            return (
                <>
                    <line
                        className="worker-antenna"
                        x1="0"
                        y1={-height - depth / 2}
                        x2="0"
                        y2={-height - depth / 2 - 24}
                    />
                    <circle
                        className="worker-signal"
                        cx="0"
                        cy={-height - depth / 2 - 27}
                        r="5"
                    />
                    <circle
                        className="worker-wheel"
                        cx={width / 4}
                        cy={-height / 2 + 4}
                        r="11"
                    />
                    <path
                        className="worker-spokes"
                        d={`M ${width / 4 - 8} ${-height / 2 + 4} H ${
                            width / 4 + 8
                        } M ${width / 4} ${-height / 2 - 4} V ${
                            -height / 2 + 12
                        }`}
                    />
                </>
            );
        case 'queue':
            return (
                <>
                    {[0, 16, 32].map(offset => (
                        <path
                            key={offset}
                            className="queue-track"
                            d={`M ${-width / 2 + 10} ${-height + 18 + offset} L -7 ${
                                -height + depth / 2 + 18 + offset
                            }`}
                        />
                    ))}
                    <circle
                        className="queue-dot"
                        cx={width / 4}
                        cy={-height / 2}
                        r="7"
                    />
                </>
            );
        case 'external':
            return (
                <>
                    <ellipse
                        className="external-dome"
                        cx="0"
                        cy={-height - depth / 2}
                        rx="24"
                        ry="12"
                    />
                    <path
                        className="external-signal"
                        d={`M -19 ${-height - depth / 2} Q 0 ${
                            -height - depth / 2 - 18
                        } 19 ${-height - depth / 2}`}
                    />
                </>
            );
        case 'storage':
            return (
                <path
                    className="storage-bands"
                    d={`M ${-width / 2 + 4} ${-height + 18} L 0 ${
                        -height + depth / 2 + 18
                    } L ${width / 2 - 4} ${-height + 18} M ${
                        -width / 2 + 4
                    } ${-height + 31} L 0 ${-height + depth / 2 + 31} L ${
                        width / 2 - 4
                    } ${-height + 31}`}
                />
            );
        case 'package':
            return (
                <>
                    <path
                        className="package-brackets"
                        d={`M ${-width / 2 + 11} ${-height + 18} v 15 M ${
                            -width / 2 + 11
                        } ${-height + 18} l 12 6 M ${width / 2 - 11} ${
                            -height + 18
                        } v 15 M ${width / 2 - 11} ${-height + 18} l -12 6`}
                    />
                    <polygon
                        className="package-seam"
                        points={`0,${-height - depth / 2} 0,${-height + depth / 2} 0,${
                            depth / 2
                        }`}
                    />
                </>
            );
        default:
            return null;
    }
}
