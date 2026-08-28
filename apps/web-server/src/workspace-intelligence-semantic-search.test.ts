import {
    EngagementId,
    RepoId,
    WorkspaceIntelligenceGraphSearchResult,
} from '@cbranch/rpc-contract';
import { InferenceProfile } from '@cbranch/inference';
import {
    WorkspaceIntelligenceArtifactStore,
    WorkspaceIntelligenceSemanticIndexStore,
} from '@cbranch/workspace-intelligence';
import { describe, expect, test, vi } from 'vitest';

import { searchWorkspaceIntelligenceSemantically } from './workspace-intelligence-semantic-search';

const engagementId = EngagementId.make('workspace-a');
const result = (ids: ReadonlyArray<string>) =>
    new WorkspaceIntelligenceGraphSearchResult({
        nodes: ids.map(id => ({
            id,
            kind: 'component',
            label: id,
            repoId: RepoId.make('repo-a'),
            evidence: [],
        })),
    });

class MemoryFileSystem {
    readonly files = new Map<string, string>();
    readonly bytes = new Map<string, Uint8Array>();

    async mkdir(): Promise<void> {}
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
        if (text !== undefined) {
            this.files.delete(from);
            this.files.set(to, text);
            return;
        }
        const bytes = this.bytes.get(from);
        if (bytes === undefined) throw new Error('Missing temporary file.');
        this.bytes.delete(from);
        this.bytes.set(to, bytes);
    }
    async listDirectory(): Promise<ReadonlyArray<string>> {
        return [];
    }
    async remove(): Promise<void> {}
}

const digest = async (value: string): Promise<string> => {
    let hash = 2_166_136_261;
    for (const character of value)
        hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
    return `test-${(hash >>> 0).toString(16)}`;
};

const indexes = () => {
    const fileSystem = new MemoryFileSystem();
    return new WorkspaceIntelligenceSemanticIndexStore({
        artifacts: new WorkspaceIntelligenceArtifactStore({
            rootDirectory: '/artifacts',
            fileSystem,
            digest,
        }),
        fileSystem,
        digest,
    });
};

const profile = InferenceProfile.parse({
    id: 'embeddings',
    label: 'Hosted embeddings',
    provider: 'openai-compatible',
    enabled: true,
    capabilities: ['embeddings'],
    endpoint: 'https://example.test/v1',
    modelId: 'example-embedding',
    secretReference: { kind: 'environment', name: 'TEST_KEY' },
});

describe('searchWorkspaceIntelligenceSemantically', () => {
    test('builds once, ranks graph chunks, and reuses the immutable binary index', async () => {
        const embed = vi
            .fn()
            .mockResolvedValueOnce({
                vectors: [
                    [1, 0],
                    [0, 1],
                ],
            })
            .mockResolvedValueOnce({ vectors: [[0, 1]] })
            .mockResolvedValueOnce({ vectors: [[1, 0]] });
        const rankedNodes = vi.fn(async (_id, _run, ids) => result(ids));
        const common = {
            engagementId,
            runId: 'run-a',
            query: 'users API',
            lexicalSearch: vi.fn(async () => result(['lexical'])),
            rankedNodes,
            chunks: async () => [
                { id: 'component:api', content: 'The API exposes users.' },
                { id: 'contract:users', content: 'Users contract.' },
            ],
            indexes: indexes(),
            profiles: async () => [profile],
            defaults: async () => ({ embeddingProfileId: 'embeddings' }),
            runnerForProfile: () => ({ embed }),
        };

        const first = await searchWorkspaceIntelligenceSemantically(common);
        expect(first.mode).toBe('semantic');
        expect(first.nodes[0]).toMatchObject({ id: 'contract:users' });
        await expect(
            searchWorkspaceIntelligenceSemantically({
                ...common,
                query: 'API',
            }),
        ).resolves.toMatchObject({ mode: 'semantic' });
        expect(embed).toHaveBeenCalledTimes(3);
        expect(rankedNodes).toHaveBeenCalledWith(
            engagementId,
            'run-a',
            ['contract:users', 'component:api'],
            undefined,
        );
    });

    test('falls back to lexical search when no eligible profile exists or embedding fails', async () => {
        const lexicalSearch = vi.fn(async () => result(['lexical']));
        const common = {
            engagementId,
            runId: 'run-a',
            query: 'users',
            lexicalSearch,
            rankedNodes: vi.fn(async () => result([])),
            chunks: async () => [{ id: 'component:api', content: 'API.' }],
            indexes: indexes(),
            profiles: async () => [],
            defaults: async () => ({}),
            runnerForProfile: () => ({ embed: vi.fn() }),
        };
        await expect(
            searchWorkspaceIntelligenceSemantically(common),
        ).resolves.toMatchObject({
            mode: 'lexical-fallback',
            nodes: [expect.objectContaining({ id: 'lexical' })],
        });
        await expect(
            searchWorkspaceIntelligenceSemantically({
                ...common,
                profiles: async () => [profile],
                defaults: async () => ({ embeddingProfileId: 'embeddings' }),
                runnerForProfile: () => ({
                    embed: async () => {
                        throw new Error('credential should not escape');
                    },
                }),
            }),
        ).resolves.toMatchObject({
            mode: 'lexical-fallback',
            message: expect.not.stringContaining('credential'),
        });
        expect(lexicalSearch).toHaveBeenCalledTimes(2);
    });

    test('admits a constrained local embedding profile without treating it as an agent', async () => {
        const local = InferenceProfile.parse({
            id: 'ollama-local',
            label: 'Ollama local embeddings',
            provider: 'local-embeddings',
            enabled: true,
            capabilities: ['embeddings'],
            executable: '/usr/bin/ollama',
            modelId: 'mxbai-embed-large:latest',
        });
        const embed = vi
            .fn()
            .mockResolvedValueOnce({ vectors: [[1, 0]] })
            .mockResolvedValueOnce({ vectors: [[1, 0]] });

        await expect(
            searchWorkspaceIntelligenceSemantically({
                engagementId,
                runId: 'run-a',
                query: 'api',
                lexicalSearch: async () => result(['lexical']),
                rankedNodes: async (_id, _run, ids) => result(ids),
                chunks: async () => [
                    { id: 'component:api', content: 'The API component.' },
                ],
                indexes: indexes(),
                profiles: async () => [local],
                defaults: async () => ({
                    embeddingProfileId: 'ollama-local',
                }),
                runnerForProfile: profile => {
                    expect(profile.provider).toBe('local-embeddings');
                    return { embed };
                },
            }),
        ).resolves.toMatchObject({ mode: 'semantic' });
        expect(embed).toHaveBeenCalledTimes(2);
    });
});
