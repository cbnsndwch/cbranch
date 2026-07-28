// RPC handler bindings (docs/spec/14 §7; DECISIONS D1).
//
// Maps every method of the single `CbranchRpcs` catalog to the corresponding
// `GitEngine` operation. The handler keys are the on-wire PascalCase tags (D1);
// unary methods return an `Effect`, the two streaming methods (`RepoSubscribe`,
// `LogStream`) return a `Stream` (`Stream.unwrap` threads the `GitEngine` service in).
// Every handler calls THROUGH the engine and never touches git directly
// (REQ-ARCH-010); the produced layer requires `GitEngine` and provides the RPC
// handler context the server runtime consumes.

import { GitEngine } from '@cbranch/core';
import { InferenceProfile } from '@cbranch/inference';
import {
    CBRANCH_PROTOCOL_VERSION,
    CbranchRpcs,
    SystemInfo,
    WorkspaceIntelligenceEnrichmentAttempt as RpcWorkspaceIntelligenceEnrichmentAttempt,
    WorkspaceIntelligenceEnrichmentFailure,
    WorkspaceIntelligenceEnrichmentUsage,
    WorkspaceIntelligenceInferredEdge,
    WorkspaceIntelligenceArchiveDescriptor,
    WorkspaceIntelligenceRunId,
    WorkspaceIntelligenceSemanticSearchResult,
    InferenceModelDiscovery as RpcInferenceModelDiscovery,
} from '@cbranch/rpc-contract';
import type { WorkspaceIntelligenceEnrichmentAttempt } from '@cbranch/workspace-intelligence';
import { Effect, Stream } from 'effect';

import { getUpload } from './patch-channel';
import { PluginManager } from './plugin-manager';
import { serverVersion } from './server-version';
import {
    discoverInferenceProfiles,
    validateEnabledLocalInferenceProfiles,
} from './inference-profile-discovery';
import { environmentInferenceSecretResolver } from './openai-compatible-inference';
import { discoverOpenAICompatibleModels } from './openai-compatible-model-discovery';
import {
    mintWorkspaceIntelligenceArchiveToken,
    WORKSPACE_INTELLIGENCE_ARCHIVE_CHANNEL_PATH,
} from './workspace-intelligence-archive-channel';
import {
    WorkspaceIntelligenceService,
    workspaceIntelligenceError,
} from './workspace-intelligence-service';

const rpcEnrichmentAttempt = (
    attempt: WorkspaceIntelligenceEnrichmentAttempt,
): RpcWorkspaceIntelligenceEnrichmentAttempt =>
    new RpcWorkspaceIntelligenceEnrichmentAttempt({
        ...attempt,
        runId: WorkspaceIntelligenceRunId.make(attempt.runId),
        inferredEdges: attempt.inferredEdges.map(
            edge => new WorkspaceIntelligenceInferredEdge(edge),
        ),
        ...(attempt.usage === undefined
            ? {}
            : {
                  usage: new WorkspaceIntelligenceEnrichmentUsage(
                      attempt.usage,
                  ),
              }),
        ...(attempt.failure === undefined
            ? {}
            : {
                  failure: new WorkspaceIntelligenceEnrichmentFailure(
                      attempt.failure,
                  ),
              }),
    });

/** The RPC contract requires a schema-class instance before NDJSON encoding. */
export const workspaceIntelligenceArchiveDescriptor = (
    runId: string,
    token: string,
): WorkspaceIntelligenceArchiveDescriptor =>
    new WorkspaceIntelligenceArchiveDescriptor({
        url: `${WORKSPACE_INTELLIGENCE_ARCHIVE_CHANNEL_PATH}?token=${encodeURIComponent(token)}`,
        filename: `workspace-intelligence-${runId}.tar`,
        contentType: 'application/x-tar',
    });

/** Layer providing the P1 RPC handlers; requires `GitEngine` (supplied by `gitEngineLayer`). */
export const handlersLayer = CbranchRpcs.toLayer({
    // ── connection bootstrap ───────────────────────────────────────────────────
    SystemInfo: () =>
        Effect.succeed(
            new SystemInfo({
                version: serverVersion(),
                protocolVersion: CBRANCH_PROTOCOL_VERSION,
                capabilities: [
                    'system-info',
                    'loopback-rpc-v1',
                    'side-channel-v1',
                ],
            }),
        ),

    // ── P9: runtime plugins ────────────────────────────────────────────────────
    PluginRepositoryList: () =>
        Effect.flatMap(PluginManager, manager => manager.repositoryList()),
    PluginRuntimeStatus: () =>
        Effect.flatMap(PluginManager, manager => manager.runtimeStatus()),
    PluginRepositoryAdd: input =>
        Effect.flatMap(PluginManager, manager => manager.repositoryAdd(input)),
    PluginRepositoryRefresh: input =>
        Effect.flatMap(PluginManager, manager =>
            manager.repositoryRefresh(input),
        ),
    PluginRepositoryRemove: input =>
        Effect.flatMap(PluginManager, manager =>
            manager.repositoryRemove(input),
        ),
    PluginPublisherTrust: input =>
        Effect.flatMap(PluginManager, manager => manager.publisherTrust(input)),
    PluginCatalogList: input =>
        Effect.flatMap(PluginManager, manager => manager.catalogList(input)),
    PluginInstall: input =>
        Effect.flatMap(PluginManager, manager => manager.install(input)),
    PluginInstallReview: input =>
        Effect.flatMap(PluginManager, manager => manager.installReview(input)),
    PluginList: () => Effect.flatMap(PluginManager, manager => manager.list()),
    PluginEnable: input =>
        Effect.flatMap(PluginManager, manager => manager.enable(input)),
    PluginDisable: input =>
        Effect.flatMap(PluginManager, manager => manager.disable(input)),
    PluginUninstall: input =>
        Effect.flatMap(PluginManager, manager => manager.uninstall(input)),
    PluginAuditList: input =>
        Effect.flatMap(PluginManager, manager => manager.auditList(input)),
    PluginInvoke: input =>
        Effect.flatMap(PluginManager, manager => manager.invoke(input)),

    // ── repository & live state ────────────────────────────────────────────────
    RepoOpen: ({ path }) =>
        Effect.flatMap(GitEngine, engine => engine.open(path)),
    RepoRecentList: () =>
        Effect.flatMap(GitEngine, engine => engine.recentList()),
    RepoRecentRemove: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.recentRemove(repoId)),
    FilesystemListDir: ({ path, showHidden }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.filesystemListDir({ path, showHidden }),
        ),
    EngagementDirectoryPreview: ({ path }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementDirectoryPreview(path),
        ),
    EngagementList: () =>
        Effect.flatMap(GitEngine, engine => engine.engagementList()),
    EngagementCreate: ({ name, color, slug, avatarUrl }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementCreate(name, color, avatarUrl, slug),
        ),
    EngagementDirectoryImport: ({ path, candidateRoots, target }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementDirectoryImport({ path, candidateRoots, target }),
        ),
    EngagementUpdate: ({ engagementId, name, slug, color, avatarUrl }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementUpdate(engagementId, {
                name,
                slug,
                color,
                avatarUrl,
            }),
        ),
    EngagementDelete: ({ engagementId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementDelete(engagementId),
        ),
    EngagementReorder: ({ engagementIds }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementReorder(engagementIds),
        ),
    EngagementRepoAssign: ({ engagementId, repoId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementRepoAssign(engagementId, repoId),
        ),
    EngagementRepoRemove: ({ engagementId, repoId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementRepoRemove(engagementId, repoId),
        ),
    EngagementSessionSet: ({ engagementId, openRepoIds, activeRepoId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementSessionSet(
                engagementId,
                openRepoIds,
                activeRepoId,
            ),
        ),
    EngagementActivate: ({ engagementId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.engagementActivate(engagementId),
        ),
    WorkspaceIntelligenceStart: ({ engagementId, repoIds, analysisSettings }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.start(
                        engagementId,
                        repoIds,
                        analysisSettings,
                    ),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceAnalysisSettings: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.analysisSettings(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceAnalysisSettingsSet: ({ engagementId, settings }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.setAnalysisSettings(engagementId, settings),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligencePresentationGet: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.presentation(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligencePresentationSet: ({ engagementId, presentation }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.setPresentation(engagementId, presentation),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunGet: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.get(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunReport: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.report(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceGraphSearch: ({ engagementId, runId, query, limit }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.search(engagementId, runId, query, limit),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceSemanticSearch: ({
        engagementId,
        runId,
        query,
        limit,
        profileId,
    }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: async () => {
                    const result = await service.semanticSearch(
                        engagementId,
                        runId,
                        query,
                        limit,
                        profileId,
                    );
                    return new WorkspaceIntelligenceSemanticSearchResult(
                        result,
                    );
                },
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceGraphNeighborhood: ({
        engagementId,
        runId,
        nodeId,
        limit,
    }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.neighborhood(
                        engagementId,
                        runId,
                        nodeId,
                        limit,
                    ),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceGraphDiff: ({ engagementId, fromRunId, toRunId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.diff(engagementId, fromRunId, toRunId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceComponentOverrides: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.componentOverrides(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceComponentOverridesSet: ({ engagementId, overrides }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.setComponentOverrides(
                        engagementId,
                        overrides,
                    ),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceCurationActions: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.curationActions(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceCurationActionAppend: ({ engagementId, action }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () =>
                    service.manager.appendCurationAction(engagementId, action),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceCurationActionsClear: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.clearCurationActions(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunList: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.list(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunCancel: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.cancel(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunDelete: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.deleteRun(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceCurrentSet: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.setCurrent(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceCurrentClear: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.clearCurrent(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunHistoryClear: ({ engagementId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.manager.clearRunHistory(engagementId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceArchiveRequest: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: async () => {
                    await service.manager.prepareArchive(engagementId, runId);
                    const token = mintWorkspaceIntelligenceArchiveToken(
                        engagementId,
                        runId,
                    );
                    return workspaceIntelligenceArchiveDescriptor(runId, token);
                },
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceRunSubscribe: ({
        engagementId,
        runId,
        afterSequence,
    }) =>
        Stream.unwrap(
            Effect.map(WorkspaceIntelligenceService, service =>
                Stream.fromAsyncIterable(
                    service.manager.subscribe(
                        engagementId,
                        runId,
                        afterSequence,
                    ),
                    workspaceIntelligenceError,
                ),
            ),
        ),
    WorkspaceIntelligenceEnrichmentStart: ({
        engagementId,
        runId,
        profileId,
        evidenceLimit,
    }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: async () =>
                    rpcEnrichmentAttempt(
                        await service.enrich(
                            engagementId,
                            runId,
                            profileId,
                            evidenceLimit,
                        ),
                    ),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceEnrichmentCancel: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: () => service.cancelEnrichment(engagementId, runId),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceEnrichmentList: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: async () =>
                    (await service.listEnrichments(engagementId, runId)).map(
                        rpcEnrichmentAttempt,
                    ),
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceEnrichmentPreferredGet: ({ engagementId, runId }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: async () => {
                    const attempt = await service.preferredEnrichment(
                        engagementId,
                        runId,
                    );
                    return attempt === undefined
                        ? undefined
                        : rpcEnrichmentAttempt(attempt);
                },
                catch: workspaceIntelligenceError,
            }),
        ),
    WorkspaceIntelligenceEnrichmentPreferredSet: ({
        engagementId,
        runId,
        attemptId,
    }) =>
        Effect.flatMap(WorkspaceIntelligenceService, service =>
            Effect.tryPromise({
                try: async () => {
                    const attempt = await service.setPreferredEnrichment(
                        engagementId,
                        runId,
                        attemptId,
                    );
                    return attempt === undefined
                        ? undefined
                        : rpcEnrichmentAttempt(attempt);
                },
                catch: workspaceIntelligenceError,
            }),
        ),
    // ── inference profile settings ─────────────────────────────────────────────
    // Profiles contain only host-local configuration and credential references.
    // The engine/config store rejects credential values and does not invoke providers.
    InferenceProfilesGet: () =>
        Effect.flatMap(GitEngine, engine => engine.inferenceProfilesGet()),
    InferenceProfilesDiscover: () =>
        Effect.promise(() => discoverInferenceProfiles()),
    InferenceModelsDiscover: ({ profileId }) =>
        Effect.flatMap(GitEngine, engine =>
            Effect.tryPromise({
                try: async () => {
                    const profiles = await Effect.runPromise(
                        engine.inferenceProfilesGet(),
                    );
                    const profile = profiles.find(
                        candidate => candidate.id === profileId,
                    );
                    if (profile === undefined)
                        throw new Error(
                            'The selected inference profile no longer exists.',
                        );
                    return new RpcInferenceModelDiscovery(
                        await discoverOpenAICompatibleModels({
                            profile: InferenceProfile.parse(profile),
                            secrets: environmentInferenceSecretResolver(),
                        }),
                    );
                },
                catch: workspaceIntelligenceError,
            }),
        ),
    InferenceProfilesSet: ({ profiles }) =>
        Effect.flatMap(
            Effect.tryPromise({
                try: async () => {
                    const normalized = profiles.map(profile =>
                        InferenceProfile.parse(profile),
                    );
                    validateEnabledLocalInferenceProfiles(
                        normalized,
                        await discoverInferenceProfiles(),
                    );
                },
                catch: workspaceIntelligenceError,
            }),
            () =>
                Effect.flatMap(GitEngine, engine =>
                    engine.inferenceProfilesSet(profiles),
                ),
        ),
    WorkspaceInferenceDefaultsGet: ({ engagementId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.workspaceInferenceDefaultsGet(engagementId),
        ),
    WorkspaceInferenceDefaultsSet: ({ engagementId, defaults }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.workspaceInferenceDefaultsSet(engagementId, defaults),
        ),
    ChangeSetCreate: ({ engagementId, name, description }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.changeSetCreate(engagementId, name, description),
        ),
    ChangeSetUpdate: ({ engagementId, changeSetId, name, description }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.changeSetUpdate(engagementId, changeSetId, {
                name,
                description,
            }),
        ),
    ChangeSetDelete: ({ engagementId, changeSetId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.changeSetDelete(engagementId, changeSetId),
        ),
    ChangeSetItemsSet: ({ engagementId, changeSetId, items }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.changeSetItemsSet(engagementId, changeSetId, items),
        ),
    GitHubPullsList: ({ repoId, state }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.githubPullsList(repoId, state),
        ),
    GitHubPullPreview: ({ repoId, baseRefName }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.githubPullPreview(repoId, baseRefName),
        ),
    GitHubPullCreate: ({ repoId, title, body, baseRefName, draft }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.githubPullCreate(repoId, {
                title,
                body,
                baseRefName,
                draft,
            }),
        ),
    RepoState: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.state(repoId)),
    RepoSubscribe: ({ repoId }) =>
        Stream.unwrap(
            Effect.map(GitEngine, engine => engine.subscribe(repoId)),
        ),

    // ── history & diff & content ───────────────────────────────────────────────
    LogStream: query =>
        Stream.unwrap(Effect.map(GitEngine, engine => engine.logStream(query))),
    CommitDetail: ({ repoId, oid }) =>
        Effect.flatMap(GitEngine, engine => engine.commitDetail(repoId, oid)),
    CommitTree: ({ repoId, oid }) =>
        Effect.flatMap(GitEngine, engine => engine.commitTree(repoId, oid)),
    CommitDiff: spec =>
        Effect.flatMap(GitEngine, engine => engine.commitDiff(spec)),
    DiffWorkingFile: ({ repoId, path, staged }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.diffWorkingFile(repoId, path, staged),
        ),
    FileContentAtRev: ({ repoId, path, rev }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.fileContentAtRev(repoId, path, rev),
        ),

    // ── stage & commit (P2) ────────────────────────────────────────────────────
    StatusGet: ({ repoId, includeIgnored }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.statusGet(repoId, includeIgnored),
        ),
    StageFiles: ({ repoId, paths, all }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.stageFiles(repoId, paths, all),
        ),
    UnstageFiles: ({ repoId, paths, all }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.unstageFiles(repoId, paths, all),
        ),
    DiscardFiles: ({ repoId, paths }) =>
        Effect.flatMap(GitEngine, engine => engine.discardFiles(repoId, paths)),
    DeleteUntracked: ({ repoId, paths }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.deleteUntracked(repoId, paths),
        ),
    ResetTo: ({ repoId, mode, target }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.resetTo(repoId, mode, target),
        ),
    StageHunks: selection =>
        Effect.flatMap(GitEngine, engine => engine.stageHunks(selection)),
    UnstageHunks: selection =>
        Effect.flatMap(GitEngine, engine => engine.unstageHunks(selection)),
    DiscardHunks: selection =>
        Effect.flatMap(GitEngine, engine => engine.discardHunks(selection)),
    CommitCreate: input =>
        Effect.flatMap(GitEngine, engine => engine.commitCreate(input)),
    CommitLastMessage: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.commitLastMessage(repoId)),

    // ── branches (P3) ─────────────────────────────────────────────────────────
    BranchList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.branchList(repoId)),
    BranchCreate: ({ repoId, name, startPoint, setUpstream, switchAfter }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.branchCreate(
                repoId,
                name,
                startPoint,
                setUpstream,
                switchAfter,
            ),
        ),
    BranchSwitch: ({ repoId, target, strategy, stashAndReapply }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.branchSwitch(repoId, target, strategy, stashAndReapply),
        ),
    BranchCheckoutDetached: ({ repoId, ref }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.branchCheckoutDetached(repoId, ref),
        ),
    BranchRename: ({ repoId, oldName, newName }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.branchRename(repoId, oldName, newName),
        ),
    BranchDelete: ({ repoId, name, force }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.branchDelete(repoId, name, force),
        ),
    BranchSetUpstream: ({ repoId, name, upstream }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.branchSetUpstream(repoId, name, upstream),
        ),

    // ── merge (P3) ────────────────────────────────────────────────────────────
    MergeCreate: ({ repoId, ref, strategy, message }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.mergeCreate(repoId, ref, strategy, message),
        ),
    MergeAbort: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.mergeAbort(repoId)),

    // ── sync (P3) ─────────────────────────────────────────────────────────────
    FetchStream: ({ repoId, remote, all, prune, tags }) =>
        Stream.unwrap(
            Effect.map(GitEngine, engine =>
                engine.fetchStream(repoId, remote, all, prune, tags),
            ),
        ),
    PullStream: ({ repoId, mode, autostash }) =>
        Stream.unwrap(
            Effect.map(GitEngine, engine =>
                engine.pullStream(repoId, mode, autostash),
            ),
        ),
    PushStream: ({
        repoId,
        remote,
        branch,
        setUpstream,
        forceWithLease,
        tags,
    }) =>
        Stream.unwrap(
            Effect.map(GitEngine, engine =>
                engine.pushStream(
                    repoId,
                    remote,
                    branch,
                    setUpstream,
                    forceWithLease,
                    tags,
                ),
            ),
        ),
    PushDeleteRemoteRef: ({ repoId, remote, ref, refType }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.pushDeleteRemoteRef(repoId, remote, ref, refType),
        ),

    // ── remotes (P3) ──────────────────────────────────────────────────────────
    RemoteList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.remoteList(repoId)),
    RemoteAdd: ({ repoId, name, url }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.remoteAdd(repoId, name, url),
        ),
    RemoteSetUrl: ({ repoId, name, url, push }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.remoteSetUrl(repoId, name, url, push),
        ),
    RemoteRename: ({ repoId, oldName, newName }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.remoteRename(repoId, oldName, newName),
        ),
    RemoteRemove: ({ repoId, name }) =>
        Effect.flatMap(GitEngine, engine => engine.remoteRemove(repoId, name)),

    // ── worktrees (P3) ────────────────────────────────────────────────────────
    WorktreeList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.worktreeList(repoId)),
    WorktreeAdd: ({ repoId, path, branch, newBranch, startPoint, force }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.worktreeAdd(
                repoId,
                path,
                branch,
                newBranch,
                startPoint,
                force,
            ),
        ),
    WorktreeRemove: ({ repoId, path, force }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.worktreeRemove(repoId, path, force),
        ),
    WorktreePrune: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.worktreePrune(repoId)),
    WorktreeSwitch: ({ repoId, path }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.worktreeSwitch(repoId, path),
        ),

    // ── stash (P3) ────────────────────────────────────────────────────────────
    StashPush: ({ repoId, message, includeUntracked, keepIndex, stagedOnly }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.stashPush(
                repoId,
                message,
                includeUntracked,
                keepIndex,
                stagedOnly,
            ),
        ),
    StashList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.stashList(repoId)),
    StashShow: ({ repoId, ref }) =>
        Effect.flatMap(GitEngine, engine => engine.stashShow(repoId, ref)),
    StashApply: ({ repoId, ref }) =>
        Effect.flatMap(GitEngine, engine => engine.stashApply(repoId, ref)),
    StashPop: ({ repoId, ref }) =>
        Effect.flatMap(GitEngine, engine => engine.stashPop(repoId, ref)),
    StashDrop: ({ repoId, ref }) =>
        Effect.flatMap(GitEngine, engine => engine.stashDrop(repoId, ref)),
    StashClear: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.stashClear(repoId)),

    // ── tags (P3) ─────────────────────────────────────────────────────────────
    TagList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.tagList(repoId)),
    TagCreate: ({ repoId, name, target, tagType, message, force }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.tagCreate(repoId, name, target, tagType, message, force),
        ),
    TagDelete: ({ repoId, name }) =>
        Effect.flatMap(GitEngine, engine => engine.tagDelete(repoId, name)),
    TagPush: ({ repoId, remote, name, all }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.tagPush(repoId, remote, name, all),
        ),
    TagDeleteRemote: ({ repoId, remote, name }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.tagDeleteRemote(repoId, remote, name),
        ),

    // ── conflicts (P4) ──────────────────────────────────────────────────────────
    ConflictList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.conflictList(repoId)),
    ConflictSides: ({ repoId, path }) =>
        Effect.flatMap(GitEngine, engine => engine.conflictSides(repoId, path)),
    ConflictResolve: ({ repoId, paths, resolution }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.conflictResolve(repoId, paths, resolution),
        ),
    ConflictSaveMerged: ({ repoId, path, content, encoding }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.conflictSaveMerged(repoId, path, content, encoding),
        ),
    ConflictMarkResolved: ({ repoId, paths }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.conflictMarkResolved(repoId, paths),
        ),
    ConflictMarkUnresolved: ({ repoId, paths }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.conflictMarkUnresolved(repoId, paths),
        ),

    // ── cherry-pick / revert + continuation (P4) ──────────────────────────────
    CherryPick: ({ repoId, commits, recordOrigin, mainline, noCommit }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.cherryPick(
                repoId,
                commits,
                recordOrigin,
                mainline,
                noCommit,
            ),
        ),
    Revert: ({ repoId, commits, mainline, noCommit, message }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.revert(repoId, commits, mainline, noCommit, message),
        ),
    OpContinue: ({ repoId, message, allowEmpty }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.opContinue(repoId, message, allowEmpty),
        ),
    OpAbort: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.opAbort(repoId)),
    OpSkip: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.opSkip(repoId)),

    // ── blame & file history (P4) ─────────────────────────────────────────────
    Blame: ({ repoId, path, rev, startLine, endLine, force }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.blame(repoId, path, rev, startLine, endLine, force),
        ),
    FileHistory: ({ repoId, path, limit, cursor, startRev }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.fileHistory(repoId, path, limit, cursor, startRev),
        ),

    // ── repository maintenance (P5) ─────────────────────────────────────────────
    RepoGc: ({ repoId, aggressive, prune }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.gc(repoId, aggressive, prune),
        ),

    // ── clean working directory (P5) ────────────────────────────────────────────
    CleanPreview: ({ repoId, directories, ignored }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.cleanPreview(repoId, directories, ignored),
        ),
    Clean: ({ repoId, paths, directories, ignored }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.clean(repoId, paths, directories, ignored),
        ),

    // ── archive export (P5) — bytes stream over GET /sidechannel/archive, not here ──
    ArchivePrepare: ({ repoId, treeish, format, prefix, subPath }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.archivePrepare(repoId, treeish, format, prefix, subPath),
        ),

    // ── reflog viewer (P5) ──────────────────────────────────────────────────────
    ReflogList: ({ repoId, ref, limit, cursor }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.reflogList(repoId, limit, ref, cursor),
        ),

    // ── bisect (P5) ─────────────────────────────────────────────────────────────
    BisectStart: ({ repoId, bad, good }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.bisectStart(repoId, bad, good),
        ),
    BisectMark: ({ repoId, mark }) =>
        Effect.flatMap(GitEngine, engine => engine.bisectMark(repoId, mark)),
    BisectReset: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.bisectReset(repoId)),
    BisectStatus: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.bisectStatus(repoId)),

    // ── submodules (P5) ───────────────────────────────────────────────────────
    SubmoduleList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.submoduleList(repoId)),
    SubmoduleUpdate: ({ repoId, paths, init, recursive, force }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.submoduleUpdate(repoId, paths, init, recursive, force),
        ),
    SubmoduleSync: ({ repoId, paths, recursive }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.submoduleSync(repoId, paths, recursive),
        ),
    SubmoduleAdd: ({ repoId, url, path, branch }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.submoduleAdd(repoId, url, path, branch),
        ),
    SubmoduleRemove: ({ repoId, path }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.submoduleRemove(repoId, path),
        ),

    // ── settings & git config (P5) ────────────────────────────────────────────
    ConfigList: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.configList(repoId)),
    ConfigGet: ({ repoId, key, scope }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.configGet(repoId, key, scope),
        ),
    ConfigSet: ({ repoId, key, value, scope }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.configSet(repoId, key, value, scope),
        ),
    ConfigUnset: ({ repoId, key, scope }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.configUnset(repoId, key, scope),
        ),
    ConfigAppGet: () =>
        Effect.flatMap(GitEngine, engine => engine.appSettingsGet()),
    ConfigAppSet: ({ theme, locale, keybindings, columns }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.appSettingsSet({ theme, locale, keybindings, columns }),
        ),

    // ── P5: interactive rebase ─────────────────────────────────────────────────
    RebasePlan: ({ repoId, upstream, onto, branch }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.rebasePlan(repoId, upstream, onto, branch),
        ),
    RebaseStart: ({ repoId, upstream, steps, onto, branch }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.rebaseStart(repoId, upstream, steps, onto, branch),
        ),
    RebaseStatus: ({ repoId }) =>
        Effect.flatMap(GitEngine, engine => engine.rebaseStatus(repoId)),

    // ── P6: create / initialize a repository ───────────────────────────────────
    RepoInit: ({ path, defaultBranch, bare }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.init({ path, defaultBranch, bare }),
        ),

    // ── P6: Git command log ────────────────────────────────────────────────────
    CommandLogList: ({ repoId, limit }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.commandLogList(repoId, limit),
        ),
    CommandLogSubscribe: ({ repoId }) =>
        Stream.unwrap(
            Effect.map(GitEngine, engine => engine.commandLogSubscribe(repoId)),
        ),

    // ── P6: repository metadata-file editors ───────────────────────────────────
    MetaFileRead: ({ repoId, file }) =>
        Effect.flatMap(GitEngine, engine => engine.metaFileRead(repoId, file)),
    MetaFileWrite: ({ repoId, file, text }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.metaFileWrite(repoId, file, text),
        ),

    // ── P6: git notes ──────────────────────────────────────────────────────────
    NotesList: ({ repoId, ref }) =>
        Effect.flatMap(GitEngine, engine => engine.notesList(repoId, ref)),
    NotesGet: ({ repoId, oid, ref }) =>
        Effect.flatMap(GitEngine, engine => engine.notesGet(repoId, oid, ref)),
    NotesSet: ({ repoId, oid, text, ref }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.notesSet(repoId, oid, text, ref),
        ),
    NotesRemove: ({ repoId, oid, ref }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.notesRemove(repoId, oid, ref),
        ),

    // ── P6: patch interchange ──────────────────────────────────────────────────
    PatchFormatPrepare: ({ repoId, range, includeCover }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.patchFormatPrepare(repoId, range, includeCover),
        ),
    // An `uploadId` (an oversized patch parked on the side-channel) takes precedence over
    // the inline text (REQ-P6-PATCH-006).
    PatchInspect: ({ repoId, patch, mode, threeWay, uploadId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.patchInspect(
                repoId,
                resolvePatch(patch, uploadId),
                mode,
                threeWay,
            ),
        ),
    PatchApply: ({ repoId, patch, mode, threeWay, uploadId }) =>
        Effect.flatMap(GitEngine, engine =>
            engine.patchApply(
                repoId,
                resolvePatch(patch, uploadId),
                mode,
                threeWay,
            ),
        ),
});

/** Resolve an inline patch or a side-channel upload token to the patch text. */
const resolvePatch = (inline: string, uploadId: string | undefined): string => {
    if (uploadId === undefined) return inline;
    return getUpload(uploadId) ?? inline;
};
