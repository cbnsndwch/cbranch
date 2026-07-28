import {
    EngagementId,
    RepoId,
    WorkspaceIntelligenceCoverage,
    WorkspaceIntelligenceRun,
    WorkspaceIntelligenceRunId,
} from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { WorkspaceIntelligenceArtifactStore } from './artifact-store';
import {
    WorkspaceIntelligenceEnrichmentStore,
    type WorkspaceIntelligenceEnrichmentAttempt,
} from './enrichment-store';
import type { WorkspaceIntelligenceFileSystem } from './ports';

class MemoryFileSystem implements WorkspaceIntelligenceFileSystem {
    readonly files = new Map<string, string>();
    readonly bytes = new Map<string, Uint8Array>();
    readonly directories = new Set<string>(['/artifacts']);

    async mkdir(path: string): Promise<void> {
        const parts = path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current += `/${part}`;
            this.directories.add(current);
        }
    }

    async readText(path: string): Promise<string | undefined> {
        return this.files.get(path);
    }

    async writeText(path: string, text: string): Promise<void> {
        this.files.set(path, text);
    }

    async readBytes(path: string): Promise<Uint8Array | undefined> {
        return this.bytes.get(path);
    }

    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
        this.bytes.set(path, bytes);
    }

    async rename(from: string, to: string): Promise<void> {
        const text = this.files.get(from);
        if (text === undefined) {
            const bytes = this.bytes.get(from);
            if (bytes === undefined)
                throw new Error(`Missing temporary ${from}`);
            this.bytes.delete(from);
            this.bytes.set(to, bytes);
            return;
        }
        this.files.delete(from);
        this.files.set(to, text);
    }

    async listDirectory(path: string): Promise<ReadonlyArray<string>> {
        const prefix = `${path}/`;
        const entries = new Set<string>();
        for (const value of [
            ...this.files.keys(),
            ...this.bytes.keys(),
            ...this.directories,
        ]) {
            if (!value.startsWith(prefix)) continue;
            const entry = value.slice(prefix.length).split('/')[0];
            if (entry) entries.add(entry);
        }
        return [...entries];
    }

    async remove(path: string): Promise<void> {
        const prefix = `${path}/`;
        for (const file of this.files.keys())
            if (file === path || file.startsWith(prefix))
                this.files.delete(file);
        for (const file of this.bytes.keys())
            if (file === path || file.startsWith(prefix))
                this.bytes.delete(file);
        for (const directory of this.directories)
            if (directory === path || directory.startsWith(prefix))
                this.directories.delete(directory);
    }
}

const engagementId = EngagementId.make('workspace-a');
const run = new WorkspaceIntelligenceRun({
    id: WorkspaceIntelligenceRunId.make('run-a'),
    engagementId,
    workspaceRepoIds: [RepoId.make('repo-a')],
    repoIds: [RepoId.make('repo-a')],
    state: 'completed',
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
    eventSequence: 1,
    isCurrent: true,
    isValid: true,
    coverage: new WorkspaceIntelligenceCoverage({
        repositoryCount: 1,
        completedRepositoryCount: 1,
        analyzerCount: 1,
        isPartial: false,
        summary: 'Completed.',
    }),
});

const completedAttempt = (): WorkspaceIntelligenceEnrichmentAttempt => ({
    id: 'attempt-1',
    runId: run.id,
    profileId: 'hosted',
    modelId: 'example-model',
    promptSchemaVersion: 'workspace-intelligence.enrichment@1',
    createdAt: 4,
    completedAt: 5,
    evidenceIds: ['evidence-1'],
    state: 'completed',
    repairAttempted: false,
    inferredEdges: [
        {
            from: 'component:api',
            to: 'contract:users',
            kind: 'exposes',
            confidence: 0.82,
            confidenceTier: 'low',
            evidenceIds: ['evidence-1'],
            rationale: 'The selected handler registers the route.',
        },
    ],
    summary: 'A separately labeled enrichment summary.',
    usage: { inputTokens: 10, outputTokens: 2 },
    durationMs: 100,
});

const setup = async () => {
    const fileSystem = new MemoryFileSystem();
    const artifacts = new WorkspaceIntelligenceArtifactStore({
        rootDirectory: '/artifacts',
        fileSystem,
        digest: async value => value,
    });
    await artifacts.writeRun(run, []);
    return {
        artifacts,
        fileSystem,
        enrichments: new WorkspaceIntelligenceEnrichmentStore({
            artifacts,
            fileSystem,
        }),
    };
};

describe('WorkspaceIntelligenceEnrichmentStore', () => {
    test('stores an immutable child without raw prompt or provider response', async () => {
        const { enrichments, fileSystem } = await setup();
        await enrichments.writeAttempt(engagementId, completedAttempt());

        const stored = await enrichments.readAttempt(
            engagementId,
            run.id,
            'attempt-1',
        );
        expect(stored?.inferredEdges[0]).toMatchObject({
            confidence: 0.82,
            confidenceTier: 'high',
        });
        const text = [...fileSystem.files.values()].join('\n');
        expect(text).not.toMatch(/raw prompt|provider response/i);
        await expect(
            enrichments.writeAttempt(engagementId, completedAttempt()),
        ).rejects.toThrow('immutable');
    });

    test('requires cited evidence to be selected and only prefers completed attempts', async () => {
        const { enrichments } = await setup();
        const complete = completedAttempt();
        const invalid: WorkspaceIntelligenceEnrichmentAttempt = {
            ...complete,
            inferredEdges: [
                {
                    ...complete.inferredEdges[0]!,
                    evidenceIds: ['not-selected'],
                },
            ],
        };
        await expect(
            enrichments.writeAttempt(engagementId, invalid),
        ).rejects.toThrow('unselected evidence');

        const failed: WorkspaceIntelligenceEnrichmentAttempt = {
            ...completedAttempt(),
            id: 'attempt-failed',
            state: 'failed',
            inferredEdges: [],
            failure: {
                code: 'providerFailure',
                message: 'Provider timed out.',
                repairAttempted: false,
            },
        };
        await enrichments.writeAttempt(engagementId, failed);
        await expect(
            enrichments.setPreferredAttempt(engagementId, run.id, failed.id),
        ).rejects.toThrow('completed');

        const cancelled: WorkspaceIntelligenceEnrichmentAttempt = {
            ...failed,
            id: 'attempt-cancelled',
            state: 'cancelled',
            failure: {
                code: 'cancelled',
                message: 'Enrichment cancelled.',
                repairAttempted: false,
            },
        };
        await enrichments.writeAttempt(engagementId, cancelled);
        await expect(
            enrichments.setPreferredAttempt(engagementId, run.id, cancelled.id),
        ).rejects.toThrow('completed');

        await enrichments.writeAttempt(engagementId, completedAttempt());
        await enrichments.setPreferredAttempt(
            engagementId,
            run.id,
            'attempt-1',
        );
        await expect(
            enrichments.preferredAttempt(engagementId, run.id),
        ).resolves.toMatchObject({ id: 'attempt-1' });
        await enrichments.setPreferredAttempt(engagementId, run.id, undefined);
        await expect(
            enrichments.preferredAttempt(engagementId, run.id),
        ).resolves.toBeUndefined();
    });

    test('removes independent enrichment children when their deterministic parent is deleted', async () => {
        const { artifacts, enrichments } = await setup();
        await enrichments.writeAttempt(engagementId, completedAttempt());

        await artifacts.deleteRun(engagementId, run.id);

        await expect(
            enrichments.readAttempt(engagementId, run.id, 'attempt-1'),
        ).resolves.toBeUndefined();
    });
});
