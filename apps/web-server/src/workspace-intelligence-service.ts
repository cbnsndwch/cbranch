// Host composition for the transport-neutral Workspace Intelligence package.
// Node filesystem and authoritative cbranch workspace resolution stay here; the
// package itself remains reusable and never imports core implementation details.

import { createHash, randomUUID } from 'node:crypto';
import {
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { GitEngine } from '@cbranch/core';
import { InferenceProfile } from '@cbranch/inference';
import {
    type GitErrorCode,
    GitError,
    type EngagementId,
} from '@cbranch/rpc-contract';
import {
    WorkspaceIntelligenceArtifactStore,
    WorkspaceIntelligenceEnrichmentStore,
    WorkspaceIntelligenceError,
    WorkspaceIntelligenceManager,
    WorkspaceIntelligenceSemanticIndexStore,
    analyzeDeterministicSource,
    defaultWorkspaceIntelligenceAnalysisSettings,
    type WorkspaceIntelligenceEnrichmentAttempt,
    type WorkspaceIntelligenceAnalysis,
    type WorkspaceIntelligenceAnalysisSettings,
    type WorkspaceIntelligenceSourceFile,
} from '@cbranch/workspace-intelligence';
import { Context, Effect, Layer } from 'effect';

import {
    environmentInferenceSecretResolver,
    openAICompatibleInferenceRunner,
} from './openai-compatible-inference';
import { openAICompatibleEmbeddingRunner } from './openai-compatible-embeddings';
import { localOllamaEmbeddingRunner } from './local-ollama-embeddings';
import { localClaudeCodeInferenceRunner } from './local-claude-code-inference';
import { localCodexInferenceRunner } from './local-codex-inference';
import { localOpenCodeInferenceRunner } from './local-opencode-inference';
import { runWorkspaceIntelligenceEnrichment } from './workspace-intelligence-enrichment';
import {
    searchWorkspaceIntelligenceSemantically,
    type WorkspaceIntelligenceSemanticSearchResult,
} from './workspace-intelligence-semantic-search';

export interface WorkspaceIntelligenceServiceApi {
    readonly manager: WorkspaceIntelligenceManager;
    readonly enrichments: WorkspaceIntelligenceEnrichmentStore;
    readonly enrich: (
        engagementId: EngagementId,
        runId: string,
        profileId?: string,
        evidenceLimit?: number,
    ) => Promise<WorkspaceIntelligenceEnrichmentAttempt>;
    /** Requests cancellation of one in-flight provider operation for this run. */
    readonly cancelEnrichment: (
        engagementId: EngagementId,
        runId: string,
    ) => Promise<void>;
    readonly listEnrichments: (
        engagementId: EngagementId,
        runId: string,
    ) => Promise<ReadonlyArray<WorkspaceIntelligenceEnrichmentAttempt>>;
    readonly preferredEnrichment: (
        engagementId: EngagementId,
        runId: string,
    ) => Promise<WorkspaceIntelligenceEnrichmentAttempt | undefined>;
    readonly setPreferredEnrichment: (
        engagementId: EngagementId,
        runId: string,
        attemptId?: string,
    ) => Promise<WorkspaceIntelligenceEnrichmentAttempt | undefined>;
    readonly semanticSearch: (
        engagementId: EngagementId,
        runId: string,
        query: string,
        limit?: number,
        profileId?: string,
    ) => Promise<WorkspaceIntelligenceSemanticSearchResult>;
}

export class WorkspaceIntelligenceService extends Context.Service<
    WorkspaceIntelligenceService,
    WorkspaceIntelligenceServiceApi
>()('WorkspaceIntelligenceService') {}

const dataDirectory = (): string =>
    join(
        process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
        'cbranch',
        'workspace-intelligence',
    );

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

const EXCLUDED_SOURCE_DIRECTORIES = new Set([
    '.git',
    'node_modules',
    'target',
    'dist',
    'build',
    '.next',
    'coverage',
    'vendor',
]);

const DETERMINISTIC_ANALYZER_VERSION = 'deterministic-source@4';

export const maxConcurrentWorkspaceIntelligenceRuns = (): number => {
    const configured = process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS;
    if (configured === undefined) return 2;
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(
            'CBRANCH_INTELLIGENCE_MAX_CONCURRENT_RUNS must be a positive integer.',
        );
    return parsed;
};

/** Provider work is bounded independently from deterministic analysis workers. */
export const maxConcurrentWorkspaceIntelligenceEnrichments = (): number => {
    const configured =
        process.env.CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS;
    if (configured === undefined) return 1;
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(
            'CBRANCH_INTELLIGENCE_MAX_CONCURRENT_ENRICHMENTS must be a positive integer.',
        );
    return parsed;
};

const relevantSourcePath = (path: string): boolean =>
    /\.(?:[cm]?[jt]sx?|rs|go|tf|xml|graphql|gql|proto)$|\.tf\.json$|(?:^|\/)(?:openapi|swagger|asyncapi)\.(?:json|ya?ml)$|(?:^|\/)(?:turbo|wrangler)\.(?:json|toml)$|(?:^|\/)(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$|(?:^|\/)(?:kustomization|deployment|service|configmap|ingress|statefulset|daemonset|job|cronjob|namespace|secret)\.ya?ml$|(?:^|\/)(?:[^/]+\.schema|schema)\.json$|(?:^|\/)package\.json$|(?:^|\/)pnpm-workspace\.yaml$|(?:^|\/)go\.(?:mod|work)$|Cargo\.toml$|tsconfig(?:\.[^/]+)?\.json$/.test(
        path,
    );

export interface WorkspaceIntelligenceSourceInventory {
    readonly files: ReadonlyArray<WorkspaceIntelligenceSourceFile>;
    readonly unknowns: ReadonlyArray<Record<string, unknown>>;
    readonly sourceFingerprint: string;
}

const globExpression = (pattern: string): RegExp => {
    let expression = '^';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index]!;
        if (character === '*') {
            if (pattern[index + 1] === '*') {
                index += 1;
                if (pattern[index + 1] === '/') {
                    index += 1;
                    expression += '(?:.*/)?';
                } else expression += '.*';
            } else expression += '[^/]*';
            continue;
        }
        if (character === '?') {
            expression += '[^/]';
            continue;
        }
        expression += /[\\^$.*+?()[\]{}|]/.test(character)
            ? `\\${character}`
            : character;
    }
    return new RegExp(`${expression}$`);
};

const sourcePathMatches = (
    path: string,
    patterns: ReadonlyArray<string>,
): boolean => patterns.some(pattern => globExpression(pattern).test(path));

/**
 * Read-only, root-bounded source inventory. Callers provide Git's ignored paths
 * through the core boundary; paths recorded in results are always root-relative.
 */
export const collectWorkspaceIntelligenceSourceInventory = async (
    root: string,
    ignoredPaths: ReadonlySet<string> | undefined,
    settings: WorkspaceIntelligenceAnalysisSettings = defaultWorkspaceIntelligenceAnalysisSettings,
): Promise<WorkspaceIntelligenceSourceInventory> => {
    const files: WorkspaceIntelligenceSourceFile[] = [];
    const observations: Record<string, unknown>[] = [];
    let irrelevantFileCount = 0;
    let ignoredFileCount = 0;
    let symlinkCount = 0;
    let excludedDirectoryCount = 0;
    let oversizedFileCount = 0;
    let unreadableFileCount = 0;
    let includeExcludedFileCount = 0;
    let excludeExcludedFileCount = 0;
    let repositoryByteLimitExcludedFileCount = 0;
    let sourceBytes = 0;
    let fileLimitReached = false;
    let repositoryByteLimitReached = false;
    let timeLimitReached = false;
    const deadline = Date.now() + settings.maxRepositoryDurationMs;

    const relativePath = (path: string): string =>
        relative(root, path).replaceAll('\\', '/');
    const normalizedIgnoredPaths =
        ignoredPaths === undefined
            ? undefined
            : new Set(
                  [...ignoredPaths]
                      .map(path =>
                          path
                              .replaceAll('\\', '/')
                              .replace(/^\.\//, '')
                              .replace(/\/$/, ''),
                      )
                      .filter(Boolean),
              );
    const isIgnored = (path: string): boolean => {
        if (normalizedIgnoredPaths === undefined) return false;
        let candidate = path;
        while (true) {
            if (normalizedIgnoredPaths.has(candidate)) return true;
            const slash = candidate.lastIndexOf('/');
            if (slash === -1) return false;
            candidate = candidate.slice(0, slash);
        }
    };
    const visit = async (directory: string): Promise<void> => {
        if (Date.now() >= deadline) {
            timeLimitReached = true;
            return;
        }
        if (files.length >= settings.maxSourceFiles) {
            fileLimitReached = true;
            return;
        }
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            observations.push({
                kind: 'source.directory-unreadable',
                path: relativePath(directory),
            });
            return;
        }
        for (const entry of entries.sort((left, right) =>
            left.name.localeCompare(right.name),
        )) {
            if (Date.now() >= deadline) {
                timeLimitReached = true;
                return;
            }
            if (files.length >= settings.maxSourceFiles) {
                fileLimitReached = true;
                return;
            }
            if (entry.isSymbolicLink()) {
                symlinkCount += 1;
                continue;
            }
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                const pathFromRoot = relativePath(path);
                if (isIgnored(pathFromRoot)) {
                    ignoredFileCount += 1;
                    continue;
                }
                if (EXCLUDED_SOURCE_DIRECTORIES.has(entry.name)) {
                    excludedDirectoryCount += 1;
                    continue;
                }
                await visit(path);
                continue;
            }
            if (!entry.isFile()) continue;
            const pathFromRoot = relativePath(path);
            if (isIgnored(pathFromRoot)) {
                ignoredFileCount += 1;
                continue;
            }
            if (!relevantSourcePath(pathFromRoot)) {
                irrelevantFileCount += 1;
                continue;
            }
            if (
                settings.includePatterns.length > 0 &&
                !sourcePathMatches(pathFromRoot, settings.includePatterns)
            ) {
                includeExcludedFileCount += 1;
                continue;
            }
            if (sourcePathMatches(pathFromRoot, settings.excludePatterns)) {
                excludeExcludedFileCount += 1;
                continue;
            }
            let size: number;
            try {
                size = (await lstat(path)).size;
            } catch {
                unreadableFileCount += 1;
                continue;
            }
            if (size > settings.maxSourceFileBytes) {
                oversizedFileCount += 1;
                continue;
            }
            if (sourceBytes + size > settings.maxRepositorySourceBytes) {
                repositoryByteLimitReached = true;
                repositoryByteLimitExcludedFileCount += 1;
                continue;
            }
            let content: Buffer;
            try {
                content = await readFile(path);
            } catch {
                unreadableFileCount += 1;
                continue;
            }
            if (content.includes(0)) {
                observations.push({
                    kind: 'source.binary-excluded',
                    path: pathFromRoot,
                });
                continue;
            }
            files.push({
                path: pathFromRoot,
                text: content.toString('utf8'),
            });
            sourceBytes += size;
        }
    };
    await visit(root);
    const summarize = (kind: string, count: number, message: string) => {
        if (count > 0) observations.push({ kind, count, message });
    };
    summarize(
        'source.irrelevant-files-excluded',
        irrelevantFileCount,
        'Files outside the pilot source/config allowlist were excluded.',
    );
    summarize(
        'source.git-ignored-excluded',
        ignoredFileCount,
        'Git-ignored source paths were excluded from deterministic analysis.',
    );
    summarize(
        'source.symlinks-excluded',
        symlinkCount,
        'Symlinks are never traversed outside the validated repository root.',
    );
    summarize(
        'source.directories-excluded',
        excludedDirectoryCount,
        'Dependency and ordinary build-output directories were excluded.',
    );
    summarize(
        'source.byte-limit-excluded',
        oversizedFileCount,
        `Relevant files larger than ${settings.maxSourceFileBytes} bytes were excluded.`,
    );
    summarize(
        'source.workspace-include-excluded',
        includeExcludedFileCount,
        'Relevant files outside the workspace include patterns were excluded.',
    );
    summarize(
        'source.workspace-exclude-excluded',
        excludeExcludedFileCount,
        'Relevant files matching workspace exclude patterns were excluded.',
    );
    summarize(
        'source.repository-byte-limit-excluded',
        repositoryByteLimitExcludedFileCount,
        `Relevant files beyond the ${settings.maxRepositorySourceBytes} byte repository budget were excluded.`,
    );
    summarize(
        'source.files-unreadable',
        unreadableFileCount,
        'Relevant files that could not be read were excluded.',
    );
    if (fileLimitReached)
        observations.push({
            kind: 'source.file-limit-reached',
            limit: settings.maxSourceFiles,
            message:
                'The source inventory stopped at its deterministic file limit.',
        });
    if (repositoryByteLimitReached)
        observations.push({
            kind: 'source.repository-byte-limit-reached',
            limit: settings.maxRepositorySourceBytes,
            message:
                'The source inventory stopped accepting files at its repository byte budget.',
        });
    if (timeLimitReached)
        observations.push({
            kind: 'source.repository-time-limit-reached',
            limit: settings.maxRepositoryDurationMs,
            message:
                'The source inventory stopped at its repository analysis time budget.',
        });
    if (ignoredPaths === undefined)
        observations.push({
            kind: 'source.git-ignore-unavailable',
            message:
                'Git ignored-path information was unavailable; the known dependency/build directory exclusions still applied.',
        });
    const orderedFiles = [...files].sort((left, right) =>
        left.path.localeCompare(right.path),
    );
    const sourceFingerprint = createHash('sha256')
        .update(
            orderedFiles.map(file => `${file.path}\0${file.text}`).join('\0'),
        )
        .digest('hex');
    return {
        files: orderedFiles,
        unknowns: observations.sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
        sourceFingerprint,
    };
};

/**
 * Enforces persisted graph budgets after deterministic analysis. This preserves
 * the analyzer's canonical ordering and makes every omitted record an explicit
 * capability observation rather than silently producing a smaller graph.
 */
export const applyWorkspaceIntelligenceGraphBudget = (
    analysis: WorkspaceIntelligenceAnalysis,
    settings: WorkspaceIntelligenceAnalysisSettings,
): WorkspaceIntelligenceAnalysis => {
    const nodes = analysis.nodes.slice(0, settings.maxGraphNodes);
    const nodeLimitReached = nodes.length !== analysis.nodes.length;
    const retainedNodeIds = new Set(
        nodes.flatMap(node => (typeof node.id === 'string' ? [node.id] : [])),
    );
    const candidateEdges = nodeLimitReached
        ? analysis.edges.filter(
              edge =>
                  typeof edge.from === 'string' &&
                  typeof edge.to === 'string' &&
                  retainedNodeIds.has(edge.from) &&
                  retainedNodeIds.has(edge.to),
          )
        : analysis.edges;
    const edges = candidateEdges.slice(0, settings.maxGraphEdges);
    const edgeLimitReached = edges.length !== candidateEdges.length;
    if (!nodeLimitReached && !edgeLimitReached) return analysis;
    return {
        ...analysis,
        nodes,
        edges,
        unknowns: [
            ...analysis.unknowns,
            ...(nodeLimitReached
                ? [
                      {
                          kind: 'graph.node-limit-reached',
                          limit: settings.maxGraphNodes,
                          omitted: analysis.nodes.length - nodes.length,
                      },
                  ]
                : []),
            ...(edgeLimitReached
                ? [
                      {
                          kind: 'graph.edge-limit-reached',
                          limit: settings.maxGraphEdges,
                          omitted: candidateEdges.length - edges.length,
                      },
                  ]
                : []),
        ],
        report: [
            ...analysis.report,
            ...(nodeLimitReached
                ? [
                      `- Graph nodes truncated at workspace budget ${settings.maxGraphNodes}`,
                  ]
                : []),
            ...(edgeLimitReached
                ? [
                      `- Graph edges truncated at workspace budget ${settings.maxGraphEdges}`,
                  ]
                : []),
        ],
        isPartial: true,
    };
};

const errorCode = (error: unknown): GitErrorCode =>
    error instanceof WorkspaceIntelligenceError ? error.code : 'fsError';

export const workspaceIntelligenceError = (error: unknown): GitError =>
    new GitError({
        code: errorCode(error),
        message:
            error instanceof Error
                ? error.message
                : 'Workspace Intelligence host operation failed.',
    });

/** Host-owned service, reconciled once during server-layer startup. */
export const workspaceIntelligenceLayer = Layer.effect(
    WorkspaceIntelligenceService,
    Effect.gen(function* () {
        const engine = yield* GitEngine;
        const fileSystem = {
            mkdir: async (path: string) => {
                await mkdir(path, { recursive: true });
            },
            readText,
            writeText: (path: string, text: string) =>
                writeFile(path, text, 'utf8'),
            readBytes: async (path: string) => {
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
            writeBytes: (path: string, bytes: Uint8Array) =>
                writeFile(path, bytes),
            rename,
            listDirectory,
            remove: (path: string) =>
                rm(path, { recursive: true, force: true }),
        };
        const store = new WorkspaceIntelligenceArtifactStore({
            rootDirectory: dataDirectory(),
            fileSystem,
            digest: async text =>
                createHash('sha256').update(text).digest('hex'),
        });
        const enrichments = new WorkspaceIntelligenceEnrichmentStore({
            artifacts: store,
            fileSystem,
        });
        const semanticIndexes = new WorkspaceIntelligenceSemanticIndexStore({
            artifacts: store,
            fileSystem,
            digest: async text =>
                createHash('sha256').update(text).digest('hex'),
        });
        const maxConcurrentEnrichments =
            maxConcurrentWorkspaceIntelligenceEnrichments();
        let activeInference = 0;
        const activeEnrichments = new Map<string, AbortController>();
        const enrichmentKey = (engagementId: EngagementId, runId: string) =>
            `${engagementId}\0${runId}`;
        const runInference = async <Result>(
            operation: () => Promise<Result>,
        ): Promise<Result> => {
            if (activeInference >= maxConcurrentEnrichments)
                throw new Error(
                    'The host is already running the maximum number of inference requests.',
                );
            activeInference += 1;
            try {
                return await operation();
            } finally {
                activeInference -= 1;
            }
        };
        const manager = new WorkspaceIntelligenceManager({
            store,
            maxConcurrentRuns: maxConcurrentWorkspaceIntelligenceRuns(),
            workspace: {
                resolveWorkspace: async engagementId => {
                    const workspace = await Effect.runPromise(
                        engine.engagementList(),
                    );
                    const engagement = workspace.engagements.find(
                        item => item.id === engagementId,
                    );
                    if (engagement === undefined) return undefined;
                    return {
                        engagementId: engagement.id as EngagementId,
                        repositories: engagement.repositories.map(
                            repository => ({
                                repoId: repository.repoId,
                                root: repository.path,
                            }),
                        ),
                    };
                },
            },
            runtime: {
                now: () => Date.now(),
                nextRunId: randomUUID,
                digest: async text =>
                    createHash('sha256').update(text).digest('hex'),
                analyzerVersion: DETERMINISTIC_ANALYZER_VERSION,
                fingerprintRepository: async (repository, settings) => {
                    const ignoredPaths = await Effect.runPromise(
                        engine.statusGet(repository.repoId, true),
                    )
                        .then(
                            status =>
                                new Set(
                                    status.entries
                                        .filter(entry => entry.isIgnored)
                                        .map(entry => entry.path),
                                ),
                        )
                        .catch(() => undefined);
                    return (
                        await collectWorkspaceIntelligenceSourceInventory(
                            repository.root,
                            ignoredPaths,
                            settings,
                        )
                    ).sourceFingerprint;
                },
                analyzeRepository: async (repository, settings) => {
                    const ignoredPaths = await Effect.runPromise(
                        engine.statusGet(repository.repoId, true),
                    )
                        .then(
                            status =>
                                new Set(
                                    status.entries
                                        .filter(entry => entry.isIgnored)
                                        .map(entry => entry.path),
                                ),
                        )
                        .catch(() => undefined);
                    const inventory =
                        await collectWorkspaceIntelligenceSourceInventory(
                            repository.root,
                            ignoredPaths,
                            settings,
                        );
                    const analysis = applyWorkspaceIntelligenceGraphBudget(
                        analyzeDeterministicSource(
                            repository.repoId,
                            inventory.files,
                        ),
                        settings,
                    );
                    const finalInventory =
                        await collectWorkspaceIntelligenceSourceInventory(
                            repository.root,
                            ignoredPaths,
                            settings,
                        );
                    const changedDuringAnalysis =
                        inventory.sourceFingerprint !==
                        finalInventory.sourceFingerprint;
                    const inventoryDegraded = inventory.unknowns.some(
                        observation =>
                            [
                                'source.directory-unreadable',
                                'source.files-unreadable',
                                'source.byte-limit-excluded',
                                'source.file-limit-reached',
                                'source.repository-byte-limit-excluded',
                                'source.repository-byte-limit-reached',
                                'source.repository-time-limit-reached',
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
                                          message:
                                              'Relevant source inputs changed between inventory and analysis verification.',
                                      },
                                  ]
                                : []),
                        ],
                        isPartial:
                            analysis.isPartial ||
                            inventoryDegraded ||
                            changedDuringAnalysis,
                        repository: {
                            repoId: repository.repoId,
                            sourceFileCount: inventory.files.length,
                            sourceFingerprint: inventory.sourceFingerprint,
                            analyzerVersion: DETERMINISTIC_ANALYZER_VERSION,
                        },
                    };
                },
            },
        });
        // A corrupt optional Intelligence history must not prevent the Git host from
        // starting. Individual artifact reads still surface an invalid/tampered run.
        yield* Effect.ignore(Effect.promise(() => manager.reconcile()));
        return {
            manager,
            enrichments,
            enrich: async (
                engagementId,
                runId,
                requestedProfileId,
                requestedEvidenceLimit,
            ) => {
                const key = enrichmentKey(engagementId, runId);
                if (activeEnrichments.has(key))
                    throw new WorkspaceIntelligenceError(
                        'repoLocked',
                        'An enrichment attempt is already active for this run.',
                    );
                const controller = new AbortController();
                activeEnrichments.set(key, controller);
                try {
                    return await runInference(() =>
                        runWorkspaceIntelligenceEnrichment({
                            engagementId,
                            runId,
                            requestedProfileId,
                            requestedEvidenceLimit,
                            runs: manager,
                            evidence: store,
                            attempts: enrichments,
                            profiles: async () =>
                                (
                                    await Effect.runPromise(
                                        engine.inferenceProfilesGet(),
                                    )
                                ).map(profile =>
                                    InferenceProfile.parse(profile),
                                ),
                            defaults: () =>
                                Effect.runPromise(
                                    engine.workspaceInferenceDefaultsGet(
                                        engagementId,
                                    ),
                                ),
                            runnerForProfile: (profile, signal) => {
                                const secrets =
                                    environmentInferenceSecretResolver();
                                if (profile.provider === 'claude-code')
                                    return localClaudeCodeInferenceRunner({
                                        profile,
                                        secrets,
                                        signal,
                                    });
                                if (profile.provider === 'codex')
                                    return localCodexInferenceRunner({
                                        profile,
                                        secrets,
                                        signal,
                                    });
                                if (profile.provider === 'opencode')
                                    return localOpenCodeInferenceRunner({
                                        profile,
                                        secrets,
                                        signal,
                                    });
                                return openAICompatibleInferenceRunner({
                                    profile,
                                    secrets,
                                    signal,
                                });
                            },
                            now: () => Date.now(),
                            nextAttemptId: randomUUID,
                            signal: controller.signal,
                        }),
                    );
                } finally {
                    if (activeEnrichments.get(key) === controller)
                        activeEnrichments.delete(key);
                }
            },
            cancelEnrichment: async (engagementId, runId) => {
                const controller = activeEnrichments.get(
                    enrichmentKey(engagementId, runId),
                );
                if (controller === undefined)
                    throw new WorkspaceIntelligenceError(
                        'repoNotFound',
                        'No active enrichment attempt exists for this run.',
                    );
                controller.abort();
            },
            listEnrichments: (engagementId, runId) =>
                enrichments.listAttempts(engagementId, runId),
            preferredEnrichment: (engagementId, runId) =>
                enrichments.preferredAttempt(engagementId, runId),
            setPreferredEnrichment: async (engagementId, runId, attemptId) => {
                await enrichments.setPreferredAttempt(
                    engagementId,
                    runId,
                    attemptId,
                );
                return enrichments.preferredAttempt(engagementId, runId);
            },
            semanticSearch: async (
                engagementId,
                runId,
                query,
                limit,
                requestedProfileId,
            ) => {
                if (activeInference >= maxConcurrentEnrichments)
                    return {
                        mode: 'lexical-fallback',
                        nodes: (
                            await manager.search(
                                engagementId,
                                runId,
                                query,
                                limit,
                            )
                        ).nodes,
                        message: 'Inference is busy; showing lexical results.',
                    };
                return runInference(() =>
                    searchWorkspaceIntelligenceSemantically({
                        engagementId,
                        runId,
                        query,
                        requestedLimit: limit,
                        requestedProfileId,
                        lexicalSearch: (id, selectedRunId, search, max) =>
                            manager.search(id, selectedRunId, search, max),
                        rankedNodes: (id, selectedRunId, nodeIds, max) =>
                            manager.nodesById(id, selectedRunId, nodeIds, max),
                        chunks: async (id, selectedRunId) => {
                            const run = await manager.get(id, selectedRunId);
                            if (!run.isValid)
                                throw new Error(
                                    'Only a valid finalized deterministic run can be searched semantically.',
                                );
                            return store.inferenceEvidence(
                                id,
                                selectedRunId,
                                200,
                            );
                        },
                        indexes: semanticIndexes,
                        profiles: async () =>
                            (
                                await Effect.runPromise(
                                    engine.inferenceProfilesGet(),
                                )
                            ).map(profile => InferenceProfile.parse(profile)),
                        defaults: () =>
                            Effect.runPromise(
                                engine.workspaceInferenceDefaultsGet(
                                    engagementId,
                                ),
                            ),
                        runnerForProfile: profile =>
                            profile.provider === 'local-embeddings'
                                ? localOllamaEmbeddingRunner({ profile })
                                : openAICompatibleEmbeddingRunner({
                                      profile,
                                      secrets:
                                          environmentInferenceSecretResolver(),
                                  }),
                    }),
                );
            },
        };
    }),
);
