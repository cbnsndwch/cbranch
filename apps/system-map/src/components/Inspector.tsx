import {
    ArrowDownRight,
    ArrowUpRight,
    Boxes,
    ChevronRight,
    Copy,
    CornerDownRight,
    ExternalLink,
    FileCode2,
    Info,
    Route,
} from 'lucide-react';
import {
    type CSSProperties,
    type KeyboardEvent,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react';

import { evidenceLabel, SOURCE_SNAPSHOT } from '../data';
import type {
    ArchitectureEdge,
    ArchitectureFlow,
    ArchitectureNode,
    ArchitectureScene,
    Citation,
    FlowStep,
    InspectorTarget,
} from '../types';

type InspectorTab = 'purpose' | 'implementation';

const sourceUrl = (source: Citation): string =>
    `https://github.com/cbnsndwch/cbranch/blob/${SOURCE_SNAPSHOT.revision}/${source.path}#L${source.line}`;

function CitationList({
    citations,
}: {
    readonly citations: readonly Citation[];
}) {
    const [copied, setCopied] = useState<string>();

    const copy = (source: Citation) => {
        const value = `${source.path}:${source.line}`;
        void navigator.clipboard?.writeText(value).then(() => {
            setCopied(value);
            window.setTimeout(() => setCopied(undefined), 1200);
        });
    };

    return (
        <div className="citation-list">
            {citations.map(source => {
                const key = `${source.path}:${source.line}`;
                return (
                    <div
                        className="citation-row"
                        key={`${key}:${source.label}`}
                    >
                        <span className="citation-icon">
                            <FileCode2 aria-hidden="true" />
                        </span>
                        <span className="citation-copy">
                            <strong>{source.label}</strong>
                            <code>{key}</code>
                        </span>
                        <button
                            type="button"
                            className="icon-button subtle"
                            aria-label={`Copy citation ${key}`}
                            title={
                                copied === key
                                    ? 'Copied'
                                    : 'Copy local citation'
                            }
                            onClick={() => copy(source)}
                        >
                            <Copy aria-hidden="true" />
                        </button>
                        <a
                            className="icon-button subtle"
                            aria-label={`Open ${key} at source snapshot`}
                            title={`Open at ${SOURCE_SNAPSHOT.label}`}
                            href={sourceUrl(source)}
                            target="_blank"
                            rel="noreferrer"
                        >
                            <ExternalLink aria-hidden="true" />
                        </a>
                    </div>
                );
            })}
        </div>
    );
}

const uniqueCitations = (
    citations: readonly Citation[],
): readonly Citation[] => {
    const seen = new Set<string>();
    return citations.filter(source => {
        const key = `${source.path}:${source.line}:${source.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

interface InspectorProps {
    readonly scene: ArchitectureScene;
    readonly target: InspectorTarget;
    readonly onNodeSelect: (nodeId: string) => void;
    readonly onNodeOpen: (node: ArchitectureNode) => void;
}

export function Inspector({
    scene,
    target,
    onNodeSelect,
    onNodeOpen,
}: InspectorProps) {
    const [tab, setTab] = useState<InspectorTab>('purpose');
    const purposeTab = useRef<HTMLButtonElement>(null);
    const implementationTab = useRef<HTMLButtonElement>(null);
    const purposeTabId = useId();
    const implementationTabId = useId();
    const panelId = useId();

    useEffect(() => setTab('purpose'), [target]);

    const resolved = useMemo(() => {
        if (target.kind === 'node') {
            const node = scene.nodes.find(
                candidate => candidate.id === target.nodeId,
            );
            if (node === undefined) return undefined;
            return { kind: 'node' as const, node };
        }
        const flow = scene.flows.find(
            candidate => candidate.id === target.flowId,
        );
        const step = flow?.steps[target.stepIndex];
        if (flow === undefined || step === undefined) return undefined;
        const edge = scene.edges.find(
            candidate => candidate.id === step.edgeId,
        );
        if (edge === undefined) return undefined;
        return { kind: 'packet' as const, flow, step, edge };
    }, [scene, target]);

    if (resolved === undefined) return null;

    const changeTab = (next: InspectorTab, focus = false) => {
        setTab(next);
        if (focus)
            (next === 'purpose'
                ? purposeTab
                : implementationTab
            ).current?.focus();
    };

    const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
        const next =
            event.key === 'ArrowRight' || event.key === 'End'
                ? 'implementation'
                : event.key === 'ArrowLeft' || event.key === 'Home'
                  ? 'purpose'
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        changeTab(next, true);
    };

    return (
        <aside className="inspector-panel" aria-label="System inspector">
            <div className="inspector-topline">
                <span className="panel-kicker">Inspector</span>
                <span className="snapshot-mini">{SOURCE_SNAPSHOT.label}</span>
            </div>

            {resolved.kind === 'node' ? (
                <NodeHeader node={resolved.node} />
            ) : (
                <PacketHeader
                    flow={resolved.flow}
                    stepIndex={target.kind === 'packet' ? target.stepIndex : 0}
                />
            )}

            <div
                className="inspector-tabs"
                role="tablist"
                aria-label="Inspector details"
            >
                <button
                    ref={purposeTab}
                    id={purposeTabId}
                    type="button"
                    role="tab"
                    aria-selected={tab === 'purpose'}
                    aria-controls={panelId}
                    tabIndex={tab === 'purpose' ? 0 : -1}
                    className={tab === 'purpose' ? 'is-active' : ''}
                    onClick={() => changeTab('purpose')}
                    onKeyDown={handleTabKey}
                >
                    What it does
                </button>
                <button
                    ref={implementationTab}
                    id={implementationTabId}
                    type="button"
                    role="tab"
                    aria-selected={tab === 'implementation'}
                    aria-controls={panelId}
                    tabIndex={tab === 'implementation' ? 0 : -1}
                    className={tab === 'implementation' ? 'is-active' : ''}
                    onClick={() => changeTab('implementation')}
                    onKeyDown={handleTabKey}
                >
                    How it’s built
                </button>
            </div>

            <div
                id={panelId}
                className="inspector-scroll"
                role="tabpanel"
                aria-labelledby={
                    tab === 'purpose' ? purposeTabId : implementationTabId
                }
                tabIndex={0}
            >
                {resolved.kind === 'node' ? (
                    tab === 'purpose' ? (
                        <NodePurpose
                            scene={scene}
                            node={resolved.node}
                            onNodeSelect={onNodeSelect}
                            onNodeOpen={onNodeOpen}
                        />
                    ) : (
                        <NodeImplementation node={resolved.node} />
                    )
                ) : tab === 'purpose' ? (
                    <PacketPurpose
                        flow={resolved.flow}
                        step={resolved.step}
                        stepIndex={
                            target.kind === 'packet' ? target.stepIndex : 0
                        }
                    />
                ) : (
                    <PacketImplementation
                        scene={scene}
                        edge={resolved.edge}
                        step={resolved.step}
                        onNodeSelect={onNodeSelect}
                    />
                )}
            </div>
        </aside>
    );
}

function NodeHeader({ node }: { readonly node: ArchitectureNode }) {
    return (
        <header className="inspector-header">
            <div className="inspector-kind-row">
                <span className={`kind-pill kind-${node.kind}`}>
                    {node.kind}
                </span>
                {node.status === 'scaffold' ? (
                    <span className="status-pill scaffold">Scaffold only</span>
                ) : node.status === 'adjacent' ? (
                    <span className="status-pill adjacent">
                        Adjacent tooling
                    </span>
                ) : (
                    <span className="status-pill active">Active runtime</span>
                )}
            </div>
            <h2>{node.label}</h2>
            <p>{node.eyebrow}</p>
        </header>
    );
}

function PacketHeader({
    flow,
    stepIndex,
}: {
    readonly flow: ArchitectureFlow;
    readonly stepIndex: number;
}) {
    const step = flow.steps[stepIndex];
    return (
        <header className="inspector-header packet-header">
            <div className="inspector-kind-row">
                <span
                    className="packet-dot"
                    style={{ '--flow-color': flow.color } as CSSProperties}
                />
                <span className="kind-pill packet">Packet {stepIndex + 1}</span>
            </div>
            <h2>{step.label}</h2>
            <p>{flow.label}</p>
        </header>
    );
}

function NodePurpose({
    scene,
    node,
    onNodeSelect,
    onNodeOpen,
}: {
    readonly scene: ArchitectureScene;
    readonly node: ArchitectureNode;
    readonly onNodeSelect: (nodeId: string) => void;
    readonly onNodeOpen: (node: ArchitectureNode) => void;
}) {
    const inbound = scene.edges.filter(edge => edge.to === node.id);
    const outbound = scene.edges.filter(edge => edge.from === node.id);
    const flowCount = scene.flows.filter(flow =>
        flow.steps.some(step => {
            const edge = scene.edges.find(
                candidate => candidate.id === step.edgeId,
            );
            return edge?.from === node.id || edge?.to === node.id;
        }),
    ).length;

    return (
        <>
            <p className="inspector-lede">{node.description}</p>

            {node.childSceneId !== undefined ? (
                <button
                    type="button"
                    className="drill-button"
                    onClick={() => onNodeOpen(node)}
                >
                    <Boxes aria-hidden="true" />
                    <span>
                        <strong>Explore internals</strong>
                        <small>Open the semantic drill-down map</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                </button>
            ) : null}

            <section className="inspector-section">
                <h3>Responsibilities</h3>
                <ul className="responsibility-list">
                    {node.responsibilities.map(item => (
                        <li key={item}>{item}</li>
                    ))}
                </ul>
            </section>

            <section className="inspector-section">
                <h3>Connected here</h3>
                <div className="metric-row">
                    <span>
                        <strong>{inbound.length}</strong>
                        <small>inbound</small>
                    </span>
                    <span>
                        <strong>{outbound.length}</strong>
                        <small>outbound</small>
                    </span>
                    <span>
                        <strong>{flowCount}</strong>
                        <small>traces</small>
                    </span>
                </div>
                <ConnectionList
                    scene={scene}
                    inbound={inbound}
                    outbound={outbound}
                    onNodeSelect={onNodeSelect}
                />
            </section>
        </>
    );
}

function ConnectionList({
    scene,
    inbound,
    outbound,
    onNodeSelect,
}: {
    readonly scene: ArchitectureScene;
    readonly inbound: readonly ArchitectureEdge[];
    readonly outbound: readonly ArchitectureEdge[];
    readonly onNodeSelect: (nodeId: string) => void;
}) {
    return (
        <div className="connection-list">
            {[
                ...inbound.map(edge => ({ edge, direction: 'in' as const })),
                ...outbound.map(edge => ({ edge, direction: 'out' as const })),
            ].map(({ edge, direction }) => {
                const otherId = direction === 'in' ? edge.from : edge.to;
                const other = scene.nodes.find(
                    candidate => candidate.id === otherId,
                );
                if (other === undefined) return null;
                return (
                    <button
                        type="button"
                        key={`${direction}:${edge.id}`}
                        onClick={() => onNodeSelect(other.id)}
                    >
                        {direction === 'in' ? (
                            <ArrowDownRight aria-hidden="true" />
                        ) : (
                            <ArrowUpRight aria-hidden="true" />
                        )}
                        <span>
                            <strong>{other.label}</strong>
                            <small>{edge.label}</small>
                        </span>
                    </button>
                );
            })}
            {inbound.length + outbound.length === 0 ? (
                <p className="muted-copy">No runtime edges in this scene.</p>
            ) : null}
        </div>
    );
}

function NodeImplementation({ node }: { readonly node: ArchitectureNode }) {
    return (
        <>
            <section className="inspector-section flush-top">
                <h3>Building blocks</h3>
                <div className="technology-list">
                    {node.builtWith.map(item => (
                        <span key={item}>{item}</span>
                    ))}
                </div>
            </section>
            <section className="inspector-section">
                <div className="section-title-row">
                    <h3>Source evidence</h3>
                    <span>{node.citations.length}</span>
                </div>
                <p className="section-note">
                    Citations are pinned to {SOURCE_SNAPSHOT.label}; copy paths
                    for local inspection or open the exact revision.
                </p>
                <CitationList citations={node.citations} />
            </section>
        </>
    );
}

function PacketPurpose({
    flow,
    step,
    stepIndex,
}: {
    readonly flow: ArchitectureFlow;
    readonly step: ArchitectureFlow['steps'][number];
    readonly stepIndex: number;
}) {
    return (
        <>
            <div className="packet-progress-card">
                <div>
                    <span>Hop</span>
                    <strong>
                        {stepIndex + 1} / {flow.steps.length}
                    </strong>
                </div>
                <div className="packet-progress-track">
                    <span
                        style={{
                            width: `${((stepIndex + 1) / flow.steps.length) * 100}%`,
                            background: flow.color,
                        }}
                    />
                </div>
            </div>
            <p className="inspector-lede">{step.detail}</p>
            {step.phaseBreak === undefined ? null : (
                <div className="phase-callout">
                    <CornerDownRight aria-hidden="true" />
                    <span>
                        <strong>New trace phase</strong>
                        <small>{step.phaseBreak}</small>
                    </span>
                </div>
            )}
            <div className="evidence-callout">
                <Info aria-hidden="true" />
                <span>
                    <strong>{evidenceLabel[step.evidence]}</strong>
                    <small>
                        This snippet is derived from source evidence. It is not
                        captured runtime telemetry.
                    </small>
                </span>
            </div>
            <section className="inspector-section">
                <h3>Representative payload</h3>
                <pre className="payload-code">
                    <code>{step.payload}</code>
                </pre>
            </section>
            <section className="inspector-section">
                <h3>Flow context</h3>
                <p className="section-note">{flow.summary}</p>
            </section>
        </>
    );
}

function PacketImplementation({
    scene,
    edge,
    step,
    onNodeSelect,
}: {
    readonly scene: ArchitectureScene;
    readonly edge: ArchitectureEdge;
    readonly step: FlowStep;
    readonly onNodeSelect: (nodeId: string) => void;
}) {
    const fromId = step.direction === 'reverse' ? edge.to : edge.from;
    const toId = step.direction === 'reverse' ? edge.from : edge.to;
    const from = scene.nodes.find(node => node.id === fromId);
    const to = scene.nodes.find(node => node.id === toId);
    const sources = uniqueCitations(step.citations);

    return (
        <>
            <section className="inspector-section flush-top">
                <h3>Route segment</h3>
                <div className="route-card">
                    <Route aria-hidden="true" />
                    <button type="button" onClick={() => onNodeSelect(fromId)}>
                        {from?.label ?? fromId}
                    </button>
                    <ChevronRight aria-hidden="true" />
                    <button type="button" onClick={() => onNodeSelect(toId)}>
                        {to?.label ?? toId}
                    </button>
                    <span>{edge.kind}</span>
                </div>
                <p className="section-note">{edge.label}</p>
            </section>
            <section className="inspector-section">
                <div className="section-title-row">
                    <h3>Payload evidence</h3>
                    <span>{sources.length}</span>
                </div>
                <CitationList citations={sources} />
            </section>
        </>
    );
}
