export type NodeKind =
    | 'app'
    | 'client'
    | 'contract'
    | 'database'
    | 'external'
    | 'package'
    | 'queue'
    | 'service'
    | 'storage'
    | 'worker';

export type EdgeKind =
    | 'call'
    | 'dependency'
    | 'filesystem'
    | 'network'
    | 'rpc'
    | 'spawn'
    | 'stream';

export type EvidenceKind =
    | 'implementation-derived'
    | 'schema-derived'
    | 'test-derived';

export interface Citation {
    readonly path: string;
    readonly line: number;
    readonly label: string;
}

export interface GridPosition {
    readonly column: number;
    readonly row: number;
}

export interface ArchitectureNode {
    readonly id: string;
    readonly label: string;
    readonly eyebrow: string;
    readonly kind: NodeKind;
    readonly group: string;
    readonly position: GridPosition;
    readonly height: number;
    readonly width?: number;
    readonly depth?: number;
    readonly summary: string;
    readonly description: string;
    readonly responsibilities: readonly string[];
    readonly builtWith: readonly string[];
    readonly citations: readonly Citation[];
    readonly childSceneId?: string;
    readonly status?: 'active' | 'adjacent' | 'scaffold';
}

export interface ArchitectureEdge {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly label: string;
    readonly kind: EdgeKind;
    readonly bidirectional?: boolean;
    readonly bend?: number;
}

export interface FlowStep {
    readonly edgeId: string;
    readonly direction?: 'forward' | 'reverse';
    /** Explains an intentional packet reset when the trace changes actor or phase. */
    readonly phaseBreak?: string;
    readonly label: string;
    readonly detail: string;
    readonly payload: string;
    readonly evidence: EvidenceKind;
    readonly citations: readonly Citation[];
}

export interface ArchitectureFlow {
    readonly id: string;
    readonly label: string;
    readonly shortLabel: string;
    readonly summary: string;
    readonly color: string;
    readonly steps: readonly FlowStep[];
}

export interface ArchitectureScene {
    readonly id: string;
    readonly label: string;
    readonly shortLabel: string;
    readonly description: string;
    readonly scope: string;
    readonly nodes: readonly ArchitectureNode[];
    readonly edges: readonly ArchitectureEdge[];
    readonly flows: readonly ArchitectureFlow[];
    readonly defaultNodeId: string;
}

export interface NodeTarget {
    readonly kind: 'node';
    readonly nodeId: string;
}

export interface PacketTarget {
    readonly kind: 'packet';
    readonly flowId: string;
    readonly stepIndex: number;
}

export type InspectorTarget = NodeTarget | PacketTarget;

export interface MapTransform {
    readonly x: number;
    readonly y: number;
    readonly scale: number;
}
