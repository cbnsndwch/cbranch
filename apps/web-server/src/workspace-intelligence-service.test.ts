import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngagementId, RepoId } from '@cbranch/rpc-contract';
import {
    analyzeDeterministicSource,
    defaultWorkspaceIntelligenceAnalysisSettings,
    WorkspaceIntelligenceArtifactStore,
    WorkspaceIntelligenceManager,
} from '@cbranch/workspace-intelligence';
import { afterEach, describe, expect, test } from 'vitest';

import {
    applyWorkspaceIntelligenceGraphBudget,
    collectWorkspaceIntelligenceSourceInventory,
    maxConcurrentWorkspaceIntelligenceEnrichments,
    maxConcurrentWorkspaceIntelligenceRuns,
} from './workspace-intelligence-service';

let directory: string | undefined;

const readText = async (path: string): Promise<string | undefined> => {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return undefined;
        throw error;
    }
};

const listDirectory = async (path: string): Promise<ReadonlyArray<string>> => {
    try {
        return await readdir(path);
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return [];
        throw error;
    }
};

const ignoredPathsFor = (root: string): ReadonlySet<string> =>
    new Set(
        execFileSync(
            'git',
            ['-C', root, 'ls-files', '-io', '--exclude-standard'],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        )
            .split('\n')
            .filter(Boolean),
    );

afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true });
    directory = undefined;
});

describe('collectWorkspaceIntelligenceSourceInventory', () => {
    test('uses an explicit positive host concurrency setting', () => {
        const previous = process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS;
        try {
            delete process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS;
            expect(maxConcurrentWorkspaceIntelligenceRuns()).toBe(2);

            process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS = '3';
            expect(maxConcurrentWorkspaceIntelligenceRuns()).toBe(3);

            process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS = '0';
            expect(maxConcurrentWorkspaceIntelligenceRuns).toThrow(
                'must be a positive integer',
            );
        } finally {
            if (previous === undefined)
                delete process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS;
            else
                process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS = previous;
        }
    });

    test('bounds optional provider work independently from analysis workers', () => {
        const previous =
            process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS;
        try {
            delete process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS;
            expect(maxConcurrentWorkspaceIntelligenceEnrichments()).toBe(1);

            process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS = '2';
            expect(maxConcurrentWorkspaceIntelligenceEnrichments()).toBe(2);

            process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS = '0';
            expect(maxConcurrentWorkspaceIntelligenceEnrichments).toThrow(
                'must be a positive integer',
            );
        } finally {
            if (previous === undefined)
                delete process.env
                    .CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS;
            else
                process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS =
                    previous;
        }
    });

    test('stays root-bounded and records inventory exclusions explicitly', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-intelligence-'));
        await mkdir(join(directory, 'src'));
        await mkdir(join(directory, 'node_modules'));
        await writeFile(
            join(directory, 'src', 'main.ts'),
            'export const x = 1;',
        );
        await writeFile(
            join(directory, 'ignored.ts'),
            'export const ignored = 1;',
        );
        await writeFile(
            join(directory, 'pnpm-workspace.yaml'),
            "packages:\n  - 'packages/*'\n",
        );
        await writeFile(
            join(directory, 'node_modules', 'dependency.ts'),
            'export const dependency = 1;',
        );
        await writeFile(join(directory, 'binary.ts'), Buffer.from([0, 1, 2]));
        await symlink(
            join(directory, 'src', 'main.ts'),
            join(directory, 'link.ts'),
        );

        const inventory = await collectWorkspaceIntelligenceSourceInventory(
            directory,
            new Set(['ignored.ts']),
        );
        const repeated = await collectWorkspaceIntelligenceSourceInventory(
            directory,
            new Set(['ignored.ts']),
        );

        expect(inventory.files.map(file => file.path)).toEqual([
            'pnpm-workspace.yaml',
            'src/main.ts',
        ]);
        expect(inventory.sourceFingerprint).toBe(repeated.sourceFingerprint);
        expect(inventory.unknowns).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'source.git-ignored-excluded',
                }),
                expect.objectContaining({ kind: 'source.symlinks-excluded' }),
                expect.objectContaining({
                    kind: 'source.directories-excluded',
                }),
                expect.objectContaining({ kind: 'source.binary-excluded' }),
            ]),
        );
    });

    test('makes unavailable Git ignored-path information a truthful gap', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-intelligence-'));
        await writeFile(join(directory, 'main.ts'), 'export {};');

        const inventory = await collectWorkspaceIntelligenceSourceInventory(
            directory,
            undefined,
        );

        expect(inventory.unknowns).toContainEqual(
            expect.objectContaining({ kind: 'source.git-ignore-unavailable' }),
        );
    });

    test('includes only recognized supporting configuration formats', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-intelligence-'));
        await writeFile(join(directory, 'wrangler.toml'), 'name = "edge"\n');
        await writeFile(
            join(directory, 'docker-compose.yml'),
            'services:\n  app:\n    image: example/app\n',
        );
        await writeFile(
            join(directory, 'asyncapi.json'),
            '{"asyncapi":"3.0.0","channels":{}}',
        );
        await writeFile(
            join(directory, 'contracts.schema.graphql'),
            'type Query { healthy: Boolean! }',
        );
        await writeFile(
            join(directory, 'contracts.proto'),
            'syntax = "proto3";',
        );
        await writeFile(join(directory, 'notes.yaml'), 'unrecognized: true\n');
        await writeFile(join(directory, 'random.json'), '{"not":"schema"}\n');

        const inventory = await collectWorkspaceIntelligenceSourceInventory(
            directory,
            new Set(),
        );

        expect(inventory.files.map(file => file.path)).toEqual([
            'asyncapi.json',
            'contracts.proto',
            'contracts.schema.graphql',
            'docker-compose.yml',
            'wrangler.toml',
        ]);
    });

    test('enforces saved source scope and byte budgets with explicit gaps', async () => {
        directory = await mkdtemp(join(tmpdir(), 'cbranch-intelligence-'));
        await mkdir(join(directory, 'src'));
        await writeFile(
            join(directory, 'root.ts'),
            'export const root = true;\n',
        );
        await writeFile(
            join(directory, 'src', 'keep.ts'),
            'export const keep = true;\n',
        );
        await writeFile(
            join(directory, 'src', 'skip.ts'),
            'export const skip = true;\n',
        );

        const scoped = await collectWorkspaceIntelligenceSourceInventory(
            directory,
            new Set(),
            {
                ...defaultWorkspaceIntelligenceAnalysisSettings,
                includePatterns: ['src/**/*.ts'],
                excludePatterns: ['src/skip.ts'],
            },
        );

        expect(scoped.files.map(file => file.path)).toEqual(['src/keep.ts']);
        expect(scoped.unknowns).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'source.workspace-include-excluded',
                    count: 1,
                }),
                expect.objectContaining({
                    kind: 'source.workspace-exclude-excluded',
                    count: 1,
                }),
            ]),
        );

        const byteBudgeted = await collectWorkspaceIntelligenceSourceInventory(
            directory,
            new Set(),
            {
                ...defaultWorkspaceIntelligenceAnalysisSettings,
                maxRepositorySourceBytes: 30,
            },
        );

        expect(byteBudgeted.files).toHaveLength(1);
        expect(byteBudgeted.unknowns).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'source.repository-byte-limit-excluded',
                }),
                expect.objectContaining({
                    kind: 'source.repository-byte-limit-reached',
                }),
            ]),
        );
    });

    test('marks graph-budget truncation partial with an explicit observation', () => {
        const analysis = analyzeDeterministicSource(RepoId.make('budgeted'), [
            {
                path: 'entry.ts',
                text: "import { feature } from './feature';\nexport const app = feature;\n",
            },
            {
                path: 'feature.ts',
                text: 'export const feature = true;\n',
            },
        ]);

        const budgeted = applyWorkspaceIntelligenceGraphBudget(analysis, {
            ...defaultWorkspaceIntelligenceAnalysisSettings,
            maxGraphNodes: 1,
            maxGraphEdges: 0,
        });

        expect(budgeted.nodes).toHaveLength(1);
        expect(budgeted.isPartial).toBe(true);
        expect(budgeted.unknowns).toContainEqual(
            expect.objectContaining({ kind: 'graph.node-limit-reached' }),
        );
    });

    test.skipIf(process.env.CBRANCH_INTELLIGENCE_PILOT_ROOT === undefined)(
        'analyzes an explicitly selected pilot root read-only',
        async () => {
            const root = process.env.CBRANCH_INTELLIGENCE_PILOT_ROOT;
            if (root === undefined) throw new Error('Pilot root is required.');
            const inventory = await collectWorkspaceIntelligenceSourceInventory(
                root,
                ignoredPathsFor(root),
            );
            const analysis = analyzeDeterministicSource(
                RepoId.make('cbranch-pilot'),
                inventory.files,
            );

            expect(inventory.files.length).toBeGreaterThan(0);
            expect(analysis.nodes.length).toBeGreaterThan(0);
            expect(analysis.analyzerIds).toContain(
                'workspace-intelligence.typescript@3',
            );
        },
        120_000,
    );

    test.skipIf(process.env.CBRANCH_INTELLIGENCE_PILOT_ROOTS === undefined)(
        'runs an explicit multi-root pilot through aggregate artifacts read-only',
        async () => {
            const configured = process.env.CBRANCH_INTELLIGENCE_PILOT_ROOTS;
            if (configured === undefined)
                throw new Error('Pilot roots are required.');
            const roots = configured.split(':').filter(Boolean);
            if (roots.length < 2)
                throw new Error('At least two pilot roots are required.');
            directory = await mkdtemp(join(tmpdir(), 'cbranch-intelligence-'));
            const engagementId = EngagementId.make('pilot-workspace');
            const repositories = roots.map((root, index) => ({
                repoId: RepoId.make(`pilot-repo-${index + 1}`),
                root,
            }));
            const store = new WorkspaceIntelligenceArtifactStore({
                rootDirectory: join(directory, 'artifacts'),
                fileSystem: {
                    mkdir: async path => {
                        await mkdir(path, { recursive: true });
                    },
                    readText,
                    writeText: (path, text) => writeFile(path, text, 'utf8'),
                    readBytes: async path => {
                        try {
                            return new Uint8Array(await readFile(path));
                        } catch (error) {
                            if (
                                typeof error === 'object' &&
                                error !== null &&
                                'code' in error &&
                                error.code === 'ENOENT'
                            )
                                return undefined;
                            throw error;
                        }
                    },
                    writeBytes: (path, bytes) => writeFile(path, bytes),
                    rename,
                    listDirectory,
                    remove: path => rm(path, { recursive: true, force: true }),
                },
                digest: async text =>
                    createHash('sha256').update(text).digest('hex'),
            });
            let nextRunId = 0;
            const manager = new WorkspaceIntelligenceManager({
                store,
                maxConcurrentRuns: 1,
                workspace: {
                    resolveWorkspace: async id =>
                        id === engagementId
                            ? { engagementId, repositories }
                            : undefined,
                },
                runtime: {
                    now: () => Date.now(),
                    nextRunId: () => `pilot-run-${++nextRunId}`,
                    digest: async text =>
                        createHash('sha256').update(text).digest('hex'),
                    analyzerVersion: 'deterministic-source@4',
                    analyzeRepository: async repository => {
                        const inventory =
                            await collectWorkspaceIntelligenceSourceInventory(
                                repository.root,
                                ignoredPathsFor(repository.root),
                            );
                        const analysis = analyzeDeterministicSource(
                            repository.repoId,
                            inventory.files,
                        );
                        const verified =
                            await collectWorkspaceIntelligenceSourceInventory(
                                repository.root,
                                ignoredPathsFor(repository.root),
                            );
                        const changedDuringAnalysis =
                            inventory.sourceFingerprint !==
                            verified.sourceFingerprint;
                        const inventoryDegraded = inventory.unknowns.some(
                            observation =>
                                [
                                    'source.directory-unreadable',
                                    'source.files-unreadable',
                                    'source.file-limit-reached',
                                    'source.git-ignore-unavailable',
                                ].includes(String(observation.kind)),
                        );
                        return {
                            ...analysis,
                            unknowns: [
                                ...analysis.unknowns,
                                ...inventory.unknowns,
                                ...(changedDuringAnalysis
                                    ? [
                                          {
                                              kind: 'source.changed-during-analysis',
                                          },
                                      ]
                                    : []),
                            ],
                            isPartial:
                                inventoryDegraded || changedDuringAnalysis,
                            repository: {
                                repoId: repository.repoId,
                                sourceFileCount: inventory.files.length,
                                sourceFingerprint: inventory.sourceFingerprint,
                                analyzerVersion: 'deterministic-source@4',
                            },
                        };
                    },
                },
            });

            const started = await manager.start(engagementId);
            const events = [];
            for await (const event of manager.subscribe(
                engagementId,
                started.id,
            ))
                events.push(event);
            const completed = await manager.get(engagementId, started.id);
            const report = await manager.report(engagementId, started.id);
            const search = await manager.search(
                engagementId,
                started.id,
                'package',
                20,
            );
            const archive = await manager.archiveEntries(
                engagementId,
                started.id,
            );

            expect(['completed', 'partial']).toContain(completed.state);
            expect(completed.isValid).toBe(true);
            expect(completed.coverage.repositoryCount).toBe(
                repositories.length,
            );
            expect(completed.coverage.completedRepositoryCount).toBe(
                repositories.length,
            );
            expect(events.length).toBeGreaterThan(2);
            expect(report.nodeCount).toBeGreaterThan(0);
            expect(report.markdown).toContain('# Workspace Intelligence');
            expect(search.nodes.length).toBeGreaterThan(0);
            for (const entry of archive)
                for (const root of roots)
                    expect(entry.text).not.toContain(root);
        },
        180_000,
    );
});
