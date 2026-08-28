// Immutable optional enrichment children for a deterministic run. They are
// deliberately separate from run artifacts: a provider failure or a malformed
// response cannot rewrite or invalidate a deterministic report.

import type { EngagementId } from '@cbranch/rpc-contract';

import { WorkspaceIntelligenceArtifactStore } from './artifact-store';
import type { WorkspaceIntelligenceFileSystem } from './ports';

const join = (...parts: ReadonlyArray<string>): string =>
    parts.join('/').replaceAll(/\/+/g, '/');

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export type WorkspaceIntelligenceConfidenceTier = 'low' | 'medium' | 'high';

export interface WorkspaceIntelligenceInferredEdge {
    readonly from: string;
    readonly to: string;
    readonly kind: string;
    readonly confidence: number;
    readonly confidenceTier: WorkspaceIntelligenceConfidenceTier;
    readonly evidenceIds: ReadonlyArray<string>;
    readonly rationale: string;
}

export interface WorkspaceIntelligenceEnrichmentFailure {
    readonly code: 'invalidStructuredOutput' | 'providerFailure' | 'cancelled';
    readonly message: string;
    readonly repairAttempted: boolean;
}

/** Metadata-only immutable child of a deterministic run. */
export interface WorkspaceIntelligenceEnrichmentAttempt {
    readonly id: string;
    readonly runId: string;
    readonly profileId: string;
    readonly modelId: string;
    readonly promptSchemaVersion: string;
    readonly createdAt: number;
    readonly completedAt: number;
    readonly evidenceIds: ReadonlyArray<string>;
    readonly state: 'completed' | 'failed' | 'cancelled';
    readonly repairAttempted: boolean;
    readonly inferredEdges: ReadonlyArray<WorkspaceIntelligenceInferredEdge>;
    readonly summary?: string;
    readonly usage?: {
        readonly inputTokens?: number;
        readonly outputTokens?: number;
    };
    readonly durationMs?: number;
    readonly failure?: WorkspaceIntelligenceEnrichmentFailure;
}

interface StoredAttemptDocument {
    readonly schemaVersion: number;
    readonly attempt: WorkspaceIntelligenceEnrichmentAttempt;
}

export interface WorkspaceIntelligenceEnrichmentStoreOptions {
    readonly artifacts: WorkspaceIntelligenceArtifactStore;
    readonly fileSystem: WorkspaceIntelligenceFileSystem;
}

const tier = (confidence: number): WorkspaceIntelligenceConfidenceTier =>
    confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';

const validString = (value: unknown, maximum = 4_000): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maximum;

const validCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const storedEdge = (
    value: unknown,
    selectedEvidence: ReadonlySet<string>,
): WorkspaceIntelligenceInferredEdge | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const edge = value as Record<string, unknown>;
    if (
        !validString(edge.from) ||
        !validString(edge.to) ||
        !validString(edge.kind) ||
        typeof edge.confidence !== 'number' ||
        !Number.isFinite(edge.confidence) ||
        edge.confidence < 0 ||
        edge.confidence > 1 ||
        !Array.isArray(edge.evidenceIds) ||
        edge.evidenceIds.length === 0 ||
        edge.evidenceIds.some(
            evidenceId =>
                !validString(evidenceId, 512) ||
                !selectedEvidence.has(evidenceId),
        ) ||
        !validString(edge.rationale)
    )
        return undefined;
    return {
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        confidence: edge.confidence,
        confidenceTier: tier(edge.confidence),
        evidenceIds: edge.evidenceIds,
        rationale: edge.rationale,
    };
};

const storedAttempt = (
    value: unknown,
): WorkspaceIntelligenceEnrichmentAttempt | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const attempt = value as Record<string, unknown>;
    if (
        !validString(attempt.id, 96) ||
        !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(attempt.id) ||
        !validString(attempt.runId, 96) ||
        !validString(attempt.profileId, 96) ||
        !validString(attempt.modelId, 200) ||
        !validString(attempt.promptSchemaVersion, 200) ||
        !validCount(attempt.createdAt) ||
        !validCount(attempt.completedAt) ||
        !Array.isArray(attempt.evidenceIds) ||
        attempt.evidenceIds.length === 0 ||
        attempt.evidenceIds.some(id => !validString(id, 512)) ||
        new Set(attempt.evidenceIds).size !== attempt.evidenceIds.length ||
        (attempt.state !== 'completed' &&
            attempt.state !== 'failed' &&
            attempt.state !== 'cancelled') ||
        typeof attempt.repairAttempted !== 'boolean' ||
        !Array.isArray(attempt.inferredEdges)
    )
        return undefined;

    const selectedEvidence = new Set(attempt.evidenceIds);
    const inferredEdges = attempt.inferredEdges.map(edge =>
        storedEdge(edge, selectedEvidence),
    );
    if (inferredEdges.some(edge => edge === undefined)) return undefined;
    const summary =
        attempt.summary === undefined
            ? undefined
            : validString(attempt.summary, 12_000)
              ? attempt.summary
              : undefined;
    if (attempt.summary !== undefined && summary === undefined)
        return undefined;
    const usage =
        attempt.usage === undefined ? undefined : readUsage(attempt.usage);
    if (attempt.usage !== undefined && usage === undefined) return undefined;
    const durationMs =
        attempt.durationMs === undefined
            ? undefined
            : typeof attempt.durationMs === 'number' &&
                Number.isFinite(attempt.durationMs) &&
                attempt.durationMs >= 0
              ? attempt.durationMs
              : undefined;
    if (attempt.durationMs !== undefined && durationMs === undefined)
        return undefined;
    const failure =
        attempt.failure === undefined
            ? undefined
            : readFailure(attempt.failure);
    if (attempt.failure !== undefined && failure === undefined)
        return undefined;
    if (
        (attempt.state === 'completed' && failure !== undefined) ||
        ((attempt.state === 'failed' || attempt.state === 'cancelled') &&
            failure === undefined)
    )
        return undefined;

    return {
        id: attempt.id,
        runId: attempt.runId,
        profileId: attempt.profileId,
        modelId: attempt.modelId,
        promptSchemaVersion: attempt.promptSchemaVersion,
        createdAt: attempt.createdAt,
        completedAt: attempt.completedAt,
        evidenceIds: attempt.evidenceIds,
        state: attempt.state,
        repairAttempted: attempt.repairAttempted,
        inferredEdges: inferredEdges as WorkspaceIntelligenceInferredEdge[],
        ...(summary === undefined ? {} : { summary }),
        ...(usage === undefined ? {} : { usage }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(failure === undefined ? {} : { failure }),
    };
};

const readUsage = (
    value: unknown,
): WorkspaceIntelligenceEnrichmentAttempt['usage'] | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const usage = value as Record<string, unknown>;
    if (
        (usage.inputTokens !== undefined && !validCount(usage.inputTokens)) ||
        (usage.outputTokens !== undefined && !validCount(usage.outputTokens))
    )
        return undefined;
    return {
        ...(usage.inputTokens === undefined
            ? {}
            : { inputTokens: usage.inputTokens as number }),
        ...(usage.outputTokens === undefined
            ? {}
            : { outputTokens: usage.outputTokens as number }),
    };
};

const readFailure = (
    value: unknown,
): WorkspaceIntelligenceEnrichmentFailure | undefined => {
    if (value === null || typeof value !== 'object') return undefined;
    const failure = value as Record<string, unknown>;
    if (
        (failure.code !== 'invalidStructuredOutput' &&
            failure.code !== 'providerFailure' &&
            failure.code !== 'cancelled') ||
        !validString(failure.message, 2_000) ||
        typeof failure.repairAttempted !== 'boolean'
    )
        return undefined;
    return {
        code: failure.code,
        message: failure.message,
        repairAttempted: failure.repairAttempted,
    };
};

export class WorkspaceIntelligenceEnrichmentStore {
    readonly #artifacts: WorkspaceIntelligenceArtifactStore;
    readonly #fs: WorkspaceIntelligenceFileSystem;

    constructor(options: WorkspaceIntelligenceEnrichmentStoreOptions) {
        this.#artifacts = options.artifacts;
        this.#fs = options.fileSystem;
    }

    attemptDirectory(engagementId: EngagementId, runId: string): string {
        return join(
            this.#artifacts.workspaceDirectory(engagementId),
            'enrichments',
            runId,
        );
    }

    async writeAttempt(
        engagementId: EngagementId,
        attempt: WorkspaceIntelligenceEnrichmentAttempt,
    ): Promise<void> {
        const validated = storedAttempt(attempt);
        if (validated === undefined)
            throw new Error(
                'Enrichment attempt is invalid or contains unselected evidence.',
            );
        if (
            (await this.#artifacts.readRun(engagementId, attempt.runId)) ===
            undefined
        )
            throw new Error(
                'A deterministic run must exist before enrichment.',
            );
        const directory = join(
            this.attemptDirectory(engagementId, attempt.runId),
            attempt.id,
        );
        const path = join(directory, 'attempt.json');
        if ((await this.#fs.readText(path)) !== undefined)
            throw new Error(
                'Enrichment attempts are immutable and cannot be replaced.',
            );
        await this.#fs.mkdir(directory);
        await this.writeAtomic(
            path,
            json({ schemaVersion: 1, attempt: validated }),
        );
    }

    async readAttempt(
        engagementId: EngagementId,
        runId: string,
        attemptId: string,
    ): Promise<WorkspaceIntelligenceEnrichmentAttempt | undefined> {
        const text = await this.#fs.readText(
            join(
                this.attemptDirectory(engagementId, runId),
                attemptId,
                'attempt.json',
            ),
        );
        if (text === undefined) return undefined;
        try {
            const document = JSON.parse(text) as StoredAttemptDocument;
            return document.schemaVersion === 1 &&
                document.attempt.runId === runId
                ? storedAttempt(document.attempt)
                : undefined;
        } catch {
            return undefined;
        }
    }

    async listAttempts(
        engagementId: EngagementId,
        runId: string,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceEnrichmentAttempt>> {
        const directory = this.attemptDirectory(engagementId, runId);
        const entries = await this.#fs.listDirectory(directory);
        const attempts = await Promise.all(
            entries.map(entry => this.readAttempt(engagementId, runId, entry)),
        );
        return attempts
            .flatMap(attempt => (attempt === undefined ? [] : [attempt]))
            .toSorted(
                (left, right) =>
                    right.createdAt - left.createdAt ||
                    left.id.localeCompare(right.id),
            );
    }

    async setPreferredAttempt(
        engagementId: EngagementId,
        runId: string,
        attemptId: string | undefined,
    ): Promise<void> {
        const path = join(
            this.#artifacts.workspaceDirectory(engagementId),
            'enrichments',
            'preferred.json',
        );
        if (attemptId !== undefined) {
            const attempt = await this.readAttempt(
                engagementId,
                runId,
                attemptId,
            );
            if (attempt?.state !== 'completed')
                throw new Error(
                    'Only a completed enrichment attempt can be preferred.',
                );
        }
        const current = await this.readPreferredAttempts(engagementId);
        const next =
            attemptId === undefined
                ? Object.fromEntries(
                      Object.entries(current).filter(
                          ([currentRunId]) => currentRunId !== runId,
                      ),
                  )
                : { ...current, [runId]: attemptId };
        await this.#fs.mkdir(
            join(
                this.#artifacts.workspaceDirectory(engagementId),
                'enrichments',
            ),
        );
        await this.writeAtomic(
            path,
            json({ schemaVersion: 1, attempts: next }),
        );
    }

    async preferredAttempt(
        engagementId: EngagementId,
        runId: string,
    ): Promise<WorkspaceIntelligenceEnrichmentAttempt | undefined> {
        const id = (await this.readPreferredAttempts(engagementId))[runId];
        return id === undefined
            ? undefined
            : this.readAttempt(engagementId, runId, id);
    }

    private async readPreferredAttempts(
        engagementId: EngagementId,
    ): Promise<Record<string, string>> {
        const text = await this.#fs.readText(
            join(
                this.#artifacts.workspaceDirectory(engagementId),
                'enrichments',
                'preferred.json',
            ),
        );
        if (text === undefined) return {};
        try {
            const document = JSON.parse(text) as {
                readonly schemaVersion?: unknown;
                readonly attempts?: unknown;
            };
            if (
                document.schemaVersion !== 1 ||
                document.attempts === null ||
                typeof document.attempts !== 'object'
            )
                return {};
            return Object.fromEntries(
                Object.entries(
                    document.attempts as Record<string, unknown>,
                ).flatMap(([runId, attemptId]) =>
                    validString(runId, 96) && validString(attemptId, 96)
                        ? [[runId, attemptId]]
                        : [],
                ),
            );
        } catch {
            return {};
        }
    }

    private async writeAtomic(path: string, text: string): Promise<void> {
        const temporary = `${path}.tmp`;
        await this.#fs.writeText(temporary, text);
        await this.#fs.rename(temporary, path);
    }
}
