// Optional semantic retrieval composes only bounded graph chunks, profiles,
// and an embedding runner. It never receives a repository root or filesystem.

import {
    cosineSimilarity,
    type InferenceEmbeddingRunner,
    type InferenceProfile,
} from '@cbranch/inference';
import type {
    EngagementId,
    WorkspaceIntelligenceGraphSearchResult,
} from '@cbranch/rpc-contract';
import type {
    WorkspaceIntelligenceSemanticChunk,
    WorkspaceIntelligenceSemanticIndexStore,
} from '@cbranch/workspace-intelligence';

export type WorkspaceIntelligenceSearchMode = 'semantic' | 'lexical-fallback';

export interface WorkspaceIntelligenceSemanticSearchResult {
    readonly mode: WorkspaceIntelligenceSearchMode;
    readonly nodes: WorkspaceIntelligenceGraphSearchResult['nodes'];
    /** Safe, action-oriented status; it never includes provider response text. */
    readonly message?: string;
}

const lexicalFallback = async (
    search: WorkspaceIntelligenceSemanticSearchOptions['lexicalSearch'],
    engagementId: EngagementId,
    runId: string,
    query: string,
    limit: number | undefined,
    message: string,
): Promise<WorkspaceIntelligenceSemanticSearchResult> => ({
    mode: 'lexical-fallback',
    nodes: (await search(engagementId, runId, query, limit)).nodes,
    message,
});

const profileForSemanticSearch = (
    profiles: ReadonlyArray<InferenceProfile>,
    profileId: string | undefined,
): InferenceProfile | undefined => {
    const profile = profiles.find(candidate => candidate.id === profileId);
    if (
        profile === undefined ||
        !profile.enabled ||
        !profile.capabilities.includes('embeddings') ||
        (profile.provider !== 'openai-compatible' &&
            profile.provider !== 'local-embeddings')
    )
        return undefined;
    return profile;
};

export interface WorkspaceIntelligenceSemanticSearchOptions {
    readonly engagementId: EngagementId;
    readonly runId: string;
    readonly query: string;
    readonly requestedLimit?: number;
    readonly requestedProfileId?: string;
    readonly lexicalSearch: (
        engagementId: EngagementId,
        runId: string,
        query: string,
        limit?: number,
    ) => Promise<WorkspaceIntelligenceGraphSearchResult>;
    readonly rankedNodes: (
        engagementId: EngagementId,
        runId: string,
        nodeIds: ReadonlyArray<string>,
        limit?: number,
    ) => Promise<WorkspaceIntelligenceGraphSearchResult>;
    readonly chunks: (
        engagementId: EngagementId,
        runId: string,
    ) => Promise<ReadonlyArray<WorkspaceIntelligenceSemanticChunk>>;
    readonly indexes: WorkspaceIntelligenceSemanticIndexStore;
    readonly profiles: () => Promise<ReadonlyArray<InferenceProfile>>;
    readonly defaults: () => Promise<{
        readonly embeddingProfileId?: string;
    }>;
    readonly runnerForProfile: (
        profile: InferenceProfile,
    ) => InferenceEmbeddingRunner;
}

/**
 * Performs a bounded, user-invoked semantic rerank. Any unavailable profile,
 * embedding failure, cache corruption, or invalid query returns normal lexical
 * search results rather than making Workspace Intelligence unavailable.
 */
export const searchWorkspaceIntelligenceSemantically = async ({
    engagementId,
    runId,
    query,
    requestedLimit,
    requestedProfileId,
    lexicalSearch,
    rankedNodes,
    chunks: loadChunks,
    indexes,
    profiles: loadProfiles,
    defaults: loadDefaults,
    runnerForProfile,
}: WorkspaceIntelligenceSemanticSearchOptions): Promise<WorkspaceIntelligenceSemanticSearchResult> => {
    const trimmedQuery = query.trim();
    if (trimmedQuery === '' || trimmedQuery.length > 12_000)
        return lexicalFallback(
            lexicalSearch,
            engagementId,
            runId,
            query,
            requestedLimit,
            'Semantic search needs a non-empty query of at most 12000 characters; showing lexical results.',
        );
    const [profiles, defaults] = await Promise.all([
        loadProfiles(),
        loadDefaults(),
    ]);
    const profile = profileForSemanticSearch(
        profiles,
        requestedProfileId ?? defaults.embeddingProfileId,
    );
    if (profile === undefined)
        return lexicalFallback(
            lexicalSearch,
            engagementId,
            runId,
            query,
            requestedLimit,
            'No enabled embedding profile is selected; showing lexical results.',
        );
    const modelId = profile.modelId ?? profile.provider;
    let chunks: ReadonlyArray<WorkspaceIntelligenceSemanticChunk>;
    try {
        chunks = await loadChunks(engagementId, runId);
    } catch {
        return lexicalFallback(
            lexicalSearch,
            engagementId,
            runId,
            query,
            requestedLimit,
            'Semantic graph chunks are unavailable; showing lexical results.',
        );
    }
    if (chunks.length === 0)
        return lexicalFallback(
            lexicalSearch,
            engagementId,
            runId,
            query,
            requestedLimit,
            'This run has no semantic graph chunks; showing lexical results.',
        );
    const indexRequest = { profileId: profile.id, modelId, chunks };
    try {
        let semanticIndex = await indexes.read(
            engagementId,
            runId,
            indexRequest,
        );
        const runner = runnerForProfile(profile);
        if (semanticIndex === undefined) {
            const embedded = await runner.embed({
                profileId: profile.id,
                model: modelId,
                inputs: chunks.map(chunk => chunk.content),
            });
            semanticIndex = await indexes.write(
                engagementId,
                runId,
                indexRequest,
                embedded.vectors,
            );
        }
        const queryEmbedding = await runner.embed({
            profileId: profile.id,
            model: modelId,
            inputs: [trimmedQuery],
        });
        const queryVector = queryEmbedding.vectors[0];
        if (queryVector === undefined) throw new Error('Missing query vector.');
        const nodeIds = chunks
            .map((chunk, row) => ({
                id: chunk.id,
                score: cosineSimilarity(
                    queryVector,
                    semanticIndex.vectors[row]!,
                ),
            }))
            .toSorted(
                (left, right) =>
                    right.score - left.score || left.id.localeCompare(right.id),
            )
            .map(result => result.id);
        return {
            mode: 'semantic',
            nodes: (
                await rankedNodes(engagementId, runId, nodeIds, requestedLimit)
            ).nodes,
        };
    } catch {
        return lexicalFallback(
            lexicalSearch,
            engagementId,
            runId,
            query,
            requestedLimit,
            'Semantic search is temporarily unavailable; showing lexical results.',
        );
    }
};
