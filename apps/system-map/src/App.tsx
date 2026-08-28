import {
    ArrowLeft,
    ChevronRight,
    GitBranch,
    Pause,
    Play,
    RotateCcw,
    ShieldCheck,
    StepForward,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Inspector } from './components/Inspector';
import { IsometricMap } from './components/IsometricMap';
import { OutlineSidebar } from './components/OutlineSidebar';
import { requireScene, SOURCE_SNAPSHOT } from './data';
import type {
    ArchitectureFlow,
    ArchitectureNode,
    InspectorTarget,
    MapTransform,
} from './types';

const DEFAULT_TRANSFORM: MapTransform = { x: 0, y: 0, scale: 1 };
const FLOW_HOP_MS = 2_250;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const systemPrefersReducedMotion = (): boolean =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches;

interface Playback {
    readonly step: number;
    readonly progress: number;
}

const matchesQuery = (node: ArchitectureNode, query: string): boolean => {
    if (query === '') return true;
    return [
        node.label,
        node.eyebrow,
        node.kind,
        node.group,
        node.summary,
        node.description,
        ...node.builtWith,
        ...node.citations.flatMap(source => [source.path, source.label]),
    ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query);
};

export function App() {
    const [sceneStack, setSceneStack] = useState<readonly string[]>([
        'overview',
    ]);
    const scene = requireScene(sceneStack.at(-1) ?? 'overview');
    const [query, setQuery] = useState('');
    const [target, setTarget] = useState<InspectorTarget>({
        kind: 'node',
        nodeId: scene.defaultNodeId,
    });
    const [activeFlowId, setActiveFlowId] = useState(scene.flows[0].id);
    const [playback, setPlayback] = useState<Playback>({
        step: 0,
        progress: 0.08,
    });
    const [reducedMotion, setReducedMotion] = useState(
        systemPrefersReducedMotion,
    );
    const [playing, setPlaying] = useState(() => !systemPrefersReducedMotion());
    const [transform, setTransform] = useState<MapTransform>(DEFAULT_TRANSFORM);

    const activeFlow =
        scene.flows.find(flow => flow.id === activeFlowId) ?? scene.flows[0];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchedNodeIds = useMemo(
        () =>
            new Set(
                scene.nodes
                    .filter(node => matchesQuery(node, normalizedQuery))
                    .map(node => node.id),
            ),
        [normalizedQuery, scene],
    );

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const preference = window.matchMedia(REDUCED_MOTION_QUERY);
        const update = () => {
            setReducedMotion(preference.matches);
            if (preference.matches) setPlaying(false);
        };
        update();
        preference.addEventListener('change', update);
        return () => preference.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        if (!playing) return;
        let animationFrame = 0;
        let previous = performance.now();
        const tick = (now: number) => {
            const elapsed = Math.min(now - previous, 80);
            previous = now;
            setPlayback(current => {
                const nextProgress = current.progress + elapsed / FLOW_HOP_MS;
                if (nextProgress < 1)
                    return { ...current, progress: nextProgress };
                return {
                    step: (current.step + 1) % activeFlow.steps.length,
                    progress: nextProgress - 1,
                };
            });
            animationFrame = requestAnimationFrame(tick);
        };
        animationFrame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animationFrame);
    }, [activeFlow.steps.length, playing]);

    useEffect(() => {
        if (
            target.kind === 'packet' &&
            target.flowId === activeFlow.id &&
            target.stepIndex !== playback.step
        ) {
            setTarget({
                kind: 'packet',
                flowId: activeFlow.id,
                stepIndex: playback.step,
            });
        }
    }, [activeFlow.id, playback.step, target]);

    const prepareScene = (sceneId: string) => {
        const next = requireScene(sceneId);
        setQuery('');
        setTarget({ kind: 'node', nodeId: next.defaultNodeId });
        setActiveFlowId(next.flows[0].id);
        setPlayback({ step: 0, progress: 0.08 });
        setPlaying(!reducedMotion);
        setTransform(DEFAULT_TRANSFORM);
    };

    const openNode = (node: ArchitectureNode) => {
        if (node.childSceneId === undefined) {
            setTarget({ kind: 'node', nodeId: node.id });
            return;
        }
        const destination = node.childSceneId;
        if (destination === scene.id) return;
        setSceneStack(current => [...current, destination]);
        prepareScene(destination);
    };

    const navigateToCrumb = (index: number) => {
        const sceneId = sceneStack[index];
        if (sceneId === undefined || index === sceneStack.length - 1) return;
        setSceneStack(sceneStack.slice(0, index + 1));
        prepareScene(sceneId);
    };

    const goBack = () => {
        if (sceneStack.length <= 1) return;
        const nextStack = sceneStack.slice(0, -1);
        const sceneId = nextStack.at(-1) ?? 'overview';
        setSceneStack(nextStack);
        prepareScene(sceneId);
    };

    const selectFlow = (flow: ArchitectureFlow) => {
        setActiveFlowId(flow.id);
        setPlayback({ step: 0, progress: 0.08 });
        setPlaying(!reducedMotion);
        setTarget({ kind: 'packet', flowId: flow.id, stepIndex: 0 });
    };

    const inspectPacket = (flowId: string, stepIndex: number) => {
        setPlaying(false);
        setTarget({ kind: 'packet', flowId, stepIndex });
    };

    const traceOneStep = () => {
        setPlaying(false);
        const nextStep = (playback.step + 1) % activeFlow.steps.length;
        setPlayback({ step: nextStep, progress: 0.94 });
        setTarget({
            kind: 'packet',
            flowId: activeFlow.id,
            stepIndex: nextStep,
        });
    };

    const resumeFlow = () => {
        if (playback.progress >= 0.94) {
            const nextStep = (playback.step + 1) % activeFlow.steps.length;
            setPlayback({ step: nextStep, progress: 0.02 });
            if (target.kind === 'packet')
                setTarget({
                    kind: 'packet',
                    flowId: activeFlow.id,
                    stepIndex: nextStep,
                });
        }
        setPlaying(true);
    };

    const resetView = () => {
        setTransform(DEFAULT_TRANSFORM);
        setQuery('');
        setTarget({ kind: 'node', nodeId: scene.defaultNodeId });
        setActiveFlowId(scene.flows[0].id);
        setPlayback({ step: 0, progress: 0.08 });
        setPlaying(!reducedMotion);
    };

    const selectedNodeId = target.kind === 'node' ? target.nodeId : undefined;

    return (
        <div className="system-map-app">
            <header className="app-header">
                <div className="brand-lockup">
                    <span className="brand-mark" aria-hidden="true">
                        <GitBranch />
                    </span>
                    <span>
                        <strong>cbranch</strong>
                        <small>System atlas</small>
                    </span>
                </div>

                <div className="breadcrumb-block">
                    <button
                        type="button"
                        className="back-button"
                        aria-label="Back to previous system map"
                        disabled={sceneStack.length <= 1}
                        onClick={goBack}
                    >
                        <ArrowLeft aria-hidden="true" />
                    </button>
                    <nav aria-label="Map breadcrumb" className="breadcrumb">
                        {sceneStack.map((sceneId, index) => {
                            const crumb = requireScene(sceneId);
                            const current = index === sceneStack.length - 1;
                            return (
                                <span key={`${sceneId}:${index}`}>
                                    {index === 0 ? null : (
                                        <ChevronRight aria-hidden="true" />
                                    )}
                                    <button
                                        type="button"
                                        aria-current={
                                            current ? 'page' : undefined
                                        }
                                        disabled={current}
                                        onClick={() => navigateToCrumb(index)}
                                    >
                                        {crumb.shortLabel}
                                    </button>
                                </span>
                            );
                        })}
                    </nav>
                    <span className="scene-scope">{scene.scope}</span>
                </div>

                <div className="snapshot-badges">
                    <span className="source-badge">
                        <ShieldCheck aria-hidden="true" />
                        {SOURCE_SNAPSHOT.label}
                    </span>
                    <span className="telemetry-badge">
                        Representative packets · no telemetry
                    </span>
                </div>

                <div className="flow-controls" aria-label="Flow controls">
                    <button type="button" onClick={resumeFlow}>
                        <Play aria-hidden="true" />
                        <span>Resume flow</span>
                    </button>
                    <button type="button" onClick={traceOneStep}>
                        <StepForward aria-hidden="true" />
                        <span>Trace one step</span>
                    </button>
                    <button type="button" onClick={resetView}>
                        <RotateCcw aria-hidden="true" />
                        <span>Reset view</span>
                    </button>
                    <span
                        className={`header-play-indicator${
                            playing ? ' is-playing' : ''
                        }`}
                        aria-label={
                            playing ? 'Flow is moving' : 'Flow is paused'
                        }
                        title={
                            playing
                                ? 'Flow is moving. Click the packet to pause and inspect.'
                                : 'Flow is paused.'
                        }
                    >
                        {playing ? (
                            <Play aria-hidden="true" />
                        ) : (
                            <Pause aria-hidden="true" />
                        )}
                    </span>
                </div>
            </header>

            <OutlineSidebar
                scene={scene}
                query={query}
                selectedNodeId={selectedNodeId}
                activeFlowId={activeFlow.id}
                onQueryChange={setQuery}
                onNodeSelect={nodeId => setTarget({ kind: 'node', nodeId })}
                onNodeOpen={openNode}
                onFlowSelect={selectFlow}
            />

            <main className="map-main">
                <IsometricMap
                    scene={scene}
                    selectedNodeId={selectedNodeId}
                    matchedNodeIds={matchedNodeIds}
                    hasSearch={normalizedQuery !== ''}
                    activeFlow={activeFlow}
                    stepIndex={playback.step}
                    stepProgress={playback.progress}
                    playing={playing}
                    transform={transform}
                    onTransformChange={setTransform}
                    onNodeSelect={nodeId => setTarget({ kind: 'node', nodeId })}
                    onNodeOpen={openNode}
                    onPacketSelect={inspectPacket}
                    onResetTransform={() => setTransform(DEFAULT_TRANSFORM)}
                />
            </main>

            <Inspector
                scene={scene}
                target={target}
                onNodeSelect={nodeId => setTarget({ kind: 'node', nodeId })}
                onNodeOpen={openNode}
            />
        </div>
    );
}
