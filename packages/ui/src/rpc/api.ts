// Promise/subscription facade over the Effect RPC client (docs/spec/14; NF-TEST-7).
//
// Components and React Query never touch Effect directly — they depend on this small
// `CbranchApi` interface: unary methods as Promises, the two streams as
// callback subscriptions returning an unsubscribe. This is the seam component tests
// mock (a hand-written fake `CbranchApi`, no live host — NF-TEST-7), while production
// backs it with the single app runtime. A `GitError` rejects the Promise (driving
// React Query error state); a stream's per-item error reaches `onError`.

import {
    type AppSettings,
    type ArchiveDescriptor,
    type ArchiveFormat,
    type BisectMark,
    type BisectStatus,
    type BlameResult,
    type BranchInfo,
    type BranchListing,
    type BranchSwitchStrategy,
    type ChangeSetId,
    type ChangeSetPullRequest,
    type CommandLogEntry,
    type CommitCreated,
    type CommitDetail,
    type CommitTree,
    type CleanPreview,
    type CleanResult,
    type CommitInput,
    type CommitMessage,
    type CommitSummary,
    type ConfigScope,
    type ConflictListing,
    type ConflictResolution,
    type ConflictSides,
    type ContentEncoding,
    type DiffFile,
    type DiffSpec,
    type EngagementColor,
    type EngagementDirectoryImportTarget,
    type EngagementDirectoryPreview,
    type EngagementId,
    type EngagementSlug,
    type EngagementWorkspace,
    type FileContentResult,
    type FileHistoryPage,
    type FilesystemDirectoryListing,
    type GcPrune,
    type GcResult,
    type GitConfigEntry,
    type GitConfigValue,
    type GitHubPullRequestList,
    type GitHubPullRequestCreated,
    type GitHubPullRequestPreview,
    type HistoryColumnVisibility,
    type InferenceProfile,
    type InferenceProfileDiscovery,
    type InferenceModelDiscovery,
    type InvalidationEvent,
    type KeyBinding,
    type MetaFile,
    type MetaFileContent,
    type NoteContent,
    type NotedObject,
    type PatchApplyMode,
    type PatchApplyReport,
    type PatchApplyResult,
    type PatchBundleDescriptor,
    type ThemePref,
    type WritableScope,
    type LogQuery,
    type MergeMode,
    type MergeResult,
    type Oid,
    type PatchSelection,
    type PullRequestListState,
    type InstalledPlugin,
    type PluginCatalogEntry,
    type PluginGrant,
    type PluginId,
    type PluginInstallReview,
    type PluginInvocation,
    type PluginRepository,
    type PluginRepositoryId,
    type PluginRuntimeStatus,
    type RebasePlan,
    type RebaseStatus,
    type RebaseStep,
    type RecentRepo,
    type ReflogPage,
    type RemoteInfo,
    type RepoHandle,
    type RepoId,
    type RepoInitResult,
    type RepoState,
    type SequencerResult,
    type StashEntry,
    type SubmoduleInfo,
    type SyncEvent,
    type TagInfo,
    type TagType,
    type WorkingTreeStatus,
    type WorktreeInfo,
    type WorkspaceInferenceDefaults,
    type WorkspaceIntelligenceAnalysisSettings,
    type WorkspaceIntelligencePresentation,
    type WorkspaceIntelligenceRun,
    type WorkspaceIntelligenceRunEvent,
    type WorkspaceIntelligenceRunId,
    type WorkspaceIntelligenceReport,
    type WorkspaceIntelligenceGraphSearchResult,
    type WorkspaceIntelligenceSemanticSearchResult,
    type WorkspaceIntelligenceGraphNeighborhood,
    type WorkspaceIntelligenceGraphDiff,
    type WorkspaceIntelligenceComponentOverride,
    type WorkspaceIntelligenceCurationAction,
    type WorkspaceIntelligenceCurationActionRequest,
    type WorkspaceIntelligenceArchiveDescriptor,
    type WorkspaceIntelligenceEnrichmentAttempt,
} from '@cbranch/rpc-contract';
import { Effect, Fiber, Stream } from 'effect';

import {
    type AppRuntime,
    type RpcClientService,
    streamWithClient,
    withClient,
} from './client';

export interface StreamHandlers<A> {
    readonly onItem: (item: A) => void;
    // The stream can fail with the schema `GitError` OR a transport `RpcClientError`,
    // so the callback takes `unknown`; consumers surface it as a toast (NF-ERR-2).
    readonly onError?: (error: unknown) => void;
    readonly onComplete?: () => void;
}

export type Unsubscribe = () => void;

/** The transport-agnostic host API the UI depends on (mockable for component tests). */
export interface CbranchApi {
    pluginRuntimeStatus(): Promise<PluginRuntimeStatus>;
    pluginRepositoryList(): Promise<ReadonlyArray<PluginRepository>>;
    pluginRepositoryAdd(
        url: string,
        credential?: string,
    ): Promise<PluginRepository>;
    pluginRepositoryRemove(repositoryId: PluginRepositoryId): Promise<void>;
    pluginRepositoryRefresh(repositoryId: PluginRepositoryId): Promise<void>;
    pluginPublisherTrust(
        repositoryId: PluginRepositoryId,
        rootFingerprint: string,
    ): Promise<PluginRepository>;
    pluginCatalogList(
        repositoryId: PluginRepositoryId,
    ): Promise<ReadonlyArray<PluginCatalogEntry>>;
    pluginInstall(input: {
        readonly repositoryId: PluginRepositoryId;
        readonly pluginId: PluginId;
        readonly version: string;
        readonly artifactSha256: string;
        readonly grant: PluginGrant;
    }): Promise<InstalledPlugin>;
    pluginInstallReview(input: {
        readonly repositoryId: PluginRepositoryId;
        readonly pluginId: PluginId;
        readonly version: string;
    }): Promise<PluginInstallReview>;
    pluginList(): Promise<ReadonlyArray<InstalledPlugin>>;
    pluginEnable(pluginId: PluginId): Promise<InstalledPlugin>;
    pluginDisable(pluginId: PluginId): Promise<InstalledPlugin>;
    pluginUninstall(pluginId: PluginId): Promise<void>;
    pluginInvoke(input: {
        readonly pluginId: PluginId;
        readonly commandId: string;
        readonly repoId: string;
        readonly engagementId?: string;
        readonly input?: unknown;
    }): Promise<PluginInvocation>;
    repoOpen(path: string): Promise<RepoHandle>;
    repoInit(input: {
        path: string;
        defaultBranch?: string;
        bare?: boolean;
    }): Promise<RepoInitResult>;
    recentList(): Promise<ReadonlyArray<RecentRepo>>;
    recentRemove(repoId: RepoId): Promise<void>;
    filesystemListDir(input: {
        readonly path?: string;
        readonly showHidden?: boolean;
    }): Promise<FilesystemDirectoryListing>;
    engagementDirectoryPreview(
        path: string,
    ): Promise<EngagementDirectoryPreview>;
    engagementList(): Promise<EngagementWorkspace>;
    engagementCreate(
        name: string,
        color: EngagementColor,
        avatarUrl?: string,
        slug?: EngagementSlug,
    ): Promise<EngagementWorkspace>;
    engagementDirectoryImport(input: {
        readonly path: string;
        readonly candidateRoots: ReadonlyArray<string>;
        readonly target: EngagementDirectoryImportTarget;
    }): Promise<EngagementWorkspace>;
    engagementUpdate(
        engagementId: EngagementId,
        patch: {
            readonly name?: string;
            readonly slug?: EngagementSlug;
            readonly color?: EngagementColor;
            readonly avatarUrl?: string | null;
        },
    ): Promise<EngagementWorkspace>;
    engagementDelete(engagementId: EngagementId): Promise<EngagementWorkspace>;
    engagementReorder(
        engagementIds: ReadonlyArray<EngagementId>,
    ): Promise<EngagementWorkspace>;
    engagementRepoAssign(
        engagementId: EngagementId,
        repoId: RepoId,
    ): Promise<EngagementWorkspace>;
    engagementRepoRemove(
        engagementId: EngagementId,
        repoId: RepoId,
    ): Promise<EngagementWorkspace>;
    engagementSessionSet(
        engagementId: EngagementId,
        openRepoIds: ReadonlyArray<RepoId>,
        activeRepoId?: RepoId,
    ): Promise<EngagementWorkspace>;
    engagementActivate(
        engagementId: EngagementId,
    ): Promise<EngagementWorkspace>;
    workspaceIntelligenceStart?(
        engagementId: EngagementId,
        repoIds?: ReadonlyArray<RepoId>,
        analysisSettings?: WorkspaceIntelligenceAnalysisSettings,
    ): Promise<WorkspaceIntelligenceRun>;
    workspaceIntelligenceAnalysisSettings?(
        engagementId: EngagementId,
    ): Promise<WorkspaceIntelligenceAnalysisSettings>;
    workspaceIntelligenceAnalysisSettingsSet?(
        engagementId: EngagementId,
        settings: WorkspaceIntelligenceAnalysisSettings,
    ): Promise<WorkspaceIntelligenceAnalysisSettings>;
    workspaceIntelligencePresentationGet?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligencePresentation>;
    workspaceIntelligencePresentationSet?(
        engagementId: EngagementId,
        presentation: WorkspaceIntelligencePresentation,
    ): Promise<WorkspaceIntelligencePresentation>;
    workspaceIntelligenceRunGet?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligenceRun>;
    workspaceIntelligenceRunReport?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligenceReport>;
    workspaceIntelligenceGraphSearch?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
        query: string,
        limit?: number,
    ): Promise<WorkspaceIntelligenceGraphSearchResult>;
    workspaceIntelligenceSemanticSearch?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
        query: string,
        limit?: number,
        profileId?: string,
    ): Promise<WorkspaceIntelligenceSemanticSearchResult>;
    workspaceIntelligenceGraphNeighborhood?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
        nodeId: string,
        limit?: number,
    ): Promise<WorkspaceIntelligenceGraphNeighborhood>;
    workspaceIntelligenceGraphDiff?(
        engagementId: EngagementId,
        fromRunId: WorkspaceIntelligenceRunId,
        toRunId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligenceGraphDiff>;
    workspaceIntelligenceComponentOverrides?(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceComponentOverride>>;
    workspaceIntelligenceComponentOverridesSet?(
        engagementId: EngagementId,
        overrides: ReadonlyArray<WorkspaceIntelligenceComponentOverride>,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceComponentOverride>>;
    workspaceIntelligenceCurationActions?(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceCurationAction>>;
    workspaceIntelligenceCurationActionAppend?(
        engagementId: EngagementId,
        action: WorkspaceIntelligenceCurationActionRequest,
    ): Promise<WorkspaceIntelligenceCurationAction>;
    workspaceIntelligenceCurationActionsClear?(
        engagementId: EngagementId,
    ): Promise<void>;
    workspaceIntelligenceRunList?(
        engagementId: EngagementId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceRun>>;
    workspaceIntelligenceRunCancel?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligenceRun>;
    workspaceIntelligenceRunDelete?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<void>;
    workspaceIntelligenceCurrentSet?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<void>;
    workspaceIntelligenceCurrentClear?(
        engagementId: EngagementId,
    ): Promise<void>;
    workspaceIntelligenceRunHistoryClear?(
        engagementId: EngagementId,
    ): Promise<void>;
    workspaceIntelligenceArchiveRequest?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligenceArchiveDescriptor>;
    workspaceIntelligenceRunSubscribe?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
        afterSequence: number | undefined,
        handlers: StreamHandlers<WorkspaceIntelligenceRunEvent>,
    ): Unsubscribe;
    workspaceIntelligenceEnrichmentStart?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
        profileId?: string,
        evidenceLimit?: number,
    ): Promise<WorkspaceIntelligenceEnrichmentAttempt>;
    workspaceIntelligenceEnrichmentCancel?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<void>;
    workspaceIntelligenceEnrichmentList?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<ReadonlyArray<WorkspaceIntelligenceEnrichmentAttempt>>;
    workspaceIntelligenceEnrichmentPreferredGet?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
    ): Promise<WorkspaceIntelligenceEnrichmentAttempt | undefined>;
    workspaceIntelligenceEnrichmentPreferredSet?(
        engagementId: EngagementId,
        runId: WorkspaceIntelligenceRunId,
        attemptId?: string,
    ): Promise<WorkspaceIntelligenceEnrichmentAttempt | undefined>;
    changeSetCreate(
        engagementId: EngagementId,
        name: string,
        description?: string,
    ): Promise<EngagementWorkspace>;
    changeSetUpdate(
        engagementId: EngagementId,
        changeSetId: ChangeSetId,
        patch: { readonly name?: string; readonly description?: string },
    ): Promise<EngagementWorkspace>;
    changeSetDelete(
        engagementId: EngagementId,
        changeSetId: ChangeSetId,
    ): Promise<EngagementWorkspace>;
    changeSetItemsSet(
        engagementId: EngagementId,
        changeSetId: ChangeSetId,
        items: ReadonlyArray<ChangeSetPullRequest>,
    ): Promise<EngagementWorkspace>;
    githubPullsList(
        repoId: RepoId,
        state?: PullRequestListState,
    ): Promise<GitHubPullRequestList>;
    githubPullPreview(
        repoId: RepoId,
        baseRefName?: string,
    ): Promise<GitHubPullRequestPreview>;
    githubPullCreate(
        repoId: RepoId,
        input: {
            readonly title: string;
            readonly body: string;
            readonly baseRefName: string;
            readonly draft: boolean;
        },
    ): Promise<GitHubPullRequestCreated>;
    repoState(repoId: RepoId): Promise<RepoState>;
    commitDetail(repoId: RepoId, oid: Oid): Promise<CommitDetail>;
    commitTree(repoId: RepoId, oid: Oid): Promise<CommitTree>;
    commitDiff(spec: DiffSpec): Promise<ReadonlyArray<DiffFile>>;
    workingFileDiff(
        repoId: RepoId,
        path: string,
        staged: boolean,
    ): Promise<DiffFile>;
    fileContentAtRev(
        repoId: RepoId,
        path: string,
        rev: string,
    ): Promise<FileContentResult>;
    // ── stage & commit (P2) ─────────────────────────────────────────────────────
    statusGet(
        repoId: RepoId,
        includeIgnored?: boolean,
    ): Promise<WorkingTreeStatus>;
    stageFiles(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
        all?: boolean,
    ): Promise<void>;
    unstageFiles(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
        all?: boolean,
    ): Promise<void>;
    discardFiles(repoId: RepoId, paths: ReadonlyArray<string>): Promise<void>;
    deleteUntracked(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
    ): Promise<void>;
    resetTo(
        repoId: RepoId,
        mode: 'soft' | 'mixed' | 'hard',
        target: string,
    ): Promise<void>;
    stageHunks(selection: PatchSelection): Promise<void>;
    unstageHunks(selection: PatchSelection): Promise<void>;
    discardHunks(selection: PatchSelection): Promise<void>;
    commitCreate(input: CommitInput): Promise<CommitCreated>;
    commitLastMessage(repoId: RepoId): Promise<CommitMessage>;
    /** Subscribe to the streaming history feed; returns an unsubscribe (cancels the request). */
    logStream(
        query: LogQuery,
        handlers: StreamHandlers<CommitSummary>,
    ): Unsubscribe;
    /** Subscribe to the WS invalidation bus for a repo; returns an unsubscribe. */
    subscribe(
        repoId: RepoId,
        handlers: StreamHandlers<InvalidationEvent>,
    ): Unsubscribe;
    // ── Git command log (P6) ────────────────────────────────────────────────────
    commandLogList(
        repoId?: RepoId,
        limit?: number,
    ): Promise<ReadonlyArray<CommandLogEntry>>;
    commandLogSubscribe(
        repoId: RepoId | undefined,
        handlers: StreamHandlers<CommandLogEntry>,
    ): Unsubscribe;
    // ── Repository metadata-file editors (P6) ───────────────────────────────────
    metaFileRead(repoId: RepoId, file: MetaFile): Promise<MetaFileContent>;
    metaFileWrite(repoId: RepoId, file: MetaFile, text: string): Promise<void>;
    // ── Git notes (P6) ──────────────────────────────────────────────────────────
    notesList(
        repoId: RepoId,
        ref?: string,
    ): Promise<ReadonlyArray<NotedObject>>;
    notesGet(repoId: RepoId, oid: Oid, ref?: string): Promise<NoteContent>;
    notesSet(
        repoId: RepoId,
        oid: Oid,
        text: string,
        ref?: string,
    ): Promise<void>;
    notesRemove(repoId: RepoId, oid: Oid, ref?: string): Promise<void>;
    // ── Patch interchange (P6) ──────────────────────────────────────────────────
    patchFormatPrepare(
        repoId: RepoId,
        range: string,
        includeCover?: boolean,
    ): Promise<PatchBundleDescriptor>;
    patchInspect(
        repoId: RepoId,
        args: {
            patch: string;
            mode: PatchApplyMode;
            threeWay?: boolean;
            uploadId?: string;
        },
    ): Promise<PatchApplyReport>;
    patchApply(
        repoId: RepoId,
        args: {
            patch: string;
            mode: PatchApplyMode;
            threeWay?: boolean;
            uploadId?: string;
        },
    ): Promise<PatchApplyResult>;
    // ── branches (P3) ─────────────────────────────────────────────────────────
    branchList(repoId: RepoId): Promise<BranchListing>;
    branchCreate(
        repoId: RepoId,
        name: string,
        startPoint?: string,
        setUpstream?: boolean,
        switchAfter?: boolean,
    ): Promise<BranchInfo>;
    branchSwitch(
        repoId: RepoId,
        target: string,
        strategy?: BranchSwitchStrategy,
        stashAndReapply?: boolean,
    ): Promise<void>;
    branchCheckoutDetached(repoId: RepoId, ref: string): Promise<void>;
    branchRename(
        repoId: RepoId,
        oldName: string,
        newName: string,
    ): Promise<void>;
    branchDelete(repoId: RepoId, name: string, force: boolean): Promise<void>;
    branchSetUpstream(
        repoId: RepoId,
        name: string,
        upstream?: string,
    ): Promise<void>;
    // ── merge (P3) ────────────────────────────────────────────────────────────
    mergeCreate(
        repoId: RepoId,
        ref: string,
        strategy: MergeMode,
        message?: string,
    ): Promise<MergeResult>;
    mergeAbort(repoId: RepoId): Promise<void>;
    // ── sync streaming (P3) ───────────────────────────────────────────────────
    fetchStream(
        repoId: RepoId,
        opts: {
            remote?: string;
            all?: boolean;
            prune?: boolean;
            tags?: boolean;
        },
        handlers: StreamHandlers<SyncEvent>,
    ): Unsubscribe;
    pullStream(
        repoId: RepoId,
        mode: 'ff-only' | 'rebase' | 'merge',
        opts: { autostash?: boolean },
        handlers: StreamHandlers<SyncEvent>,
    ): Unsubscribe;
    pushStream(
        repoId: RepoId,
        remote: string,
        opts: {
            branch?: string;
            setUpstream?: boolean;
            forceWithLease?: boolean;
            tags?: boolean;
        },
        handlers: StreamHandlers<SyncEvent>,
    ): Unsubscribe;
    pushDeleteRemoteRef(
        repoId: RepoId,
        remote: string,
        ref: string,
        refType: 'branch' | 'tag',
    ): Promise<void>;
    // ── remotes (P3) ──────────────────────────────────────────────────────────
    remoteList(repoId: RepoId): Promise<ReadonlyArray<RemoteInfo>>;
    remoteAdd(repoId: RepoId, name: string, url: string): Promise<void>;
    remoteSetUrl(
        repoId: RepoId,
        name: string,
        url: string,
        push?: boolean,
    ): Promise<void>;
    remoteRename(
        repoId: RepoId,
        oldName: string,
        newName: string,
    ): Promise<void>;
    remoteRemove(repoId: RepoId, name: string): Promise<void>;
    // ── worktrees (P3) ────────────────────────────────────────────────────────
    worktreeList(repoId: RepoId): Promise<ReadonlyArray<WorktreeInfo>>;
    worktreeAdd(
        repoId: RepoId,
        path: string,
        opts?: {
            branch?: string;
            newBranch?: string;
            startPoint?: string;
            force?: boolean;
        },
    ): Promise<WorktreeInfo>;
    worktreeRemove(
        repoId: RepoId,
        path: string,
        force?: boolean,
    ): Promise<void>;
    worktreePrune(repoId: RepoId): Promise<void>;
    worktreeSwitch(repoId: RepoId, path: string): Promise<void>;
    // ── stash (P3) ────────────────────────────────────────────────────────────
    stashPush(
        repoId: RepoId,
        opts?: {
            message?: string;
            includeUntracked?: boolean;
            keepIndex?: boolean;
            stagedOnly?: boolean;
        },
    ): Promise<StashEntry>;
    stashList(repoId: RepoId): Promise<ReadonlyArray<StashEntry>>;
    stashShow(repoId: RepoId, ref: string): Promise<ReadonlyArray<DiffFile>>;
    stashApply(repoId: RepoId, ref: string): Promise<void>;
    stashPop(repoId: RepoId, ref: string): Promise<void>;
    stashDrop(repoId: RepoId, ref: string): Promise<void>;
    stashClear(repoId: RepoId): Promise<void>;
    // ── tags (P3) ─────────────────────────────────────────────────────────────
    tagList(repoId: RepoId): Promise<ReadonlyArray<TagInfo>>;
    tagCreate(
        repoId: RepoId,
        name: string,
        opts: {
            target?: string;
            tagType: TagType;
            message?: string;
            force?: boolean;
        },
    ): Promise<TagInfo>;
    tagDelete(repoId: RepoId, name: string): Promise<void>;
    tagPush(
        repoId: RepoId,
        remote: string,
        opts?: { name?: string; all?: boolean },
    ): Promise<void>;
    tagDeleteRemote(
        repoId: RepoId,
        remote: string,
        name: string,
    ): Promise<void>;
    // ── conflicts (P4) ────────────────────────────────────────────────────────
    conflictList(repoId: RepoId): Promise<ConflictListing>;
    conflictSides(repoId: RepoId, path: string): Promise<ConflictSides>;
    conflictResolve(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
        resolution: ConflictResolution,
    ): Promise<void>;
    conflictSaveMerged(
        repoId: RepoId,
        path: string,
        content: string,
        encoding: ContentEncoding,
    ): Promise<void>;
    conflictMarkResolved(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
    ): Promise<void>;
    conflictMarkUnresolved(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
    ): Promise<void>;
    // ── cherry-pick / revert + continuation (P4) ──────────────────────────────
    cherryPick(
        repoId: RepoId,
        commits: ReadonlyArray<Oid>,
        opts?: {
            recordOrigin?: boolean;
            mainline?: number;
            noCommit?: boolean;
        },
    ): Promise<SequencerResult>;
    revert(
        repoId: RepoId,
        commits: ReadonlyArray<Oid>,
        opts?: { mainline?: number; noCommit?: boolean; message?: string },
    ): Promise<SequencerResult>;
    opContinue(
        repoId: RepoId,
        opts?: { message?: string; allowEmpty?: boolean },
    ): Promise<SequencerResult>;
    opAbort(repoId: RepoId): Promise<void>;
    opSkip(repoId: RepoId): Promise<SequencerResult>;
    // ── blame & file history (P4) ─────────────────────────────────────────────
    blame(
        repoId: RepoId,
        path: string,
        opts?: {
            rev?: string;
            startLine?: number;
            endLine?: number;
            force?: boolean;
        },
    ): Promise<BlameResult>;
    fileHistory(
        repoId: RepoId,
        path: string,
        opts: { limit: number; cursor?: string; startRev?: string },
    ): Promise<FileHistoryPage>;
    // ── repository maintenance (P5) ───────────────────────────────────────────
    gc(
        repoId: RepoId,
        opts?: { aggressive?: boolean; prune?: GcPrune },
    ): Promise<GcResult>;
    // ── clean working directory (P5) ──────────────────────────────────────────
    cleanPreview(
        repoId: RepoId,
        directories: boolean,
        ignored: boolean,
    ): Promise<CleanPreview>;
    clean(
        repoId: RepoId,
        paths: ReadonlyArray<string>,
        directories: boolean,
        ignored: boolean,
    ): Promise<CleanResult>;
    // ── archive export (P5) ───────────────────────────────────────────────────
    archivePrepare(
        repoId: RepoId,
        opts: {
            format: ArchiveFormat;
            treeish: string;
            prefix?: string;
            subPath?: string;
        },
    ): Promise<ArchiveDescriptor>;
    // ── reflog viewer (P5) ────────────────────────────────────────────────────
    reflogList(
        repoId: RepoId,
        opts: { ref?: string; limit: number; cursor?: string },
    ): Promise<ReflogPage>;
    // ── bisect (P5) ───────────────────────────────────────────────────────────
    bisectStart(
        repoId: RepoId,
        opts?: { bad?: Oid; good?: ReadonlyArray<Oid> },
    ): Promise<BisectStatus>;
    bisectMark(repoId: RepoId, mark: BisectMark): Promise<BisectStatus>;
    bisectReset(repoId: RepoId): Promise<void>;
    bisectStatus(repoId: RepoId): Promise<BisectStatus>;
    // ── submodules (P5) ───────────────────────────────────────────────────────
    submoduleList(repoId: RepoId): Promise<ReadonlyArray<SubmoduleInfo>>;
    submoduleUpdate(
        repoId: RepoId,
        opts?: {
            paths?: ReadonlyArray<string>;
            init?: boolean;
            recursive?: boolean;
            force?: boolean;
        },
    ): Promise<void>;
    submoduleSync(
        repoId: RepoId,
        opts?: { paths?: ReadonlyArray<string>; recursive?: boolean },
    ): Promise<void>;
    submoduleAdd(
        repoId: RepoId,
        url: string,
        path: string,
        branch?: string,
    ): Promise<void>;
    submoduleRemove(repoId: RepoId, path: string): Promise<void>;
    // ── settings & git config (P5) ──────────────────────────────────────────────
    configList(repoId: RepoId): Promise<ReadonlyArray<GitConfigEntry>>;
    configGet(
        repoId: RepoId,
        key: string,
        scope?: ConfigScope,
    ): Promise<GitConfigValue>;
    configSet(
        repoId: RepoId,
        key: string,
        value: string,
        scope: WritableScope,
    ): Promise<void>;
    configUnset(
        repoId: RepoId,
        key: string,
        scope: WritableScope,
    ): Promise<void>;
    appSettingsGet(): Promise<AppSettings>;
    appSettingsSet(patch: {
        theme?: ThemePref;
        locale?: string;
        keybindings?: ReadonlyArray<KeyBinding>;
        columns?: HistoryColumnVisibility;
    }): Promise<AppSettings>;
    inferenceProfilesGet(): Promise<ReadonlyArray<InferenceProfile>>;
    inferenceProfilesDiscover(): Promise<
        ReadonlyArray<InferenceProfileDiscovery>
    >;
    inferenceModelsDiscover(
        profileId: string,
    ): Promise<InferenceModelDiscovery>;
    inferenceProfilesSet(
        profiles: ReadonlyArray<InferenceProfile>,
    ): Promise<ReadonlyArray<InferenceProfile>>;
    workspaceInferenceDefaultsGet(
        engagementId: EngagementId,
    ): Promise<WorkspaceInferenceDefaults>;
    workspaceInferenceDefaultsSet(
        engagementId: EngagementId,
        defaults: WorkspaceInferenceDefaults,
    ): Promise<WorkspaceInferenceDefaults>;
    // ── interactive rebase (P5) ─────────────────────────────────────────────────
    rebasePlan(
        repoId: RepoId,
        upstream: string,
        opts?: { onto?: string; branch?: string },
    ): Promise<RebasePlan>;
    rebaseStart(
        repoId: RepoId,
        upstream: string,
        steps: ReadonlyArray<RebaseStep>,
        opts?: { onto?: string; branch?: string },
    ): Promise<RebaseStatus>;
    rebaseStatus(repoId: RepoId): Promise<RebaseStatus>;
}

/** Back a {@link CbranchApi} with the single app runtime. */
export const makeApi = (runtime: AppRuntime): CbranchApi => {
    const runStream = <A, E>(
        stream: Stream.Stream<A, E, RpcClientService>,
        handlers: StreamHandlers<A>,
    ): Unsubscribe => {
        const fiber = runtime.runFork(
            stream.pipe(
                Stream.runForEach(item =>
                    Effect.sync(() => handlers.onItem(item)),
                ),
                Effect.match({
                    onFailure: error => handlers.onError?.(error),
                    onSuccess: () => handlers.onComplete?.(),
                }),
            ),
        );
        return () => {
            void runtime.runFork(Fiber.interrupt(fiber));
        };
    };

    return {
        pluginRuntimeStatus: () =>
            runtime.runPromise(withClient(c => c.PluginRuntimeStatus({}))),
        pluginRepositoryList: () =>
            runtime.runPromise(withClient(c => c.PluginRepositoryList({}))),
        pluginRepositoryAdd: (url, credential) =>
            runtime.runPromise(
                withClient(c =>
                    c.PluginRepositoryAdd({ kind: 'https', url, credential }),
                ),
            ),
        pluginRepositoryRemove: repositoryId =>
            runtime
                .runPromise(
                    withClient(c => c.PluginRepositoryRemove({ repositoryId })),
                )
                .then(() => undefined),
        pluginRepositoryRefresh: repositoryId =>
            runtime
                .runPromise(
                    withClient(c =>
                        c.PluginRepositoryRefresh({ repositoryId }),
                    ),
                )
                .then(() => undefined),
        pluginPublisherTrust: (repositoryId, rootFingerprint) =>
            runtime.runPromise(
                withClient(c =>
                    c.PluginPublisherTrust({
                        repositoryId,
                        rootFingerprint,
                        approved: true,
                    }),
                ),
            ),
        pluginCatalogList: repositoryId =>
            runtime.runPromise(
                withClient(c => c.PluginCatalogList({ repositoryId })),
            ),
        pluginInstall: input =>
            runtime.runPromise(withClient(c => c.PluginInstall(input))),
        pluginInstallReview: input =>
            runtime.runPromise(withClient(c => c.PluginInstallReview(input))),
        pluginList: () => runtime.runPromise(withClient(c => c.PluginList({}))),
        pluginEnable: pluginId =>
            runtime.runPromise(withClient(c => c.PluginEnable({ pluginId }))),
        pluginDisable: pluginId =>
            runtime.runPromise(withClient(c => c.PluginDisable({ pluginId }))),
        pluginUninstall: pluginId =>
            runtime.runPromise(
                withClient(c => c.PluginUninstall({ pluginId })),
            ),
        pluginInvoke: input =>
            runtime.runPromise(withClient(c => c.PluginInvoke(input))),
        repoOpen: path =>
            runtime.runPromise(withClient(c => c.RepoOpen({ path }))),
        repoInit: input =>
            runtime.runPromise(withClient(c => c.RepoInit(input))),
        recentList: () =>
            runtime.runPromise(withClient(c => c.RepoRecentList({}))),
        recentRemove: repoId =>
            runtime.runPromise(withClient(c => c.RepoRecentRemove({ repoId }))),
        filesystemListDir: input =>
            runtime.runPromise(withClient(c => c.FilesystemListDir(input))),
        engagementDirectoryPreview: path =>
            runtime.runPromise(
                withClient(c => c.EngagementDirectoryPreview({ path })),
            ),
        engagementList: () =>
            runtime.runPromise(withClient(c => c.EngagementList({}))),
        engagementCreate: (name, color, avatarUrl, slug) =>
            runtime.runPromise(
                withClient(c =>
                    c.EngagementCreate({ name, color, slug, avatarUrl }),
                ),
            ),
        engagementDirectoryImport: input =>
            runtime.runPromise(
                withClient(c => c.EngagementDirectoryImport(input)),
            ),
        engagementUpdate: (engagementId, patch) =>
            runtime.runPromise(
                withClient(c => c.EngagementUpdate({ engagementId, ...patch })),
            ),
        engagementDelete: engagementId =>
            runtime.runPromise(
                withClient(c => c.EngagementDelete({ engagementId })),
            ),
        engagementReorder: engagementIds =>
            runtime.runPromise(
                withClient(c => c.EngagementReorder({ engagementIds })),
            ),
        engagementRepoAssign: (engagementId, repoId) =>
            runtime.runPromise(
                withClient(c =>
                    c.EngagementRepoAssign({ engagementId, repoId }),
                ),
            ),
        engagementRepoRemove: (engagementId, repoId) =>
            runtime.runPromise(
                withClient(c =>
                    c.EngagementRepoRemove({ engagementId, repoId }),
                ),
            ),
        engagementSessionSet: (engagementId, openRepoIds, activeRepoId) =>
            runtime.runPromise(
                withClient(c =>
                    c.EngagementSessionSet({
                        engagementId,
                        openRepoIds,
                        activeRepoId,
                    }),
                ),
            ),
        engagementActivate: engagementId =>
            runtime.runPromise(
                withClient(c => c.EngagementActivate({ engagementId })),
            ),
        workspaceIntelligenceStart: (engagementId, repoIds, analysisSettings) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceStart({
                        engagementId,
                        repoIds,
                        analysisSettings,
                    }),
                ),
            ),
        workspaceIntelligenceAnalysisSettings: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceAnalysisSettings({ engagementId }),
                ),
            ),
        workspaceIntelligenceAnalysisSettingsSet: (engagementId, settings) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceAnalysisSettingsSet({
                        engagementId,
                        settings,
                    }),
                ),
            ),
        workspaceIntelligencePresentationGet: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligencePresentationGet({
                        engagementId,
                        runId,
                    }),
                ),
            ),
        workspaceIntelligencePresentationSet: (engagementId, presentation) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligencePresentationSet({
                        engagementId,
                        presentation,
                    }),
                ),
            ),
        workspaceIntelligenceRunGet: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceRunGet({ engagementId, runId }),
                ),
            ),
        workspaceIntelligenceRunReport: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceRunReport({ engagementId, runId }),
                ),
            ),
        workspaceIntelligenceGraphSearch: (engagementId, runId, query, limit) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceGraphSearch({
                        engagementId,
                        runId,
                        query,
                        limit,
                    }),
                ),
            ),
        workspaceIntelligenceSemanticSearch: (
            engagementId,
            runId,
            query,
            limit,
            profileId,
        ) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceSemanticSearch({
                        engagementId,
                        runId,
                        query,
                        limit,
                        profileId,
                    }),
                ),
            ),
        workspaceIntelligenceGraphNeighborhood: (
            engagementId,
            runId,
            nodeId,
            limit,
        ) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceGraphNeighborhood({
                        engagementId,
                        runId,
                        nodeId,
                        limit,
                    }),
                ),
            ),
        workspaceIntelligenceGraphDiff: (engagementId, fromRunId, toRunId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceGraphDiff({
                        engagementId,
                        fromRunId,
                        toRunId,
                    }),
                ),
            ),
        workspaceIntelligenceComponentOverrides: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceComponentOverrides({ engagementId }),
                ),
            ),
        workspaceIntelligenceComponentOverridesSet: (engagementId, overrides) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceComponentOverridesSet({
                        engagementId,
                        overrides,
                    }),
                ),
            ),
        workspaceIntelligenceCurationActions: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceCurationActions({ engagementId }),
                ),
            ),
        workspaceIntelligenceCurationActionAppend: (engagementId, action) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceCurationActionAppend({
                        engagementId,
                        action,
                    }),
                ),
            ),
        workspaceIntelligenceCurationActionsClear: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceCurationActionsClear({
                        engagementId,
                    }),
                ),
            ),
        workspaceIntelligenceRunList: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceRunList({ engagementId }),
                ),
            ),
        workspaceIntelligenceRunCancel: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceRunCancel({ engagementId, runId }),
                ),
            ),
        workspaceIntelligenceRunDelete: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceRunDelete({ engagementId, runId }),
                ),
            ),
        workspaceIntelligenceCurrentSet: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceCurrentSet({ engagementId, runId }),
                ),
            ),
        workspaceIntelligenceCurrentClear: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceCurrentClear({ engagementId }),
                ),
            ),
        workspaceIntelligenceRunHistoryClear: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceRunHistoryClear({ engagementId }),
                ),
            ),
        workspaceIntelligenceArchiveRequest: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceArchiveRequest({
                        engagementId,
                        runId,
                    }),
                ),
            ),
        workspaceIntelligenceRunSubscribe: (
            engagementId,
            runId,
            afterSequence,
            handlers,
        ) =>
            runStream(
                streamWithClient(c =>
                    c.WorkspaceIntelligenceRunSubscribe({
                        engagementId,
                        runId,
                        afterSequence,
                    }),
                ),
                handlers,
            ),
        workspaceIntelligenceEnrichmentStart: (
            engagementId,
            runId,
            profileId,
            evidenceLimit,
        ) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceEnrichmentStart({
                        engagementId,
                        runId,
                        profileId,
                        evidenceLimit,
                    }),
                ),
            ),
        workspaceIntelligenceEnrichmentCancel: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceEnrichmentCancel({
                        engagementId,
                        runId,
                    }),
                ),
            ),
        workspaceIntelligenceEnrichmentList: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceEnrichmentList({
                        engagementId,
                        runId,
                    }),
                ),
            ),
        workspaceIntelligenceEnrichmentPreferredGet: (engagementId, runId) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceEnrichmentPreferredGet({
                        engagementId,
                        runId,
                    }),
                ),
            ),
        workspaceIntelligenceEnrichmentPreferredSet: (
            engagementId,
            runId,
            attemptId,
        ) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceIntelligenceEnrichmentPreferredSet({
                        engagementId,
                        runId,
                        attemptId,
                    }),
                ),
            ),
        changeSetCreate: (engagementId, name, description) =>
            runtime.runPromise(
                withClient(c =>
                    c.ChangeSetCreate({ engagementId, name, description }),
                ),
            ),
        changeSetUpdate: (engagementId, changeSetId, patch) =>
            runtime.runPromise(
                withClient(c =>
                    c.ChangeSetUpdate({
                        engagementId,
                        changeSetId,
                        ...patch,
                    }),
                ),
            ),
        changeSetDelete: (engagementId, changeSetId) =>
            runtime.runPromise(
                withClient(c =>
                    c.ChangeSetDelete({ engagementId, changeSetId }),
                ),
            ),
        changeSetItemsSet: (engagementId, changeSetId, items) =>
            runtime.runPromise(
                withClient(c =>
                    c.ChangeSetItemsSet({
                        engagementId,
                        changeSetId,
                        items,
                    }),
                ),
            ),
        githubPullsList: (repoId, state) =>
            runtime.runPromise(
                withClient(c => c.GitHubPullsList({ repoId, state })),
            ),
        githubPullPreview: (repoId, baseRefName) =>
            runtime.runPromise(
                withClient(c => c.GitHubPullPreview({ repoId, baseRefName })),
            ),
        githubPullCreate: (repoId, input) =>
            runtime.runPromise(
                withClient(c => c.GitHubPullCreate({ repoId, ...input })),
            ),
        repoState: repoId =>
            runtime.runPromise(withClient(c => c.RepoState({ repoId }))),
        commitDetail: (repoId, oid) =>
            runtime.runPromise(
                withClient(c => c.CommitDetail({ repoId, oid })),
            ),
        commitTree: (repoId, oid) =>
            runtime.runPromise(withClient(c => c.CommitTree({ repoId, oid }))),
        commitDiff: spec =>
            runtime.runPromise(withClient(c => c.CommitDiff(spec))),
        workingFileDiff: (repoId, path, staged) =>
            runtime.runPromise(
                withClient(c => c.DiffWorkingFile({ repoId, path, staged })),
            ),
        fileContentAtRev: (repoId, path, rev) =>
            runtime.runPromise(
                withClient(c => c.FileContentAtRev({ repoId, path, rev })),
            ),
        statusGet: (repoId, includeIgnored) =>
            runtime.runPromise(
                withClient(c => c.StatusGet({ repoId, includeIgnored })),
            ),
        stageFiles: (repoId, paths, all) =>
            runtime.runPromise(
                withClient(c => c.StageFiles({ repoId, paths, all })),
            ),
        unstageFiles: (repoId, paths, all) =>
            runtime.runPromise(
                withClient(c => c.UnstageFiles({ repoId, paths, all })),
            ),
        discardFiles: (repoId, paths) =>
            runtime.runPromise(
                withClient(c => c.DiscardFiles({ repoId, paths })),
            ),
        deleteUntracked: (repoId, paths) =>
            runtime.runPromise(
                withClient(c => c.DeleteUntracked({ repoId, paths })),
            ),
        resetTo: (repoId, mode, target) =>
            runtime.runPromise(
                withClient(c => c.ResetTo({ repoId, mode, target })),
            ),
        stageHunks: selection =>
            runtime.runPromise(withClient(c => c.StageHunks(selection))),
        unstageHunks: selection =>
            runtime.runPromise(withClient(c => c.UnstageHunks(selection))),
        discardHunks: selection =>
            runtime.runPromise(withClient(c => c.DiscardHunks(selection))),
        commitCreate: input =>
            runtime.runPromise(withClient(c => c.CommitCreate(input))),
        commitLastMessage: repoId =>
            runtime.runPromise(
                withClient(c => c.CommitLastMessage({ repoId })),
            ),
        logStream: (query, handlers) =>
            runStream(
                streamWithClient(c => c.LogStream(query)),
                handlers,
            ),
        subscribe: (repoId, handlers) =>
            runStream(
                streamWithClient(c => c.RepoSubscribe({ repoId })),
                handlers,
            ),
        commandLogList: (repoId, limit) =>
            runtime.runPromise(
                withClient(c => c.CommandLogList({ repoId, limit })),
            ),
        commandLogSubscribe: (repoId, handlers) =>
            runStream(
                streamWithClient(c => c.CommandLogSubscribe({ repoId })),
                handlers,
            ),
        metaFileRead: (repoId, file) =>
            runtime.runPromise(
                withClient(c => c.MetaFileRead({ repoId, file })),
            ),
        metaFileWrite: (repoId, file, text) =>
            runtime.runPromise(
                withClient(c => c.MetaFileWrite({ repoId, file, text })),
            ),
        notesList: (repoId, ref) =>
            runtime.runPromise(withClient(c => c.NotesList({ repoId, ref }))),
        notesGet: (repoId, oid, ref) =>
            runtime.runPromise(
                withClient(c => c.NotesGet({ repoId, oid, ref })),
            ),
        notesSet: (repoId, oid, text, ref) =>
            runtime.runPromise(
                withClient(c => c.NotesSet({ repoId, oid, text, ref })),
            ),
        notesRemove: (repoId, oid, ref) =>
            runtime.runPromise(
                withClient(c => c.NotesRemove({ repoId, oid, ref })),
            ),
        patchFormatPrepare: (repoId, range, includeCover) =>
            runtime.runPromise(
                withClient(c =>
                    c.PatchFormatPrepare({ repoId, range, includeCover }),
                ),
            ),
        patchInspect: (repoId, args) =>
            runtime.runPromise(
                withClient(c => c.PatchInspect({ repoId, ...args })),
            ),
        patchApply: (repoId, args) =>
            runtime.runPromise(
                withClient(c => c.PatchApply({ repoId, ...args })),
            ),
        // ── branches (P3) ───────────────────────────────────────────────────────
        branchList: repoId =>
            runtime.runPromise(withClient(c => c.BranchList({ repoId }))),
        branchCreate: (repoId, name, startPoint, setUpstream, switchAfter) =>
            runtime.runPromise(
                withClient(c =>
                    c.BranchCreate({
                        repoId,
                        name,
                        startPoint,
                        setUpstream,
                        switchAfter: switchAfter ?? false,
                    }),
                ),
            ),
        branchSwitch: (repoId, target, strategy, stashAndReapply) =>
            runtime.runPromise(
                withClient(c =>
                    c.BranchSwitch({
                        repoId,
                        target,
                        strategy,
                        stashAndReapply,
                    }),
                ),
            ),
        branchCheckoutDetached: (repoId, ref) =>
            runtime.runPromise(
                withClient(c => c.BranchCheckoutDetached({ repoId, ref })),
            ),
        branchRename: (repoId, oldName, newName) =>
            runtime.runPromise(
                withClient(c => c.BranchRename({ repoId, oldName, newName })),
            ),
        branchDelete: (repoId, name, force) =>
            runtime.runPromise(
                withClient(c => c.BranchDelete({ repoId, name, force })),
            ),
        branchSetUpstream: (repoId, name, upstream) =>
            runtime.runPromise(
                withClient(c =>
                    c.BranchSetUpstream({ repoId, name, upstream }),
                ),
            ),
        // ── merge (P3) ──────────────────────────────────────────────────────────
        mergeCreate: (repoId, ref, strategy, message) =>
            runtime.runPromise(
                withClient(c =>
                    c.MergeCreate({ repoId, ref, strategy, message }),
                ),
            ),
        mergeAbort: repoId =>
            runtime.runPromise(withClient(c => c.MergeAbort({ repoId }))),
        // ── sync streaming (P3) ─────────────────────────────────────────────────
        fetchStream: (repoId, opts, handlers) =>
            runStream(
                streamWithClient(c => c.FetchStream({ repoId, ...opts })),
                handlers,
            ),
        pullStream: (repoId, mode, opts, handlers) =>
            runStream(
                streamWithClient(c => c.PullStream({ repoId, mode, ...opts })),
                handlers,
            ),
        pushStream: (repoId, remote, opts, handlers) =>
            runStream(
                streamWithClient(c =>
                    c.PushStream({ repoId, remote, ...opts }),
                ),
                handlers,
            ),
        pushDeleteRemoteRef: (repoId, remote, ref, refType) =>
            runtime.runPromise(
                withClient(c =>
                    c.PushDeleteRemoteRef({ repoId, remote, ref, refType }),
                ),
            ),
        // ── remotes (P3) ────────────────────────────────────────────────────────
        remoteList: repoId =>
            runtime.runPromise(withClient(c => c.RemoteList({ repoId }))),
        remoteAdd: (repoId, name, url) =>
            runtime.runPromise(
                withClient(c => c.RemoteAdd({ repoId, name, url })),
            ),
        remoteSetUrl: (repoId, name, url, push) =>
            runtime.runPromise(
                withClient(c => c.RemoteSetUrl({ repoId, name, url, push })),
            ),
        remoteRename: (repoId, oldName, newName) =>
            runtime.runPromise(
                withClient(c => c.RemoteRename({ repoId, oldName, newName })),
            ),
        remoteRemove: (repoId, name) =>
            runtime.runPromise(
                withClient(c => c.RemoteRemove({ repoId, name })),
            ),
        // ── worktrees (P3) ──────────────────────────────────────────────────────
        worktreeList: repoId =>
            runtime.runPromise(withClient(c => c.WorktreeList({ repoId }))),
        worktreeAdd: (repoId, path, opts) =>
            runtime.runPromise(
                withClient(c => c.WorktreeAdd({ repoId, path, ...opts })),
            ),
        worktreeRemove: (repoId, path, force) =>
            runtime.runPromise(
                withClient(c => c.WorktreeRemove({ repoId, path, force })),
            ),
        worktreePrune: repoId =>
            runtime.runPromise(withClient(c => c.WorktreePrune({ repoId }))),
        worktreeSwitch: (repoId, path) =>
            runtime.runPromise(
                withClient(c => c.WorktreeSwitch({ repoId, path })),
            ),
        // ── stash (P3) ──────────────────────────────────────────────────────────
        stashPush: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.StashPush({ repoId, ...opts })),
            ),
        stashList: repoId =>
            runtime.runPromise(withClient(c => c.StashList({ repoId }))),
        stashShow: (repoId, ref) =>
            runtime.runPromise(withClient(c => c.StashShow({ repoId, ref }))),
        stashApply: (repoId, ref) =>
            runtime.runPromise(withClient(c => c.StashApply({ repoId, ref }))),
        stashPop: (repoId, ref) =>
            runtime.runPromise(withClient(c => c.StashPop({ repoId, ref }))),
        stashDrop: (repoId, ref) =>
            runtime.runPromise(withClient(c => c.StashDrop({ repoId, ref }))),
        stashClear: repoId =>
            runtime.runPromise(withClient(c => c.StashClear({ repoId }))),
        // ── tags (P3) ───────────────────────────────────────────────────────────
        tagList: repoId =>
            runtime.runPromise(withClient(c => c.TagList({ repoId }))),
        tagCreate: (repoId, name, opts) =>
            runtime.runPromise(
                withClient(c => c.TagCreate({ repoId, name, ...opts })),
            ),
        tagDelete: (repoId, name) =>
            runtime.runPromise(withClient(c => c.TagDelete({ repoId, name }))),
        tagPush: (repoId, remote, opts) =>
            runtime.runPromise(
                withClient(c => c.TagPush({ repoId, remote, ...opts })),
            ),
        tagDeleteRemote: (repoId, remote, name) =>
            runtime.runPromise(
                withClient(c => c.TagDeleteRemote({ repoId, remote, name })),
            ),
        // ── conflicts (P4) ────────────────────────────────────────────────────────
        conflictList: repoId =>
            runtime.runPromise(withClient(c => c.ConflictList({ repoId }))),
        conflictSides: (repoId, path) =>
            runtime.runPromise(
                withClient(c => c.ConflictSides({ repoId, path })),
            ),
        conflictResolve: (repoId, paths, resolution) =>
            runtime.runPromise(
                withClient(c =>
                    c.ConflictResolve({ repoId, paths, resolution }),
                ),
            ),
        conflictSaveMerged: (repoId, path, content, encoding) =>
            runtime.runPromise(
                withClient(c =>
                    c.ConflictSaveMerged({ repoId, path, content, encoding }),
                ),
            ),
        conflictMarkResolved: (repoId, paths) =>
            runtime.runPromise(
                withClient(c => c.ConflictMarkResolved({ repoId, paths })),
            ),
        conflictMarkUnresolved: (repoId, paths) =>
            runtime.runPromise(
                withClient(c => c.ConflictMarkUnresolved({ repoId, paths })),
            ),
        // ── cherry-pick / revert + continuation (P4) ──────────────────────────────
        cherryPick: (repoId, commits, opts) =>
            runtime.runPromise(
                withClient(c => c.CherryPick({ repoId, commits, ...opts })),
            ),
        revert: (repoId, commits, opts) =>
            runtime.runPromise(
                withClient(c => c.Revert({ repoId, commits, ...opts })),
            ),
        opContinue: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.OpContinue({ repoId, ...opts })),
            ),
        opAbort: repoId =>
            runtime.runPromise(withClient(c => c.OpAbort({ repoId }))),
        opSkip: repoId =>
            runtime.runPromise(withClient(c => c.OpSkip({ repoId }))),
        // ── blame & file history (P4) ─────────────────────────────────────────────
        blame: (repoId, path, opts) =>
            runtime.runPromise(
                withClient(c => c.Blame({ repoId, path, ...opts })),
            ),
        fileHistory: (repoId, path, opts) =>
            runtime.runPromise(
                withClient(c => c.FileHistory({ repoId, path, ...opts })),
            ),
        // ── repository maintenance (P5) ─────────────────────────────────────────
        gc: (repoId, opts) =>
            runtime.runPromise(withClient(c => c.RepoGc({ repoId, ...opts }))),
        // ── clean working directory (P5) ────────────────────────────────────────
        cleanPreview: (repoId, directories, ignored) =>
            runtime.runPromise(
                withClient(c =>
                    c.CleanPreview({ repoId, directories, ignored }),
                ),
            ),
        clean: (repoId, paths, directories, ignored) =>
            runtime.runPromise(
                withClient(c =>
                    c.Clean({ repoId, paths, directories, ignored }),
                ),
            ),
        // ── archive export (P5) ─────────────────────────────────────────────────
        archivePrepare: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.ArchivePrepare({ repoId, ...opts })),
            ),
        // ── reflog viewer (P5) ──────────────────────────────────────────────────
        reflogList: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.ReflogList({ repoId, ...opts })),
            ),
        // ── bisect (P5) ─────────────────────────────────────────────────────────
        bisectStart: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.BisectStart({ repoId, ...opts })),
            ),
        bisectMark: (repoId, mark) =>
            runtime.runPromise(withClient(c => c.BisectMark({ repoId, mark }))),
        bisectReset: repoId =>
            runtime.runPromise(withClient(c => c.BisectReset({ repoId }))),
        bisectStatus: repoId =>
            runtime.runPromise(withClient(c => c.BisectStatus({ repoId }))),
        // ── submodules (P5) ───────────────────────────────────────────────────────
        submoduleList: repoId =>
            runtime.runPromise(withClient(c => c.SubmoduleList({ repoId }))),
        submoduleUpdate: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.SubmoduleUpdate({ repoId, ...opts })),
            ),
        submoduleSync: (repoId, opts) =>
            runtime.runPromise(
                withClient(c => c.SubmoduleSync({ repoId, ...opts })),
            ),
        submoduleAdd: (repoId, url, path, branch) =>
            runtime.runPromise(
                withClient(c => c.SubmoduleAdd({ repoId, url, path, branch })),
            ),
        submoduleRemove: (repoId, path) =>
            runtime.runPromise(
                withClient(c => c.SubmoduleRemove({ repoId, path })),
            ),
        // ── settings & git config (P5) ──────────────────────────────────────────────
        configList: repoId =>
            runtime.runPromise(withClient(c => c.ConfigList({ repoId }))),
        configGet: (repoId, key, scope) =>
            runtime.runPromise(
                withClient(c => c.ConfigGet({ repoId, key, scope })),
            ),
        configSet: (repoId, key, value, scope) =>
            runtime.runPromise(
                withClient(c => c.ConfigSet({ repoId, key, value, scope })),
            ),
        configUnset: (repoId, key, scope) =>
            runtime.runPromise(
                withClient(c => c.ConfigUnset({ repoId, key, scope })),
            ),
        appSettingsGet: () =>
            runtime.runPromise(withClient(c => c.ConfigAppGet({}))),
        appSettingsSet: patch =>
            runtime.runPromise(withClient(c => c.ConfigAppSet(patch))),
        inferenceProfilesGet: () =>
            runtime.runPromise(withClient(c => c.InferenceProfilesGet({}))),
        inferenceProfilesDiscover: () =>
            runtime.runPromise(
                withClient(c => c.InferenceProfilesDiscover({})),
            ),
        inferenceModelsDiscover: profileId =>
            runtime.runPromise(
                withClient(c => c.InferenceModelsDiscover({ profileId })),
            ),
        inferenceProfilesSet: profiles =>
            runtime.runPromise(
                withClient(c => c.InferenceProfilesSet({ profiles })),
            ),
        workspaceInferenceDefaultsGet: engagementId =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceInferenceDefaultsGet({ engagementId }),
                ),
            ),
        workspaceInferenceDefaultsSet: (engagementId, defaults) =>
            runtime.runPromise(
                withClient(c =>
                    c.WorkspaceInferenceDefaultsSet({
                        engagementId,
                        defaults,
                    }),
                ),
            ),
        // ── interactive rebase (P5) ─────────────────────────────────────────────────
        rebasePlan: (repoId, upstream, opts) =>
            runtime.runPromise(
                withClient(c => c.RebasePlan({ repoId, upstream, ...opts })),
            ),
        rebaseStart: (repoId, upstream, steps, opts) =>
            runtime.runPromise(
                withClient(c =>
                    c.RebaseStart({ repoId, upstream, steps, ...opts }),
                ),
            ),
        rebaseStatus: repoId =>
            runtime.runPromise(withClient(c => c.RebaseStatus({ repoId }))),
    };
};
