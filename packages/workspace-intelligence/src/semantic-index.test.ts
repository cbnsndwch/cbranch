import { EngagementId } from '@cbranch/rpc-contract';
import { describe, expect, test } from 'vitest';

import { WorkspaceIntelligenceArtifactStore } from './artifact-store';
import { WorkspaceIntelligenceSemanticIndexStore } from './semantic-index';
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
        if (text !== undefined) {
            this.files.delete(from);
            this.files.set(to, text);
            return;
        }
        const bytes = this.bytes.get(from);
        if (bytes === undefined) throw new Error(`Missing temporary ${from}`);
        this.bytes.delete(from);
        this.bytes.set(to, bytes);
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
const request = {
    profileId: 'embeddings',
    modelId: 'text-embedding-example',
    chunks: [
        {
            id: 'component:api',
            content: 'Component API exposes the users route.',
        },
        { id: 'contract:users', content: 'The users contract is public.' },
    ],
};

const digest = async (value: string): Promise<string> => {
    let hash = 2_166_136_261;
    for (const character of value)
        hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
    return `test-${(hash >>> 0).toString(16)}`;
};

const setup = () => {
    const fileSystem = new MemoryFileSystem();
    const artifacts = new WorkspaceIntelligenceArtifactStore({
        rootDirectory: '/artifacts',
        fileSystem,
        digest,
    });
    return {
        fileSystem,
        artifacts,
        indexes: new WorkspaceIntelligenceSemanticIndexStore({
            artifacts,
            fileSystem,
            digest,
        }),
    };
};

describe('WorkspaceIntelligenceSemanticIndexStore', () => {
    test('persists only immutable vector metadata and binary vectors', async () => {
        const { fileSystem, indexes } = setup();
        const stored = await indexes.write(engagementId, 'run-a', request, [
            [1, 0, 0.25],
            [0, 1, 0.5],
        ]);

        expect(stored).toMatchObject({
            profileId: 'embeddings',
            dimensions: 3,
            chunkIds: ['component:api', 'contract:users'],
        });
        expect([...fileSystem.files.values()].join('\n')).not.toContain(
            'Component API exposes the users route.',
        );
        expect(
            [...fileSystem.bytes.keys()].some(path =>
                path.endsWith('/vectors.bin'),
            ),
        ).toBe(true);
        await expect(
            indexes.read(engagementId, 'run-a', request),
        ).resolves.toEqual(stored);
    });

    test('treats changed chunks and corrupt vectors as cache misses', async () => {
        const { fileSystem, indexes } = setup();
        await indexes.write(engagementId, 'run-a', request, [
            [1, 0],
            [0, 1],
        ]);
        await expect(
            indexes.read(engagementId, 'run-a', {
                ...request,
                chunks: [
                    { ...request.chunks[0]!, content: 'Changed.' },
                    request.chunks[1]!,
                ],
            }),
        ).resolves.toBeUndefined();
        const path = [...fileSystem.bytes.keys()][0]!;
        fileSystem.bytes.set(path, new Uint8Array([1, 2]));
        await expect(
            indexes.read(engagementId, 'run-a', request),
        ).resolves.toBeUndefined();
    });

    test('rejects invalid vector dimensions and cleans up with the deterministic run', async () => {
        const { artifacts, fileSystem, indexes } = setup();
        await expect(
            indexes.write(engagementId, 'run-a', request, [[1, 0], [0]]),
        ).rejects.toThrow('one dimension');
        await indexes.write(engagementId, 'run-a', request, [
            [1, 0],
            [0, 1],
        ]);
        await artifacts.deleteRun(engagementId, 'run-a');
        expect([...fileSystem.bytes.keys()]).toEqual([]);
    });
});
