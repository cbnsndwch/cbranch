// Compact, rebuildable semantic-index artifacts. Source chunk text remains in
// the deterministic graph only; this store persists identifiers, digests, and
// float vectors so a provider payload is never retained verbatim.

import type { EngagementId } from '@cbranch/rpc-contract';

import type { WorkspaceIntelligenceArtifactStore } from './artifact-store';
import type { WorkspaceIntelligenceFileSystem } from './ports';

const SEMANTIC_INDEX_SCHEMA_VERSION = 1;
const MAX_CHUNKS = 200;
const MAX_CHUNK_CHARS = 12_000;
const MAX_VECTOR_DIMENSIONS = 4_096;

const join = (...parts: ReadonlyArray<string>): string =>
    parts.join('/').replaceAll(/\/+/g, '/');

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export interface WorkspaceIntelligenceSemanticChunk {
    readonly id: string;
    readonly content: string;
}

export interface WorkspaceIntelligenceSemanticIndexRequest {
    readonly profileId: string;
    readonly modelId: string;
    readonly chunks: ReadonlyArray<WorkspaceIntelligenceSemanticChunk>;
}

export interface WorkspaceIntelligenceSemanticIndex {
    readonly profileId: string;
    readonly modelId: string;
    readonly chunkDigest: string;
    readonly chunkIds: ReadonlyArray<string>;
    readonly dimensions: number;
    readonly vectors: ReadonlyArray<ReadonlyArray<number>>;
}

interface SemanticIndexManifest {
    readonly schemaVersion: number;
    readonly profileId: string;
    readonly modelId: string;
    readonly chunkDigest: string;
    readonly chunkIds: ReadonlyArray<string>;
    readonly dimensions: number;
    readonly vectorCount: number;
}

interface SemanticIndexDescriptor {
    readonly cacheKey: string;
    readonly request: WorkspaceIntelligenceSemanticIndexRequest;
    readonly chunkDigest: string;
    readonly chunkIds: ReadonlyArray<string>;
}

export interface WorkspaceIntelligenceSemanticIndexStoreOptions {
    readonly artifacts: WorkspaceIntelligenceArtifactStore;
    readonly fileSystem: WorkspaceIntelligenceFileSystem;
    readonly digest: (text: string) => Promise<string>;
}

const validatedChunks = (
    chunks: ReadonlyArray<WorkspaceIntelligenceSemanticChunk>,
): ReadonlyArray<WorkspaceIntelligenceSemanticChunk> => {
    if (chunks.length === 0 || chunks.length > MAX_CHUNKS)
        throw new Error('A semantic index requires between 1 and 200 chunks.');
    const ids = new Set<string>();
    for (const chunk of chunks) {
        if (
            chunk.id === '' ||
            chunk.id.length > 512 ||
            chunk.content === '' ||
            chunk.content.length > MAX_CHUNK_CHARS ||
            ids.has(chunk.id)
        )
            throw new Error(
                'Semantic index chunks must have unique bounded IDs and text.',
            );
        ids.add(chunk.id);
    }
    return chunks;
};

const encodeVectors = (
    vectors: ReadonlyArray<ReadonlyArray<number>>,
): { readonly dimensions: number; readonly bytes: Uint8Array } => {
    if (vectors.length === 0 || vectors.length > MAX_CHUNKS)
        throw new Error('A semantic index requires between 1 and 200 vectors.');
    const dimensions = vectors[0]?.length;
    if (
        dimensions === undefined ||
        dimensions === 0 ||
        dimensions > MAX_VECTOR_DIMENSIONS ||
        vectors.some(
            vector =>
                vector.length !== dimensions ||
                vector.some(value => !Number.isFinite(value)),
        )
    )
        throw new Error(
            'Semantic index vectors must be finite and have one dimension.',
        );
    const bytes = new Uint8Array(vectors.length * dimensions * 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    for (const vector of vectors)
        for (const value of vector) {
            view.setFloat32(offset, value, true);
            offset += 4;
        }
    return { dimensions, bytes };
};

const decodeVectors = (
    bytes: Uint8Array,
    vectorCount: number,
    dimensions: number,
): ReadonlyArray<ReadonlyArray<number>> => {
    if (
        vectorCount < 1 ||
        vectorCount > MAX_CHUNKS ||
        dimensions < 1 ||
        dimensions > MAX_VECTOR_DIMENSIONS ||
        bytes.byteLength !== vectorCount * dimensions * 4
    )
        throw new Error('Semantic index vector data is invalid.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vectors: number[][] = [];
    let offset = 0;
    for (let row = 0; row < vectorCount; row += 1) {
        const vector: number[] = [];
        for (let column = 0; column < dimensions; column += 1) {
            const value = view.getFloat32(offset, true);
            offset += 4;
            if (!Number.isFinite(value))
                throw new Error('Semantic index vector data is invalid.');
            vector.push(value);
        }
        vectors.push(vector);
    }
    return vectors;
};

const isManifest = (value: unknown): value is SemanticIndexManifest => {
    if (value === null || typeof value !== 'object') return false;
    const manifest = value as Record<string, unknown>;
    return (
        manifest.schemaVersion === SEMANTIC_INDEX_SCHEMA_VERSION &&
        typeof manifest.profileId === 'string' &&
        typeof manifest.modelId === 'string' &&
        typeof manifest.chunkDigest === 'string' &&
        Array.isArray(manifest.chunkIds) &&
        manifest.chunkIds.every(item => typeof item === 'string') &&
        Number.isSafeInteger(manifest.dimensions) &&
        Number.isSafeInteger(manifest.vectorCount)
    );
};

/**
 * Stores immutable vector matrices separately from deterministic artifacts.
 * A missing, stale, or corrupt index is a cache miss: callers can fall back to
 * lexical graph search and optionally rebuild it from host-selected chunks.
 */
export class WorkspaceIntelligenceSemanticIndexStore {
    readonly #artifacts: WorkspaceIntelligenceArtifactStore;
    readonly #fs: WorkspaceIntelligenceFileSystem;
    readonly #digest: (text: string) => Promise<string>;
    readonly #writes = new Map<
        string,
        Promise<WorkspaceIntelligenceSemanticIndex>
    >();

    constructor(options: WorkspaceIntelligenceSemanticIndexStoreOptions) {
        this.#artifacts = options.artifacts;
        this.#fs = options.fileSystem;
        this.#digest = options.digest;
    }

    directory(
        engagementId: EngagementId,
        runId: string,
        cacheKey: string,
    ): string {
        return join(
            this.#artifacts.workspaceDirectory(engagementId),
            'semantic',
            runId,
            encodeURIComponent(cacheKey),
        );
    }

    async read(
        engagementId: EngagementId,
        runId: string,
        request: WorkspaceIntelligenceSemanticIndexRequest,
    ): Promise<WorkspaceIntelligenceSemanticIndex | undefined> {
        const descriptor = await this.#descriptor(request);
        return this.#readDescriptor(engagementId, runId, descriptor);
    }

    async write(
        engagementId: EngagementId,
        runId: string,
        request: WorkspaceIntelligenceSemanticIndexRequest,
        vectors: ReadonlyArray<ReadonlyArray<number>>,
    ): Promise<WorkspaceIntelligenceSemanticIndex> {
        const descriptor = await this.#descriptor(request);
        const lockKey = `${engagementId}\0${runId}\0${descriptor.cacheKey}`;
        const active = this.#writes.get(lockKey);
        if (active !== undefined) return active;
        const write = this.#writeDescriptor(
            engagementId,
            runId,
            descriptor,
            vectors,
        ).finally(() => this.#writes.delete(lockKey));
        this.#writes.set(lockKey, write);
        return write;
    }

    async #descriptor(
        request: WorkspaceIntelligenceSemanticIndexRequest,
    ): Promise<SemanticIndexDescriptor> {
        if (
            request.profileId === '' ||
            request.profileId.length > 96 ||
            request.modelId === '' ||
            request.modelId.length > 200
        )
            throw new Error(
                'Semantic index profile and model IDs must be bounded.',
            );
        const chunks = validatedChunks(request.chunks);
        const chunkIds = chunks.map(chunk => chunk.id);
        const chunkDigest = await this.#digest(
            chunks.map(chunk => `${chunk.id}\0${chunk.content}`).join('\n'),
        );
        const cacheKey = await this.#digest(
            JSON.stringify({
                schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
                profileId: request.profileId,
                modelId: request.modelId,
                chunkDigest,
            }),
        );
        return {
            cacheKey,
            request: { ...request, chunks },
            chunkDigest,
            chunkIds,
        };
    }

    async #readDescriptor(
        engagementId: EngagementId,
        runId: string,
        descriptor: SemanticIndexDescriptor,
    ): Promise<WorkspaceIntelligenceSemanticIndex | undefined> {
        const directory = this.directory(
            engagementId,
            runId,
            descriptor.cacheKey,
        );
        const manifestText = await this.#fs.readText(
            join(directory, 'manifest.json'),
        );
        if (manifestText === undefined) return undefined;
        let manifest: SemanticIndexManifest;
        try {
            const parsed = JSON.parse(manifestText) as unknown;
            if (!isManifest(parsed)) return undefined;
            manifest = parsed;
        } catch {
            return undefined;
        }
        if (
            manifest.profileId !== descriptor.request.profileId ||
            manifest.modelId !== descriptor.request.modelId ||
            manifest.chunkDigest !== descriptor.chunkDigest ||
            JSON.stringify(manifest.chunkIds) !==
                JSON.stringify(descriptor.chunkIds) ||
            manifest.vectorCount !== descriptor.chunkIds.length
        )
            return undefined;
        const bytes = await this.#fs.readBytes(join(directory, 'vectors.bin'));
        if (bytes === undefined) return undefined;
        try {
            return {
                profileId: manifest.profileId,
                modelId: manifest.modelId,
                chunkDigest: manifest.chunkDigest,
                chunkIds: manifest.chunkIds,
                dimensions: manifest.dimensions,
                vectors: decodeVectors(
                    bytes,
                    manifest.vectorCount,
                    manifest.dimensions,
                ),
            };
        } catch {
            return undefined;
        }
    }

    async #writeDescriptor(
        engagementId: EngagementId,
        runId: string,
        descriptor: SemanticIndexDescriptor,
        vectors: ReadonlyArray<ReadonlyArray<number>>,
    ): Promise<WorkspaceIntelligenceSemanticIndex> {
        const existing = await this.#readDescriptor(
            engagementId,
            runId,
            descriptor,
        );
        if (existing !== undefined) return existing;
        if (vectors.length !== descriptor.chunkIds.length)
            throw new Error(
                'Semantic index vector count must match selected chunks.',
            );
        const encoded = encodeVectors(vectors);
        const directory = this.directory(
            engagementId,
            runId,
            descriptor.cacheKey,
        );
        await this.#fs.mkdir(directory);
        await this.#writeBytesAtomic(
            join(directory, 'vectors.bin'),
            encoded.bytes,
        );
        const manifest: SemanticIndexManifest = {
            schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
            profileId: descriptor.request.profileId,
            modelId: descriptor.request.modelId,
            chunkDigest: descriptor.chunkDigest,
            chunkIds: descriptor.chunkIds,
            dimensions: encoded.dimensions,
            vectorCount: vectors.length,
        };
        await this.#writeTextAtomic(
            join(directory, 'manifest.json'),
            json(manifest),
        );
        return {
            profileId: manifest.profileId,
            modelId: manifest.modelId,
            chunkDigest: manifest.chunkDigest,
            chunkIds: manifest.chunkIds,
            dimensions: manifest.dimensions,
            vectors,
        };
    }

    async #writeTextAtomic(path: string, text: string): Promise<void> {
        const temporary = `${path}.tmp`;
        await this.#fs.writeText(temporary, text);
        await this.#fs.rename(temporary, path);
    }

    async #writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
        const temporary = `${path}.tmp`;
        await this.#fs.writeBytes(temporary, bytes);
        await this.#fs.rename(temporary, path);
    }
}
