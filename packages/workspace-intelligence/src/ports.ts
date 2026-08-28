import type { EngagementId, RepoId } from '@cbranch/rpc-contract';

import type { WorkspaceIntelligenceAnalysis } from './analysis';
import type { WorkspaceIntelligenceAnalysisSettings } from './analysis-settings';

/** A member resolved from cbranch's authoritative workspace configuration. */
export interface WorkspaceIntelligenceRepository {
    readonly repoId: RepoId;
    /** Private host locator; it is never written to canonical/exported artifacts. */
    readonly root: string;
}

export interface WorkspaceIntelligenceWorkspace {
    readonly engagementId: EngagementId;
    readonly repositories: ReadonlyArray<WorkspaceIntelligenceRepository>;
}

/** Host-owned membership and repository-resolution boundary. */
export interface WorkspaceIntelligenceWorkspacePort {
    readonly resolveWorkspace: (
        engagementId: EngagementId,
    ) => Promise<WorkspaceIntelligenceWorkspace | undefined>;
}

/** Minimal filesystem boundary; Node is supplied only by the web-server composition. */
export interface WorkspaceIntelligenceFileSystem {
    readonly mkdir: (path: string) => Promise<void>;
    readonly readText: (path: string) => Promise<string | undefined>;
    readonly writeText: (path: string, text: string) => Promise<void>;
    /** Binary artifacts are used only for compact, rebuildable vector indexes. */
    readonly readBytes: (path: string) => Promise<Uint8Array | undefined>;
    readonly writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
    readonly rename: (from: string, to: string) => Promise<void>;
    readonly listDirectory: (path: string) => Promise<ReadonlyArray<string>>;
    readonly remove: (path: string) => Promise<void>;
}

export interface WorkspaceIntelligenceRuntime {
    readonly now: () => number;
    readonly nextRunId: () => string;
    readonly digest: (text: string) => Promise<string>;
    /** Version of the deterministic analyzer pipeline, used to reject stale reuse. */
    readonly analyzerVersion?: string;
    /**
     * Host-side source fingerprint probe for safe incremental reuse. Undefined
     * means the optimization is unavailable and the repository is analyzed.
     */
    readonly fingerprintRepository?: (
        repository: WorkspaceIntelligenceRepository,
        settings: WorkspaceIntelligenceAnalysisSettings,
    ) => Promise<string | undefined>;
    /** Lets tests or hosts pause between repository boundaries. */
    readonly analyzeRepository?: (
        repository: WorkspaceIntelligenceRepository,
        settings: WorkspaceIntelligenceAnalysisSettings,
    ) => Promise<WorkspaceIntelligenceAnalysis | void>;
}
