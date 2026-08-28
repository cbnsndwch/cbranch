import {
    type Engagement,
    type WorkspaceIntelligenceAnalysisSettings,
    WorkspaceIntelligencePresentation,
    type WorkspaceIntelligenceRun,
    type WorkspaceIntelligenceGraphNode,
    type WorkspaceIntelligenceGraphEdge,
    type WorkspaceIntelligenceCurationAction,
    type WorkspaceIntelligenceEnrichmentAttempt,
} from '@cbranch/rpc-contract';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useApi } from '../rpc/ApiProvider';
import { queryKeys } from '../rpc/query-keys';
import { useUiStore } from '../state/store';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { WorkspaceIntelligenceGraph } from './WorkspaceIntelligenceGraph';
import { workspaceIntelligenceReportPreview } from './workspace-intelligence-report';
import {
    startWorkspaceIntelligenceTour,
    workspaceIntelligenceTourProgress,
} from './workspace-intelligence-tour';

const activeStates = new Set([
    'queued',
    'preparing',
    'running',
    'cancelling',
    'recovering',
]);

const title = (state: WorkspaceIntelligenceRun['state']): string =>
    state.charAt(0).toUpperCase() + state.slice(1);

const tone = (state: WorkspaceIntelligenceRun['state']) =>
    state === 'completed'
        ? 'default'
        : state === 'failed' || state === 'cancelled' || state === 'interrupted'
          ? 'danger'
          : 'warn';

const curationEdgeTarget = (edge: WorkspaceIntelligenceGraphEdge): string =>
    `${edge.from}\0${edge.kind}\0${edge.to}`;

const displayCurationTarget = (target: string): string =>
    target.split('\0').join(' · ');

const isCuratableEdge = (edge: WorkspaceIntelligenceGraphEdge): boolean =>
    !edge.from.startsWith('curation:component-group:') &&
    !edge.to.startsWith('curation:component-group:');

const confidenceRank = {
    low: 0,
    medium: 1,
    high: 2,
} as const;

const parsePatterns = (value: string): ReadonlyArray<string> =>
    value
        .split(/\r?\n/)
        .map(pattern => pattern.trim())
        .filter(pattern => pattern !== '');

const scrollToWorkspaceIntelligenceSection = (id: string) =>
    document
        .getElementById(id)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const intelligenceNavigation = [
    {
        id: 'workspace-intelligence-analysis',
        label: 'Overview',
    },
    {
        id: 'workspace-intelligence-runs',
        label: 'Runs',
    },
] as const;

/** M1 workspace view: durable run history and truthful foundation coverage only. */
export function WorkspaceIntelligencePanel({
    engagement,
}: {
    readonly engagement: Engagement;
}) {
    const api = useApi();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const setSettingsDialogOpen = useUiStore(s => s.setSettingsDialogOpen);
    const setSettingsDialogTab = useUiStore(s => s.setSettingsDialogTab);
    const { runId: routeRunId } = useParams();
    const [searchParams, setSearchParams] = useSearchParams();
    const routeNodeId = searchParams.get('node') ?? undefined;
    const [starting, setStarting] = useState(false);
    const [analysisSettingsDraft, setAnalysisSettingsDraft] = useState<
        WorkspaceIntelligenceAnalysisSettings | undefined
    >();
    const [savingAnalysisSettings, setSavingAnalysisSettings] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [selectedRepoIds, setSelectedRepoIds] = useState(
        () =>
            new Set(
                engagement.repositories.map(repository => repository.repoId),
            ),
    );
    const [query, setQuery] = useState('');
    const [semanticSearch, setSemanticSearch] = useState(false);
    const [semanticRequestedQuery, setSemanticRequestedQuery] = useState<
        string | undefined
    >();
    const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
        routeRunId,
    );
    const [neighborhoodNodeId, setNeighborhoodNodeId] = useState<
        string | undefined
    >();
    const [diffFromRunId, setDiffFromRunId] = useState<
        WorkspaceIntelligenceRun['id'] | undefined
    >();
    const [deleteCandidateRunId, setDeleteCandidateRunId] = useState<
        string | undefined
    >();
    const [clearCurrentCandidate, setClearCurrentCandidate] = useState(false);
    const [clearHistoryCandidate, setClearHistoryCandidate] = useState(false);
    const [editingComponentId, setEditingComponentId] = useState<
        string | undefined
    >();
    const [componentDisplayName, setComponentDisplayName] = useState('');
    const [componentKind, setComponentKind] = useState('');
    const [componentNote, setComponentNote] = useState('');
    const [componentMergeGroup, setComponentMergeGroup] = useState('');
    const [editingEdgeTarget, setEditingEdgeTarget] = useState<
        string | undefined
    >();
    const [edgeNote, setEdgeNote] = useState('');
    const [enriching, setEnriching] = useState(false);
    const [showInferredEdges, setShowInferredEdges] = useState(false);
    const [enrichmentProfileId, setEnrichmentProfileId] = useState<
        string | undefined
    >();
    const [semanticProfileId, setSemanticProfileId] = useState<
        string | undefined
    >();
    const [tourProgress, setTourProgress] = useState(
        workspaceIntelligenceTourProgress,
    );

    const runsQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceRuns(engagement.id),
        queryFn: () => api.workspaceIntelligenceRunList!(engagement.id),
        enabled: api.workspaceIntelligenceRunList !== undefined,
    });
    const analysisSettingsQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceAnalysisSettings(
            engagement.id,
        ),
        queryFn: () =>
            api.workspaceIntelligenceAnalysisSettings!(engagement.id),
        enabled: api.workspaceIntelligenceAnalysisSettings !== undefined,
    });
    const componentOverridesQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceComponentOverrides(
            engagement.id,
        ),
        queryFn: () =>
            api.workspaceIntelligenceComponentOverrides!(engagement.id),
        enabled: api.workspaceIntelligenceComponentOverrides !== undefined,
    });
    const curationActionsQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceCurationActions(engagement.id),
        queryFn: () => api.workspaceIntelligenceCurationActions!(engagement.id),
        enabled: api.workspaceIntelligenceCurationActions !== undefined,
    });
    const inferenceProfilesQuery = useQuery({
        queryKey: queryKeys.inferenceProfiles(),
        queryFn: () => api.inferenceProfilesGet!(),
        enabled: api.inferenceProfilesGet !== undefined,
        retry: false,
    });
    const runs = runsQuery.data ?? [];
    const loading = runsQuery.isLoading;
    const analysisSettings =
        analysisSettingsDraft ?? analysisSettingsQuery.data;
    const overrides = componentOverridesQuery.data ?? [];
    const curationActions = curationActionsQuery.data ?? [];
    const profiles = inferenceProfilesQuery.data ?? [];
    const generationProfiles = useMemo(
        () =>
            profiles.filter(
                profile =>
                    profile.enabled &&
                    profile.capabilities.includes('generation'),
            ),
        [profiles],
    );
    const embeddingProfiles = useMemo(
        () =>
            profiles.filter(
                profile =>
                    profile.enabled &&
                    profile.capabilities.includes('embeddings'),
            ),
        [profiles],
    );
    const needsGenerationSetup =
        api.inferenceProfilesGet !== undefined &&
        !inferenceProfilesQuery.isLoading &&
        generationProfiles.length === 0;

    useEffect(() => {
        setSelectedRepoIds(
            new Set(
                engagement.repositories.map(repository => repository.repoId),
            ),
        );
    }, [engagement.id, engagement.repositories]);

    const active = useMemo(
        () => runs.find(run => activeStates.has(run.state)),
        [runs],
    );
    const current = useMemo(
        () => runs.find(run => run.isCurrent && run.isValid),
        [runs],
    );
    const selected = useMemo(
        () =>
            runs.find(run => run.id === (routeRunId ?? selectedRunId)) ??
            current,
        [current, routeRunId, runs, selectedRunId],
    );
    const selectedNodeId = routeNodeId ?? neighborhoodNodeId;

    const reportQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceReport(
            engagement.id,
            selected?.id ?? 'none',
        ),
        queryFn: () =>
            api.workspaceIntelligenceRunReport!(engagement.id, selected!.id),
        enabled:
            selected !== undefined &&
            api.workspaceIntelligenceRunReport !== undefined,
    });
    const report = reportQuery.data;
    const reportPreview = useMemo(
        () =>
            report === undefined
                ? undefined
                : workspaceIntelligenceReportPreview(report.markdown),
        [report],
    );
    const presentationQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligencePresentation(
            engagement.id,
            selected?.id ?? 'none',
        ),
        queryFn: () =>
            api.workspaceIntelligencePresentationGet!(
                engagement.id,
                selected!.id,
            ),
        enabled:
            selected !== undefined &&
            api.workspaceIntelligencePresentationGet !== undefined,
    });
    const semanticMode =
        semanticSearch &&
        semanticRequestedQuery === query &&
        api.workspaceIntelligenceSemanticSearch !== undefined;
    const searchQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceSearch(
            engagement.id,
            selected?.id ?? 'none',
            query,
            semanticMode ? 'semantic' : 'lexical',
            semanticMode ? semanticProfileId : undefined,
        ),
        queryFn: async () =>
            semanticMode
                ? api.workspaceIntelligenceSemanticSearch!(
                      engagement.id,
                      selected!.id,
                      query,
                      undefined,
                      semanticProfileId,
                  )
                : {
                      ...(await api.workspaceIntelligenceGraphSearch!(
                          engagement.id,
                          selected!.id,
                          query,
                      )),
                      mode: 'lexical' as const,
                  },
        enabled:
            selected !== undefined &&
            query.trim() !== '' &&
            (semanticMode ||
                api.workspaceIntelligenceGraphSearch !== undefined),
    });
    const matches = searchQuery.data?.nodes ?? [];
    const searchStatus =
        searchQuery.data?.mode === 'lexical-fallback'
            ? searchQuery.data.message
            : undefined;
    const enrichmentsQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceEnrichments(
            engagement.id,
            selected?.id ?? 'none',
        ),
        queryFn: () =>
            api.workspaceIntelligenceEnrichmentList!(
                engagement.id,
                selected!.id,
            ),
        enabled:
            selected !== undefined &&
            api.workspaceIntelligenceEnrichmentList !== undefined,
    });
    const preferredEnrichmentQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligencePreferredEnrichment(
            engagement.id,
            selected?.id ?? 'none',
        ),
        queryFn: async () =>
            (await api.workspaceIntelligenceEnrichmentPreferredGet!(
                engagement.id,
                selected!.id,
            )) ?? null,
        enabled:
            selected !== undefined &&
            api.workspaceIntelligenceEnrichmentPreferredGet !== undefined,
    });
    const enrichments = enrichmentsQuery.data ?? [];
    const preferredEnrichment = preferredEnrichmentQuery.data ?? undefined;
    const neighborhoodQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceNeighborhood(
            engagement.id,
            selected?.id ?? 'none',
            selectedNodeId ?? 'none',
        ),
        queryFn: () =>
            api.workspaceIntelligenceGraphNeighborhood!(
                engagement.id,
                selected!.id,
                selectedNodeId!,
            ),
        enabled:
            selected !== undefined &&
            selectedNodeId !== undefined &&
            api.workspaceIntelligenceGraphNeighborhood !== undefined,
    });
    const neighborhood = neighborhoodQuery.data;
    const diffQuery = useQuery({
        queryKey: queryKeys.workspaceIntelligenceDiff(
            engagement.id,
            diffFromRunId ?? 'none',
            current?.id ?? 'none',
        ),
        queryFn: () =>
            api.workspaceIntelligenceGraphDiff!(
                engagement.id,
                diffFromRunId!,
                current!.id,
            ),
        enabled:
            diffFromRunId !== undefined &&
            current !== undefined &&
            api.workspaceIntelligenceGraphDiff !== undefined,
    });
    const diff = diffQuery.data;
    const queryError = [
        runsQuery.error,
        analysisSettingsQuery.error,
        componentOverridesQuery.error,
        curationActionsQuery.error,
        inferenceProfilesQuery.error,
        reportQuery.error,
        presentationQuery.error,
        searchQuery.error,
        enrichmentsQuery.error,
        preferredEnrichmentQuery.error,
        neighborhoodQuery.error,
        diffQuery.error,
    ].find(reason => reason !== null);
    const visibleError =
        error ??
        (queryError instanceof Error
            ? queryError.message
            : queryError === undefined
              ? undefined
              : String(queryError));
    const minimumConfidenceTier =
        presentationQuery.data?.minimumConfidenceTier ?? 'low';

    useEffect(() => {
        setAnalysisSettingsDraft(undefined);
    }, [engagement.id]);

    useEffect(() => {
        setShowInferredEdges(false);
        setNeighborhoodNodeId(undefined);
    }, [selected?.id]);

    useEffect(() => {
        const presentation = presentationQuery.data;
        if (presentation === undefined) return;
        setShowInferredEdges(presentation.showInferredEdges);
        if (routeNodeId === undefined)
            setNeighborhoodNodeId(presentation.selectedNodeId);
    }, [presentationQuery.data, routeNodeId]);

    const updatePresentation = async (
        patch: Partial<
            Pick<
                WorkspaceIntelligencePresentation,
                | 'selectedNodeId'
                | 'expandedNodeIds'
                | 'nodePositions'
                | 'showInferredEdges'
                | 'minimumConfidenceTier'
            >
        >,
    ) => {
        if (
            selected === undefined ||
            api.workspaceIntelligencePresentationSet === undefined
        )
            return;
        const existing =
            presentationQuery.data ??
            new WorkspaceIntelligencePresentation({
                schemaVersion: 1,
                runId: selected.id,
                expandedNodeIds: [],
                nodePositions: [],
                showInferredEdges: false,
                minimumConfidenceTier: 'low',
            });
        const next = new WorkspaceIntelligencePresentation({
            ...existing,
            ...patch,
            runId: selected.id,
        });
        const key = queryKeys.workspaceIntelligencePresentation(
            engagement.id,
            selected.id,
        );
        queryClient.setQueryData(key, next);
        try {
            queryClient.setQueryData(
                key,
                await api.workspaceIntelligencePresentationSet(
                    engagement.id,
                    next,
                ),
            );
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            void queryClient.invalidateQueries({ queryKey: key });
        }
    };

    useEffect(() => {
        if (
            active === undefined ||
            api.workspaceIntelligenceRunSubscribe === undefined
        )
            return;
        return api.workspaceIntelligenceRunSubscribe(
            engagement.id,
            active.id,
            active.eventSequence,
            {
                onItem: () =>
                    void queryClient.invalidateQueries({
                        queryKey: queryKeys.workspaceIntelligenceRuns(
                            engagement.id,
                        ),
                    }),
                onError: reason =>
                    setError(
                        reason instanceof Error
                            ? reason.message
                            : String(reason),
                    ),
                onComplete: () =>
                    void queryClient.invalidateQueries({
                        queryKey: queryKeys.workspaceIntelligenceRuns(
                            engagement.id,
                        ),
                    }),
            },
        );
        // Events are sequenced by the server; reload keeps display state React-owned.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        active?.id,
        active?.eventSequence,
        api.workspaceIntelligenceRunSubscribe,
        engagement.id,
        queryClient,
    ]);

    const start = async () => {
        if (api.workspaceIntelligenceStart === undefined) return;
        setStarting(true);
        try {
            const repositoryIds = [...selectedRepoIds];
            const run =
                analysisSettings === undefined
                    ? await api.workspaceIntelligenceStart(
                          engagement.id,
                          repositoryIds,
                      )
                    : await api.workspaceIntelligenceStart(
                          engagement.id,
                          repositoryIds,
                          analysisSettings,
                      );
            queryClient.setQueryData<ReadonlyArray<WorkspaceIntelligenceRun>>(
                queryKeys.workspaceIntelligenceRuns(engagement.id),
                existingRuns => [
                    run,
                    ...(existingRuns ?? []).filter(item => item.id !== run.id),
                ],
            );
            toast.success('Workspace Intelligence run started');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        } finally {
            setStarting(false);
        }
    };

    const updateAnalysisNumber = (
        field:
            | 'maxSourceFiles'
            | 'maxSourceFileBytes'
            | 'maxRepositorySourceBytes'
            | 'maxRepositoryDurationMs'
            | 'maxGraphNodes'
            | 'maxGraphEdges',
        value: string,
    ) => {
        const number = Number(value);
        if (!Number.isFinite(number)) return;
        setAnalysisSettingsDraft(settings => {
            const currentSettings = settings ?? analysisSettingsQuery.data;
            return currentSettings === undefined
                ? settings
                : {
                      ...currentSettings,
                      [field]: number,
                  };
        });
    };

    const saveAnalysisSettings = async () => {
        if (
            analysisSettings === undefined ||
            api.workspaceIntelligenceAnalysisSettingsSet === undefined
        )
            return;
        setSavingAnalysisSettings(true);
        try {
            const settings = await api.workspaceIntelligenceAnalysisSettingsSet(
                engagement.id,
                analysisSettings,
            );
            queryClient.setQueryData(
                queryKeys.workspaceIntelligenceAnalysisSettings(engagement.id),
                settings,
            );
            setAnalysisSettingsDraft(undefined);
            toast.success('Workspace analysis settings saved');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        } finally {
            setSavingAnalysisSettings(false);
        }
    };

    const cancel = async () => {
        if (
            active === undefined ||
            api.workspaceIntelligenceRunCancel === undefined
        )
            return;
        try {
            const run = await api.workspaceIntelligenceRunCancel(
                engagement.id,
                active.id,
            );
            queryClient.setQueryData<ReadonlyArray<WorkspaceIntelligenceRun>>(
                queryKeys.workspaceIntelligenceRuns(engagement.id),
                existingRuns =>
                    (existingRuns ?? []).map(item =>
                        item.id === run.id ? run : item,
                    ),
            );
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    };

    const deleteRun = async (run: WorkspaceIntelligenceRun) => {
        if (api.workspaceIntelligenceRunDelete === undefined) return;
        try {
            await api.workspaceIntelligenceRunDelete(engagement.id, run.id);
            queryClient.setQueryData<ReadonlyArray<WorkspaceIntelligenceRun>>(
                queryKeys.workspaceIntelligenceRuns(engagement.id),
                existingRuns =>
                    (existingRuns ?? []).filter(item => item.id !== run.id),
            );
            setDeleteCandidateRunId(undefined);
            if (diffFromRunId === run.id) setDiffFromRunId(undefined);
            if (selected?.id === run.id) {
                setSelectedRunId(undefined);
                navigate(`/w/${engagement.slug}/intelligence`);
            }
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    };

    const setCurrent = async (run: WorkspaceIntelligenceRun) => {
        if (api.workspaceIntelligenceCurrentSet === undefined) return;
        try {
            await api.workspaceIntelligenceCurrentSet(engagement.id, run.id);
            await queryClient.invalidateQueries({
                queryKey: queryKeys.workspaceIntelligenceRuns(engagement.id),
            });
            toast.success('Workspace Intelligence current run updated');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        }
    };

    const clearCurrent = async () => {
        if (api.workspaceIntelligenceCurrentClear === undefined) return;
        try {
            await api.workspaceIntelligenceCurrentClear(engagement.id);
            setClearCurrentCandidate(false);
            await queryClient.invalidateQueries({
                queryKey: queryKeys.workspaceIntelligenceRuns(engagement.id),
            });
            toast.success('Workspace Intelligence current run cleared');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        }
    };

    const clearRunHistory = async () => {
        if (api.workspaceIntelligenceRunHistoryClear === undefined) return;
        try {
            await api.workspaceIntelligenceRunHistoryClear(engagement.id);
            queryClient.setQueryData<ReadonlyArray<WorkspaceIntelligenceRun>>(
                queryKeys.workspaceIntelligenceRuns(engagement.id),
                [],
            );
            setDiffFromRunId(undefined);
            setNeighborhoodNodeId(undefined);
            setSelectedRunId(undefined);
            setClearHistoryCandidate(false);
            navigate(`/w/${engagement.slug}/intelligence`);
            toast.success('Workspace Intelligence run history cleared');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        }
    };

    const downloadArchive = async (run: WorkspaceIntelligenceRun) => {
        if (api.workspaceIntelligenceArchiveRequest === undefined) return;
        try {
            const archive = await api.workspaceIntelligenceArchiveRequest(
                engagement.id,
                run.id,
            );
            const link = document.createElement('a');
            link.href = archive.url;
            link.download = archive.filename;
            link.click();
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    };

    const openInferenceSettings = () => {
        setSettingsDialogTab('inference');
        setSettingsDialogOpen(true);
    };

    const startGuide = () => {
        startWorkspaceIntelligenceTour({
            hasReport: report !== undefined,
            hasGenerationProfile: generationProfiles.length > 0,
            onProgressChange: setTourProgress,
        });
    };

    const startEnrichment = async () => {
        if (
            selected === undefined ||
            api.workspaceIntelligenceEnrichmentStart === undefined
        )
            return;
        setEnriching(true);
        try {
            const attempt =
                enrichmentProfileId === undefined
                    ? await api.workspaceIntelligenceEnrichmentStart(
                          engagement.id,
                          selected.id,
                      )
                    : await api.workspaceIntelligenceEnrichmentStart(
                          engagement.id,
                          selected.id,
                          enrichmentProfileId,
                      );
            queryClient.setQueryData<
                ReadonlyArray<WorkspaceIntelligenceEnrichmentAttempt>
            >(
                queryKeys.workspaceIntelligenceEnrichments(
                    engagement.id,
                    selected.id,
                ),
                existing => [
                    attempt,
                    ...(existing ?? []).filter(item => item.id !== attempt.id),
                ],
            );
            if (attempt.state === 'completed')
                toast.success('Optional enrichment completed');
            else toast.error(attempt.failure?.message ?? 'Enrichment failed');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        } finally {
            setEnriching(false);
        }
    };

    const cancelEnrichment = async () => {
        if (
            selected === undefined ||
            api.workspaceIntelligenceEnrichmentCancel === undefined
        )
            return;
        try {
            await api.workspaceIntelligenceEnrichmentCancel(
                engagement.id,
                selected.id,
            );
            toast.info('Enrichment cancellation requested');
        } catch (reason) {
            const message =
                reason instanceof Error ? reason.message : String(reason);
            setError(message);
            toast.error(message);
        }
    };

    const setPreferredAttempt = async (attemptId?: string) => {
        if (
            selected === undefined ||
            api.workspaceIntelligenceEnrichmentPreferredSet === undefined
        )
            return;
        try {
            queryClient.setQueryData(
                queryKeys.workspaceIntelligencePreferredEnrichment(
                    engagement.id,
                    selected.id,
                ),
                (await api.workspaceIntelligenceEnrichmentPreferredSet(
                    engagement.id,
                    selected.id,
                    attemptId,
                )) ?? null,
            );
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        }
    };

    const setComponentSuppressed = (
        componentId: string,
        suppressed: boolean,
    ) => {
        const save = api.workspaceIntelligenceComponentOverridesSet;
        if (save === undefined) return;
        const existing = overrides.find(
            override => override.componentId === componentId,
        );
        void save(engagement.id, [
            ...overrides.filter(
                override => override.componentId !== componentId,
            ),
            { ...existing, componentId, suppressed },
        ])
            .then(value =>
                queryClient.setQueryData(
                    queryKeys.workspaceIntelligenceComponentOverrides(
                        engagement.id,
                    ),
                    value,
                ),
            )
            .then(() =>
                queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceIntelligenceRuns(
                        engagement.id,
                    ),
                }),
            )
            .catch(reason =>
                setError(
                    reason instanceof Error ? reason.message : String(reason),
                ),
            );
    };

    const beginComponentEdit = (node: WorkspaceIntelligenceGraphNode) => {
        const existing = overrides.find(
            override => override.componentId === node.id,
        );
        setEditingComponentId(node.id);
        setComponentDisplayName(existing?.displayName ?? node.label);
        setComponentKind(existing?.kind ?? node.kind);
        setComponentNote(existing?.note ?? '');
        setComponentMergeGroup(existing?.mergeGroup ?? '');
    };

    const saveComponentCuration = (componentId: string) => {
        const save = api.workspaceIntelligenceComponentOverridesSet;
        if (save === undefined) return;
        const existing = overrides.find(
            override => override.componentId === componentId,
        );
        const {
            mergeGroup: _mergeGroup,
            mergeGroupLabel: _mergeGroupLabel,
            ...withoutMergeGroup
        } = existing ?? { componentId };
        const mergeGroup = componentMergeGroup.trim();
        void save(engagement.id, [
            ...overrides.filter(
                override => override.componentId !== componentId,
            ),
            {
                ...withoutMergeGroup,
                componentId,
                displayName: componentDisplayName.trim() || undefined,
                kind: componentKind.trim() || undefined,
                note: componentNote.trim() || undefined,
                ...(mergeGroup === ''
                    ? {}
                    : {
                          mergeGroup,
                          mergeGroupLabel: mergeGroup,
                      }),
            },
        ])
            .then(value => {
                queryClient.setQueryData(
                    queryKeys.workspaceIntelligenceComponentOverrides(
                        engagement.id,
                    ),
                    value,
                );
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceIntelligenceRuns(
                        engagement.id,
                    ),
                });
                setEditingComponentId(undefined);
            })
            .catch(reason =>
                setError(
                    reason instanceof Error ? reason.message : String(reason),
                ),
            );
    };

    const splitComponent = (componentId: string) => {
        const save = api.workspaceIntelligenceComponentOverridesSet;
        if (save === undefined) return;
        const existing = overrides.find(
            override => override.componentId === componentId,
        );
        if (existing === undefined) return;
        const {
            mergeGroup: _mergeGroup,
            mergeGroupLabel: _mergeGroupLabel,
            ...withoutMergeGroup
        } = existing;
        void save(engagement.id, [
            ...overrides.filter(
                override => override.componentId !== componentId,
            ),
            withoutMergeGroup,
        ])
            .then(value =>
                queryClient.setQueryData(
                    queryKeys.workspaceIntelligenceComponentOverrides(
                        engagement.id,
                    ),
                    value,
                ),
            )
            .then(() =>
                queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceIntelligenceRuns(
                        engagement.id,
                    ),
                }),
            )
            .catch(reason =>
                setError(
                    reason instanceof Error ? reason.message : String(reason),
                ),
            );
    };

    const appendEdgeCuration = (
        edge: WorkspaceIntelligenceGraphEdge,
        kind: 'edge.annotate' | 'edge.confirm' | 'edge.reject',
    ) => {
        const append = api.workspaceIntelligenceCurationActionAppend;
        if (append === undefined) return;
        const targetId = curationEdgeTarget(edge);
        void append(engagement.id, {
            kind,
            targetId,
            evidence: edge.evidence,
            ...(kind === 'edge.annotate' && edgeNote.trim() !== ''
                ? { metadata: { note: edgeNote.trim() } }
                : {}),
        })
            .then(action => {
                queryClient.setQueryData<
                    ReadonlyArray<WorkspaceIntelligenceCurationAction>
                >(
                    queryKeys.workspaceIntelligenceCurationActions(
                        engagement.id,
                    ),
                    actions => [...(actions ?? []), action],
                );
                setEditingEdgeTarget(undefined);
                setEdgeNote('');
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceIntelligenceRuns(
                        engagement.id,
                    ),
                });
            })
            .catch(reason =>
                setError(
                    reason instanceof Error ? reason.message : String(reason),
                ),
            );
    };

    const appendInferredEdgeCuration = (
        attempt: WorkspaceIntelligenceEnrichmentAttempt,
        edge: WorkspaceIntelligenceEnrichmentAttempt['inferredEdges'][number],
        kind: 'edge.annotate' | 'edge.confirm' | 'edge.reject',
    ) => {
        const append = api.workspaceIntelligenceCurationActionAppend;
        if (append === undefined) return;
        const targetId = `${edge.from}\0${edge.kind}\0${edge.to}`;
        void append(engagement.id, {
            kind,
            targetId,
            evidence: edge.evidenceIds.map(evidenceId => ({
                kind: 'inference.selected-evidence',
                attemptId: attempt.id,
                evidenceId,
            })),
            metadata: {
                source: 'workspace-intelligence-inference',
                attemptId: attempt.id,
                profileId: attempt.profileId,
                modelId: attempt.modelId,
                ...(kind === 'edge.annotate' && edgeNote.trim() !== ''
                    ? { note: edgeNote.trim() }
                    : {}),
            },
        })
            .then(action => {
                queryClient.setQueryData<
                    ReadonlyArray<WorkspaceIntelligenceCurationAction>
                >(
                    queryKeys.workspaceIntelligenceCurationActions(
                        engagement.id,
                    ),
                    actions => [...(actions ?? []), action],
                );
                setEditingEdgeTarget(undefined);
                setEdgeNote('');
                void queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceIntelligenceRuns(
                        engagement.id,
                    ),
                });
            })
            .catch(reason =>
                setError(
                    reason instanceof Error ? reason.message : String(reason),
                ),
            );
    };

    const clearRejectedEdgeCuration = (targetId: string) => {
        const append = api.workspaceIntelligenceCurationActionAppend;
        if (append === undefined) return;
        void append(engagement.id, { kind: 'edge.clear', targetId })
            .then(action =>
                queryClient.setQueryData<
                    ReadonlyArray<WorkspaceIntelligenceCurationAction>
                >(
                    queryKeys.workspaceIntelligenceCurationActions(
                        engagement.id,
                    ),
                    actions => [...(actions ?? []), action],
                ),
            )
            .then(() =>
                queryClient.invalidateQueries({
                    queryKey: queryKeys.workspaceIntelligenceRuns(
                        engagement.id,
                    ),
                }),
            )
            .catch(reason =>
                setError(
                    reason instanceof Error ? reason.message : String(reason),
                ),
            );
    };

    const suppressedOverrides = overrides.filter(
        override => override.suppressed,
    );
    const mergedOverrides = overrides.filter(
        override => override.mergeGroup !== undefined,
    );
    const orphanedOverrides = overrides.filter(override => override.isOrphaned);
    const rejectedEdgeActions = useMemo(() => {
        const disposition = new Map<
            string,
            WorkspaceIntelligenceCurationAction
        >();
        for (const action of curationActions) {
            if (!action.kind.startsWith('edge.')) continue;
            if (action.kind === 'edge.clear') {
                disposition.delete(action.targetId);
                continue;
            }
            if (action.kind === 'edge.annotate') continue;
            disposition.set(action.targetId, action);
        }
        return [...disposition.values()].filter(
            action => action.kind === 'edge.reject',
        );
    }, [curationActions]);
    const edgeDisposition = (targetId: string) => {
        for (const action of curationActions.toReversed()) {
            if (
                action.targetId !== targetId ||
                !action.kind.startsWith('edge.')
            )
                continue;
            if (action.kind === 'edge.clear') return undefined;
            if (action.kind === 'edge.confirm' || action.kind === 'edge.reject')
                return action.kind;
        }
        return undefined;
    };

    if (api.workspaceIntelligenceRunList === undefined)
        return (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <Sparkles className="text-muted-foreground size-8" />
                <p className="text-muted-foreground text-sm">
                    Workspace Intelligence requires a host that supports this
                    cbranch version.
                </p>
            </div>
        );

    return (
        <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="flex w-full min-w-0 flex-col gap-5">
                <nav
                    aria-label="Intelligence sections"
                    className="bg-background/95 sticky top-0 z-10 -mx-4 flex overflow-x-auto border-y px-4 py-2 backdrop-blur"
                >
                    <div className="flex min-w-max items-center gap-1">
                        {intelligenceNavigation.map(item => (
                            <a
                                key={item.id}
                                href={`#${item.id}`}
                                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                                onClick={event => {
                                    event.preventDefault();
                                    scrollToWorkspaceIntelligenceSection(
                                        item.id,
                                    );
                                }}
                            >
                                {item.label}
                            </a>
                        ))}
                        {report ? (
                            <a
                                href="#workspace-intelligence-report"
                                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                                onClick={event => {
                                    event.preventDefault();
                                    scrollToWorkspaceIntelligenceSection(
                                        'workspace-intelligence-report',
                                    );
                                }}
                            >
                                Report
                            </a>
                        ) : null}
                        {selected && api.workspaceIntelligenceGraphSearch ? (
                            <a
                                href="#workspace-intelligence-search"
                                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                                onClick={event => {
                                    event.preventDefault();
                                    scrollToWorkspaceIntelligenceSection(
                                        'workspace-intelligence-search',
                                    );
                                }}
                            >
                                Explore graph
                            </a>
                        ) : null}
                        {selected?.isValid &&
                        api.workspaceIntelligenceEnrichmentStart &&
                        api.workspaceIntelligenceEnrichmentList &&
                        api.workspaceIntelligenceEnrichmentPreferredSet ? (
                            <a
                                href="#workspace-intelligence-enrichment"
                                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                                onClick={event => {
                                    event.preventDefault();
                                    scrollToWorkspaceIntelligenceSection(
                                        'workspace-intelligence-enrichment',
                                    );
                                }}
                            >
                                AI enrichment
                            </a>
                        ) : null}
                    </div>
                </nav>
                <section
                    id="workspace-intelligence-analysis"
                    className="scroll-mt-14 rounded-lg border p-4"
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold">
                                Analyze workspace
                            </h2>
                            <p className="text-muted-foreground mt-1 text-sm">
                                Create a durable, read-only architecture report
                                for selected workspace repositories.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={startGuide}
                            >
                                {tourProgress === undefined
                                    ? 'Take a quick tour'
                                    : 'Continue guide'}
                            </Button>
                            {active === undefined ? (
                                <Button
                                    onClick={() => void start()}
                                    disabled={
                                        starting || selectedRepoIds.size === 0
                                    }
                                >
                                    {starting ? (
                                        <Loader2 className="size-4 animate-spin" />
                                    ) : (
                                        <Sparkles className="size-4" />
                                    )}
                                    Analyze workspace
                                </Button>
                            ) : (
                                <Button
                                    variant="outline"
                                    onClick={() => void cancel()}
                                >
                                    <Square className="size-4" />
                                    Cancel run
                                </Button>
                            )}
                        </div>
                    </div>
                    <p className="text-muted-foreground mt-4 text-xs">
                        This creates a deterministic, read-only architecture
                        report. It does not call an AI provider or send source
                        data anywhere.
                    </p>
                    {analysisSettings !== undefined && (
                        <details className="mt-4 rounded-md border p-3">
                            <summary className="cursor-pointer text-sm font-medium">
                                Analysis scope and safety budgets
                            </summary>
                            <p className="text-muted-foreground mt-2 text-xs">
                                These values constrain source collection and the
                                graph. Saving sets the workspace default; any
                                unsaved edits apply only to the next run.
                            </p>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <label className="grid gap-1 text-xs">
                                    Include patterns (one per line)
                                    <textarea
                                        className="min-h-20 rounded-md border bg-transparent p-2 text-sm"
                                        value={analysisSettings.includePatterns.join(
                                            '\n',
                                        )}
                                        onChange={event => {
                                            const includePatterns =
                                                parsePatterns(
                                                    event.target.value,
                                                );
                                            setAnalysisSettingsDraft(
                                                settings => {
                                                    const currentSettings =
                                                        settings ??
                                                        analysisSettingsQuery.data;
                                                    return currentSettings ===
                                                        undefined
                                                        ? settings
                                                        : {
                                                              ...currentSettings,
                                                              includePatterns,
                                                          };
                                                },
                                            );
                                        }}
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Exclude patterns (one per line)
                                    <textarea
                                        className="min-h-20 rounded-md border bg-transparent p-2 text-sm"
                                        value={analysisSettings.excludePatterns.join(
                                            '\n',
                                        )}
                                        onChange={event => {
                                            const excludePatterns =
                                                parsePatterns(
                                                    event.target.value,
                                                );
                                            setAnalysisSettingsDraft(
                                                settings => {
                                                    const currentSettings =
                                                        settings ??
                                                        analysisSettingsQuery.data;
                                                    return currentSettings ===
                                                        undefined
                                                        ? settings
                                                        : {
                                                              ...currentSettings,
                                                              excludePatterns,
                                                          };
                                                },
                                            );
                                        }}
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Maximum source files
                                    <Input
                                        type="number"
                                        min={1}
                                        value={analysisSettings.maxSourceFiles}
                                        onChange={event =>
                                            updateAnalysisNumber(
                                                'maxSourceFiles',
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Maximum bytes per source file
                                    <Input
                                        type="number"
                                        min={1}
                                        value={
                                            analysisSettings.maxSourceFileBytes
                                        }
                                        onChange={event =>
                                            updateAnalysisNumber(
                                                'maxSourceFileBytes',
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Maximum source bytes per repository
                                    <Input
                                        type="number"
                                        min={1}
                                        value={
                                            analysisSettings.maxRepositorySourceBytes
                                        }
                                        onChange={event =>
                                            updateAnalysisNumber(
                                                'maxRepositorySourceBytes',
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Maximum analysis time per repository (ms)
                                    <Input
                                        type="number"
                                        min={1_000}
                                        value={
                                            analysisSettings.maxRepositoryDurationMs
                                        }
                                        onChange={event =>
                                            updateAnalysisNumber(
                                                'maxRepositoryDurationMs',
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Maximum graph nodes
                                    <Input
                                        type="number"
                                        min={1}
                                        value={analysisSettings.maxGraphNodes}
                                        onChange={event =>
                                            updateAnalysisNumber(
                                                'maxGraphNodes',
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                                <label className="grid gap-1 text-xs">
                                    Maximum graph edges
                                    <Input
                                        type="number"
                                        min={0}
                                        value={analysisSettings.maxGraphEdges}
                                        onChange={event =>
                                            updateAnalysisNumber(
                                                'maxGraphEdges',
                                                event.target.value,
                                            )
                                        }
                                    />
                                </label>
                            </div>
                            <Button
                                className="mt-3"
                                variant="outline"
                                size="sm"
                                onClick={() => void saveAnalysisSettings()}
                                disabled={savingAnalysisSettings}
                            >
                                {savingAnalysisSettings
                                    ? 'Saving…'
                                    : 'Save workspace defaults'}
                            </Button>
                        </details>
                    )}
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {engagement.repositories.map(repository => (
                            <label
                                key={repository.repoId}
                                className="flex items-center gap-2 text-sm"
                            >
                                <Checkbox
                                    checked={selectedRepoIds.has(
                                        repository.repoId,
                                    )}
                                    onCheckedChange={checked =>
                                        setSelectedRepoIds(existingRepoIds => {
                                            const next = new Set(
                                                existingRepoIds,
                                            );
                                            if (checked)
                                                next.add(repository.repoId);
                                            else next.delete(repository.repoId);
                                            return next;
                                        })
                                    }
                                />
                                <span className="truncate">
                                    Analyze {repository.name}
                                </span>
                            </label>
                        ))}
                    </div>
                </section>

                <section
                    id="workspace-intelligence-runs"
                    aria-live="polite"
                    className="scroll-mt-14"
                >
                    <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-sm font-semibold">Run history</h2>
                        <div className="flex items-center gap-2">
                            {loading ? (
                                <Loader2 className="size-4 animate-spin" />
                            ) : null}
                            {runs.length > 0 &&
                            api.workspaceIntelligenceRunHistoryClear ? (
                                clearHistoryCandidate ? (
                                    <>
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            disabled={active !== undefined}
                                            onClick={() =>
                                                void clearRunHistory()
                                            }
                                        >
                                            Confirm clear all history
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() =>
                                                setClearHistoryCandidate(false)
                                            }
                                        >
                                            Keep history
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={active !== undefined}
                                        onClick={() =>
                                            setClearHistoryCandidate(true)
                                        }
                                    >
                                        Clear all history
                                    </Button>
                                )
                            ) : null}
                        </div>
                    </div>
                    {visibleError ? (
                        <p className="mb-3 text-sm text-red-600">
                            {visibleError}
                        </p>
                    ) : null}
                    {runs.length === 0 && !loading ? (
                        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                            No Workspace Intelligence runs yet.
                        </p>
                    ) : (
                        <div className="divide-y rounded-lg border">
                            {runs.map(run => (
                                <div
                                    key={run.id}
                                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                                >
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <Badge tone={tone(run.state)}>
                                                {title(run.state)}
                                            </Badge>
                                            {run.isCurrent ? (
                                                <Badge>Current</Badge>
                                            ) : null}
                                            {run.isStale ? (
                                                <Badge tone="warn">Stale</Badge>
                                            ) : null}
                                        </div>
                                        <p className="text-muted-foreground mt-1 text-xs">
                                            {
                                                run.coverage
                                                    .completedRepositoryCount
                                            }
                                            /{run.coverage.repositoryCount}{' '}
                                            repositories ·{' '}
                                            {run.coverage.summary}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <time className="text-muted-foreground text-xs">
                                            {new Date(
                                                run.createdAt,
                                            ).toLocaleString()}
                                        </time>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setSelectedRunId(run.id);
                                                navigate(
                                                    `/w/${engagement.slug}/intelligence/runs/${run.id}`,
                                                );
                                            }}
                                        >
                                            View report
                                        </Button>
                                        {run.isValid &&
                                        api.workspaceIntelligenceArchiveRequest ? (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() =>
                                                    void downloadArchive(run)
                                                }
                                            >
                                                Download archive
                                            </Button>
                                        ) : null}
                                        {current !== undefined &&
                                        current.id !== run.id &&
                                        api.workspaceIntelligenceGraphDiff ? (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => {
                                                    setDiffFromRunId(run.id);
                                                }}
                                            >
                                                Compare current
                                            </Button>
                                        ) : null}
                                        {run.isValid &&
                                        !run.isCurrent &&
                                        api.workspaceIntelligenceCurrentSet ? (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    void setCurrent(run)
                                                }
                                            >
                                                Make current
                                            </Button>
                                        ) : null}
                                        {run.isCurrent &&
                                        api.workspaceIntelligenceCurrentClear ? (
                                            clearCurrentCandidate ? (
                                                <>
                                                    <Button
                                                        size="sm"
                                                        variant="destructive"
                                                        onClick={() =>
                                                            void clearCurrent()
                                                        }
                                                    >
                                                        Confirm clear current
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() =>
                                                            setClearCurrentCandidate(
                                                                false,
                                                            )
                                                        }
                                                    >
                                                        Keep current
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        setClearCurrentCandidate(
                                                            true,
                                                        )
                                                    }
                                                >
                                                    Clear current
                                                </Button>
                                            )
                                        ) : null}
                                        {!run.isCurrent &&
                                        !activeStates.has(run.state) &&
                                        api.workspaceIntelligenceRunDelete ? (
                                            deleteCandidateRunId === run.id ? (
                                                <>
                                                    <Button
                                                        size="sm"
                                                        variant="destructive"
                                                        onClick={() =>
                                                            void deleteRun(run)
                                                        }
                                                    >
                                                        Confirm delete run
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={() =>
                                                            setDeleteCandidateRunId(
                                                                undefined,
                                                            )
                                                        }
                                                    >
                                                        Keep run
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        setDeleteCandidateRunId(
                                                            run.id,
                                                        )
                                                    }
                                                >
                                                    Delete run
                                                </Button>
                                            )
                                        ) : null}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
                {report ? (
                    <section
                        id="workspace-intelligence-report"
                        className="scroll-mt-14 rounded-lg border p-4"
                    >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-semibold">
                                    Architecture report
                                </h2>
                                <p className="text-muted-foreground mt-1 text-sm">
                                    Deterministic analysis completed. These
                                    results are based on the selected
                                    repositories and remain the authoritative
                                    report.
                                </p>
                            </div>
                            <Badge>Deterministic</Badge>
                        </div>
                        <p className="text-muted-foreground mt-3 text-sm">
                            {selected?.coverage.summary}
                        </p>
                        <dl className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="rounded-md border p-3">
                                <dt className="text-muted-foreground text-xs">
                                    Graph nodes
                                </dt>
                                <dd className="mt-1 text-lg font-semibold">
                                    {report.nodeCount}
                                </dd>
                            </div>
                            <div className="rounded-md border p-3">
                                <dt className="text-muted-foreground text-xs">
                                    Relationships
                                </dt>
                                <dd className="mt-1 text-lg font-semibold">
                                    {report.edgeCount}
                                </dd>
                            </div>
                            <div className="rounded-md border p-3">
                                <dt className="text-muted-foreground text-xs">
                                    Findings
                                </dt>
                                <dd className="mt-1 text-lg font-semibold">
                                    {report.findingCount ?? 0}
                                </dd>
                            </div>
                            <div className="rounded-md border p-3">
                                <dt className="text-muted-foreground text-xs">
                                    Explicit unknowns
                                </dt>
                                <dd className="mt-1 text-lg font-semibold">
                                    {report.unknownCount}
                                </dd>
                            </div>
                        </dl>
                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            <section className="rounded-md border p-3">
                                <h3 className="text-sm font-medium">
                                    Architecture findings
                                </h3>
                                {reportPreview?.findings.length ? (
                                    <ul className="mt-2 space-y-2 text-sm">
                                        {reportPreview.findings.map(finding => (
                                            <li
                                                key={`${finding.kind}:${finding.message}`}
                                                className="rounded border p-2"
                                            >
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Badge
                                                        tone={
                                                            finding.severity ===
                                                            'warning'
                                                                ? 'warn'
                                                                : 'muted'
                                                        }
                                                    >
                                                        {finding.severity ===
                                                        'warning'
                                                            ? 'Needs review'
                                                            : 'Info'}
                                                    </Badge>
                                                    <span className="font-medium">
                                                        {finding.kind}
                                                    </span>
                                                </div>
                                                <p className="text-muted-foreground mt-1 text-xs">
                                                    {finding.message}
                                                </p>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="text-muted-foreground mt-2 text-sm">
                                        No architecture-integrity findings were
                                        recorded for this run.
                                    </p>
                                )}
                            </section>
                            <section className="rounded-md border p-3">
                                <h3 className="text-sm font-medium">
                                    Graph preview
                                </h3>
                                <p className="text-muted-foreground mt-1 text-xs">
                                    {reportPreview?.graph.labels.length ?? 0}{' '}
                                    representative nodes ·{' '}
                                    {reportPreview?.graph.edgeCount ?? 0}{' '}
                                    preview relationships
                                </p>
                                {reportPreview?.graph.labels.length ? (
                                    <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
                                        {reportPreview.graph.labels.map(
                                            label => (
                                                <li
                                                    key={label}
                                                    className="bg-muted rounded px-2 py-1"
                                                >
                                                    {label}
                                                </li>
                                            ),
                                        )}
                                    </ul>
                                ) : (
                                    <p className="text-muted-foreground mt-2 text-sm">
                                        This report has no renderable graph
                                        preview. Search its architecture to
                                        inspect available records.
                                    </p>
                                )}
                                {reportPreview?.graph.isBounded ? (
                                    <p className="text-muted-foreground mt-3 text-xs">
                                        This preview is bounded to keep the
                                        report readable. It is not a coverage
                                        warning; inspect the graph or full
                                        artifacts for every record.
                                    </p>
                                ) : null}
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            scrollToWorkspaceIntelligenceSection(
                                                'workspace-intelligence-search',
                                            )
                                        }
                                    >
                                        Inspect graph
                                    </Button>
                                    {selected?.isValid &&
                                    api.workspaceIntelligenceArchiveRequest ? (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                void downloadArchive(selected)
                                            }
                                        >
                                            Download full artifacts
                                        </Button>
                                    ) : null}
                                </div>
                            </section>
                        </div>
                        <details className="mt-4">
                            <summary className="cursor-pointer text-xs font-medium">
                                View raw report source
                            </summary>
                            <pre className="bg-muted mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md p-3 text-xs">
                                {report.markdown}
                            </pre>
                        </details>
                    </section>
                ) : null}
                {selected?.isValid &&
                api.workspaceIntelligenceEnrichmentStart &&
                api.workspaceIntelligenceEnrichmentList &&
                api.workspaceIntelligenceEnrichmentPreferredSet ? (
                    <section
                        id="workspace-intelligence-enrichment"
                        className="scroll-mt-14 rounded-lg border p-4"
                    >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                                <h2 className="text-sm font-semibold">
                                    Optional inference enrichment
                                </h2>
                                <p className="text-muted-foreground mt-1 text-sm">
                                    Uses only selected deterministic graph
                                    evidence. It never changes this architecture
                                    report.
                                </p>
                            </div>
                            <div className="flex gap-2">
                                {inferenceProfilesQuery.isLoading &&
                                api.inferenceProfilesGet !== undefined ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled
                                    >
                                        Loading inference profiles
                                    </Button>
                                ) : needsGenerationSetup ? (
                                    <Button
                                        id="workspace-intelligence-setup-inference"
                                        size="sm"
                                        variant="outline"
                                        onClick={openInferenceSettings}
                                    >
                                        Set up AI enrichment
                                    </Button>
                                ) : (
                                    <Button
                                        id="workspace-intelligence-run-enrichment"
                                        size="sm"
                                        variant="outline"
                                        onClick={() => void startEnrichment()}
                                        disabled={enriching}
                                    >
                                        {enriching ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <Sparkles className="size-4" />
                                        )}
                                        Run enrichment
                                    </Button>
                                )}
                                {enriching &&
                                api.workspaceIntelligenceEnrichmentCancel ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => void cancelEnrichment()}
                                    >
                                        <Square className="size-4" />
                                        Cancel enrichment
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        <p className="text-muted-foreground mt-3 text-xs">
                            {enriching
                                ? 'AI enrichment is running. The deterministic report remains available while it completes.'
                                : enrichments.length === 0
                                  ? 'AI enrichment has not run. The deterministic report and relationships are the active presentation.'
                                  : preferredEnrichment === undefined
                                    ? 'AI enrichment has completed, but deterministic relationships remain the active presentation until you prefer an attempt.'
                                    : `AI enrichment has completed. Using preferred attempt ${preferredEnrichment.id}.`}
                        </p>
                        {generationProfiles.length > 0 ? (
                            <label className="mt-3 flex max-w-sm flex-col gap-1 text-sm">
                                Profile for this attempt
                                <select
                                    aria-label="Enrichment profile override"
                                    className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                                    value={enrichmentProfileId ?? ''}
                                    onChange={event =>
                                        setEnrichmentProfileId(
                                            event.target.value === ''
                                                ? undefined
                                                : event.target.value,
                                        )
                                    }
                                >
                                    <option value="">Workspace default</option>
                                    {generationProfiles.map(profile => (
                                        <option
                                            key={profile.id}
                                            value={profile.id}
                                        >
                                            {profile.label} ·{' '}
                                            {profile.modelId ?? profile.id}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ) : null}
                        {preferredEnrichment !== undefined ? (
                            <Button
                                className="mt-2"
                                size="sm"
                                variant="ghost"
                                onClick={() => void setPreferredAttempt()}
                            >
                                Use deterministic presentation
                            </Button>
                        ) : null}
                        {enrichments.length === 0 ? (
                            <p className="text-muted-foreground mt-3 text-sm">
                                {needsGenerationSetup
                                    ? 'Choose Set up AI enrichment to detect or configure an enabled generation profile. Nothing has been sent to an AI provider.'
                                    : 'No enrichment attempts for this run.'}
                            </p>
                        ) : (
                            <div className="mt-3 divide-y rounded-md border">
                                {enrichments.map(attempt => (
                                    <div key={attempt.id} className="p-3">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                                <Badge
                                                    tone={
                                                        attempt.state ===
                                                        'completed'
                                                            ? 'default'
                                                            : 'danger'
                                                    }
                                                >
                                                    {attempt.state ===
                                                    'completed'
                                                        ? 'Completed'
                                                        : 'Failed'}
                                                </Badge>
                                                <span className="text-sm">
                                                    {attempt.profileId} ·{' '}
                                                    {attempt.modelId}
                                                </span>
                                            </div>
                                            {attempt.state === 'completed' &&
                                            preferredEnrichment?.id !==
                                                attempt.id ? (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        void setPreferredAttempt(
                                                            attempt.id,
                                                        )
                                                    }
                                                >
                                                    Prefer attempt
                                                </Button>
                                            ) : null}
                                        </div>
                                        {attempt.failure ? (
                                            <p className="mt-2 text-sm text-destructive">
                                                {attempt.failure.message}
                                            </p>
                                        ) : null}
                                        {attempt.summary ? (
                                            <p className="text-muted-foreground mt-2 text-sm">
                                                {attempt.summary}
                                            </p>
                                        ) : null}
                                        {attempt.inferredEdges.length > 0 ? (
                                            <div className="mt-2">
                                                <label className="mr-2 inline-flex items-center gap-1 text-xs">
                                                    Minimum confidence
                                                    <select
                                                        aria-label="Minimum inferred confidence"
                                                        className="border-input bg-background h-8 rounded-md border px-1"
                                                        value={
                                                            minimumConfidenceTier
                                                        }
                                                        onChange={event =>
                                                            void updatePresentation(
                                                                {
                                                                    minimumConfidenceTier:
                                                                        event
                                                                            .target
                                                                            .value as
                                                                            | 'low'
                                                                            | 'medium'
                                                                            | 'high',
                                                                },
                                                            )
                                                        }
                                                    >
                                                        <option value="low">
                                                            Low
                                                        </option>
                                                        <option value="medium">
                                                            Medium
                                                        </option>
                                                        <option value="high">
                                                            High
                                                        </option>
                                                    </select>
                                                </label>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    onClick={() => {
                                                        const next =
                                                            !showInferredEdges;
                                                        setShowInferredEdges(
                                                            next,
                                                        );
                                                        void updatePresentation(
                                                            {
                                                                showInferredEdges:
                                                                    next,
                                                            },
                                                        );
                                                    }}
                                                >
                                                    {showInferredEdges
                                                        ? 'Hide inferred relationships'
                                                        : `Show ${attempt.inferredEdges.length} inferred relationship${attempt.inferredEdges.length === 1 ? '' : 's'}`}
                                                </Button>
                                                {showInferredEdges ? (
                                                    <ul className="mt-2 space-y-2 text-sm">
                                                        {attempt.inferredEdges
                                                            .filter(
                                                                edge =>
                                                                    confidenceRank[
                                                                        edge
                                                                            .confidenceTier
                                                                    ] >=
                                                                    confidenceRank[
                                                                        minimumConfidenceTier
                                                                    ],
                                                            )
                                                            .map(edge => {
                                                                const targetId = `${edge.from}\0${edge.kind}\0${edge.to}`;
                                                                const disposition =
                                                                    edgeDisposition(
                                                                        targetId,
                                                                    );
                                                                return (
                                                                    <li
                                                                        key={
                                                                            targetId
                                                                        }
                                                                        className="rounded border p-2"
                                                                    >
                                                                        <p>
                                                                            {
                                                                                edge.from
                                                                            }{' '}
                                                                            ·{' '}
                                                                            {
                                                                                edge.kind
                                                                            }{' '}
                                                                            →{' '}
                                                                            {
                                                                                edge.to
                                                                            }{' '}
                                                                            <Badge tone="muted">
                                                                                {
                                                                                    edge.confidenceTier
                                                                                }{' '}
                                                                                {Math.round(
                                                                                    edge.confidence *
                                                                                        100,
                                                                                )}
                                                                                %
                                                                            </Badge>
                                                                            {disposition ? (
                                                                                <Badge tone="muted">
                                                                                    {disposition ===
                                                                                    'edge.confirm'
                                                                                        ? 'confirmed'
                                                                                        : 'rejected'}
                                                                                </Badge>
                                                                            ) : null}
                                                                        </p>
                                                                        <p className="text-muted-foreground mt-1 text-xs">
                                                                            {
                                                                                edge.rationale
                                                                            }
                                                                        </p>
                                                                        <p className="text-muted-foreground mt-1 text-xs">
                                                                            Evidence:{' '}
                                                                            {edge.evidenceIds.join(
                                                                                ', ',
                                                                            )}
                                                                        </p>
                                                                        {api.workspaceIntelligenceCurationActionAppend ? (
                                                                            <div className="mt-2 flex flex-wrap gap-2">
                                                                                <Button
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() =>
                                                                                        appendInferredEdgeCuration(
                                                                                            attempt,
                                                                                            edge,
                                                                                            'edge.confirm',
                                                                                        )
                                                                                    }
                                                                                >
                                                                                    Confirm
                                                                                    inferred
                                                                                    relationship
                                                                                </Button>
                                                                                <Button
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() =>
                                                                                        appendInferredEdgeCuration(
                                                                                            attempt,
                                                                                            edge,
                                                                                            'edge.reject',
                                                                                        )
                                                                                    }
                                                                                >
                                                                                    Reject
                                                                                    inferred
                                                                                    relationship
                                                                                </Button>
                                                                                <Button
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() => {
                                                                                        setEditingEdgeTarget(
                                                                                            targetId,
                                                                                        );
                                                                                        setEdgeNote(
                                                                                            '',
                                                                                        );
                                                                                    }}
                                                                                >
                                                                                    Annotate
                                                                                    inferred
                                                                                    relationship
                                                                                </Button>
                                                                            </div>
                                                                        ) : null}
                                                                        {editingEdgeTarget ===
                                                                        targetId ? (
                                                                            <div className="mt-2 grid gap-2">
                                                                                <Input
                                                                                    aria-label="Inferred relationship curation note"
                                                                                    value={
                                                                                        edgeNote
                                                                                    }
                                                                                    onChange={event =>
                                                                                        setEdgeNote(
                                                                                            event
                                                                                                .target
                                                                                                .value,
                                                                                        )
                                                                                    }
                                                                                    placeholder="Curation note"
                                                                                />
                                                                                <div className="flex gap-2">
                                                                                    <Button
                                                                                        size="sm"
                                                                                        onClick={() =>
                                                                                            appendInferredEdgeCuration(
                                                                                                attempt,
                                                                                                edge,
                                                                                                'edge.annotate',
                                                                                            )
                                                                                        }
                                                                                    >
                                                                                        Save
                                                                                        inferred
                                                                                        relationship
                                                                                        note
                                                                                    </Button>
                                                                                    <Button
                                                                                        size="sm"
                                                                                        variant="outline"
                                                                                        onClick={() =>
                                                                                            setEditingEdgeTarget(
                                                                                                undefined,
                                                                                            )
                                                                                        }
                                                                                    >
                                                                                        Cancel
                                                                                        inferred
                                                                                        relationship
                                                                                        curation
                                                                                    </Button>
                                                                                </div>
                                                                            </div>
                                                                        ) : null}
                                                                    </li>
                                                                );
                                                            })}
                                                    </ul>
                                                ) : null}
                                            </div>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                ) : null}
                {selected && api.workspaceIntelligenceGraphSearch ? (
                    <section
                        id="workspace-intelligence-search"
                        className="scroll-mt-14 rounded-lg border p-4"
                    >
                        <h2 className="text-sm font-semibold">
                            Search architecture
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Search the current run without transferring its full
                            graph to the browser.
                        </p>
                        <Input
                            className="mt-3"
                            value={query}
                            onChange={event => {
                                setQuery(event.target.value);
                                setSemanticRequestedQuery(undefined);
                            }}
                            placeholder="Component, package, module…"
                            aria-label="Search architecture"
                        />
                        {api.workspaceIntelligenceSemanticSearch ? (
                            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
                                <Checkbox
                                    checked={semanticSearch}
                                    onCheckedChange={checked => {
                                        setSemanticSearch(checked === true);
                                        setSemanticRequestedQuery(undefined);
                                    }}
                                />
                                Use semantic search
                            </label>
                        ) : null}
                        {semanticSearch &&
                        api.workspaceIntelligenceSemanticSearch ? (
                            <div className="mt-3 flex flex-wrap items-end gap-2">
                                {embeddingProfiles.length > 0 ? (
                                    <label className="flex max-w-sm flex-1 flex-col gap-1 text-xs">
                                        Embedding profile for this search
                                        <select
                                            aria-label="Semantic search profile override"
                                            className="border-input bg-background h-9 rounded-md border px-2 text-sm"
                                            value={semanticProfileId ?? ''}
                                            onChange={event => {
                                                setSemanticProfileId(
                                                    event.target.value === ''
                                                        ? undefined
                                                        : event.target.value,
                                                );
                                                setSemanticRequestedQuery(
                                                    undefined,
                                                );
                                            }}
                                        >
                                            <option value="">
                                                Workspace default
                                            </option>
                                            {embeddingProfiles.map(profile => (
                                                <option
                                                    key={profile.id}
                                                    value={profile.id}
                                                >
                                                    {profile.label} ·{' '}
                                                    {profile.modelId ??
                                                        profile.id}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                ) : null}
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={query.trim() === ''}
                                    onClick={() =>
                                        setSemanticRequestedQuery(query)
                                    }
                                >
                                    Search semantically
                                </Button>
                            </div>
                        ) : null}
                        {searchStatus ? (
                            <p className="text-muted-foreground mt-2 text-sm">
                                {searchStatus}
                            </p>
                        ) : null}
                        {query.trim() !== '' ? (
                            <div className="mt-3 divide-y rounded-md border">
                                {matches.length === 0 ? (
                                    <p className="text-muted-foreground p-3 text-sm">
                                        No matching graph nodes.
                                    </p>
                                ) : (
                                    matches.map(node => (
                                        <details key={node.id} className="p-3">
                                            <summary className="cursor-pointer text-sm">
                                                {node.label}{' '}
                                                <span className="text-muted-foreground">
                                                    · {node.kind}
                                                </span>
                                            </summary>
                                            <pre className="text-muted-foreground mt-2 overflow-auto text-xs">
                                                {JSON.stringify(
                                                    node.evidence,
                                                    null,
                                                    2,
                                                )}
                                            </pre>
                                            {api.workspaceIntelligenceGraphNeighborhood ? (
                                                <Button
                                                    className="mt-2"
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => {
                                                        setNeighborhoodNodeId(
                                                            node.id,
                                                        );
                                                        setSearchParams(
                                                            existingParams => {
                                                                const next =
                                                                    new URLSearchParams(
                                                                        existingParams,
                                                                    );
                                                                next.set(
                                                                    'node',
                                                                    node.id,
                                                                );
                                                                return next;
                                                            },
                                                        );
                                                        void updatePresentation(
                                                            {
                                                                selectedNodeId:
                                                                    node.id,
                                                                expandedNodeIds:
                                                                    [
                                                                        ...(presentationQuery
                                                                            .data
                                                                            ?.expandedNodeIds ??
                                                                            []),
                                                                        node.id,
                                                                    ],
                                                            },
                                                        );
                                                    }}
                                                >
                                                    Show connections
                                                </Button>
                                            ) : null}
                                            {(node.kind === 'component' ||
                                                overrides.some(
                                                    override =>
                                                        override.componentId ===
                                                        node.id,
                                                )) &&
                                            api.workspaceIntelligenceComponentOverridesSet ? (
                                                <Button
                                                    className="mt-2 ml-2"
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        setComponentSuppressed(
                                                            node.id,
                                                            true,
                                                        )
                                                    }
                                                >
                                                    Suppress component
                                                </Button>
                                            ) : null}
                                            {(node.kind === 'component' ||
                                                overrides.some(
                                                    override =>
                                                        override.componentId ===
                                                        node.id,
                                                )) &&
                                            api.workspaceIntelligenceComponentOverridesSet ? (
                                                <Button
                                                    className="mt-2 ml-2"
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() =>
                                                        beginComponentEdit(node)
                                                    }
                                                >
                                                    Edit component
                                                </Button>
                                            ) : null}
                                            {editingComponentId === node.id ? (
                                                <fieldset className="mt-3 grid gap-2 rounded-md border p-3">
                                                    <legend className="px-1 text-xs font-medium">
                                                        Component curation
                                                    </legend>
                                                    <Input
                                                        aria-label="Component display name"
                                                        value={
                                                            componentDisplayName
                                                        }
                                                        onChange={event =>
                                                            setComponentDisplayName(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        placeholder="Display name"
                                                    />
                                                    <Input
                                                        aria-label="Component classification"
                                                        value={componentKind}
                                                        onChange={event =>
                                                            setComponentKind(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        placeholder="Classification"
                                                    />
                                                    <Input
                                                        aria-label="Component merge group"
                                                        value={
                                                            componentMergeGroup
                                                        }
                                                        onChange={event =>
                                                            setComponentMergeGroup(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        placeholder="Merge group (optional)"
                                                    />
                                                    <p className="text-muted-foreground text-xs">
                                                        Use the same group name
                                                        on two or more
                                                        components to merge
                                                        their graph
                                                        presentation. Clear it
                                                        to split this component
                                                        out.
                                                    </p>
                                                    <textarea
                                                        aria-label="Component note"
                                                        className="border-input bg-background min-h-20 rounded-md border px-3 py-2 text-sm"
                                                        value={componentNote}
                                                        onChange={event =>
                                                            setComponentNote(
                                                                event.target
                                                                    .value,
                                                            )
                                                        }
                                                        placeholder="Curation note"
                                                    />
                                                    <div className="flex gap-2">
                                                        <Button
                                                            size="sm"
                                                            onClick={() =>
                                                                saveComponentCuration(
                                                                    node.id,
                                                                )
                                                            }
                                                        >
                                                            Save component
                                                            curation
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="outline"
                                                            onClick={() =>
                                                                setEditingComponentId(
                                                                    undefined,
                                                                )
                                                            }
                                                        >
                                                            Cancel
                                                        </Button>
                                                    </div>
                                                </fieldset>
                                            ) : null}
                                        </details>
                                    ))
                                )}
                            </div>
                        ) : null}
                    </section>
                ) : null}
                {suppressedOverrides.length > 0 &&
                api.workspaceIntelligenceComponentOverridesSet ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">
                            Suppressed components
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Suppression is workspace curation and applies to
                            matching stable component IDs in future runs.
                        </p>
                        <ul className="mt-3 divide-y rounded-md border">
                            {suppressedOverrides.map(override => (
                                <li
                                    key={override.componentId}
                                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                                >
                                    <span className="text-sm">
                                        {override.displayName ??
                                            override.componentId}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            setComponentSuppressed(
                                                override.componentId,
                                                false,
                                            )
                                        }
                                    >
                                        Restore{' '}
                                        {override.displayName ?? 'component'}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}
                {mergedOverrides.length > 0 &&
                api.workspaceIntelligenceComponentOverridesSet ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">
                            Merged component presentation
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            These workspace-only groups never change the
                            analyzed components or their evidence.
                        </p>
                        <ul className="mt-3 divide-y rounded-md border">
                            {mergedOverrides.map(override => (
                                <li
                                    key={override.componentId}
                                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                                >
                                    <span className="text-sm">
                                        {override.displayName ??
                                            override.componentId}{' '}
                                        <span className="text-muted-foreground">
                                            ·{' '}
                                            {override.mergeGroupLabel ??
                                                override.mergeGroup}
                                        </span>
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            splitComponent(override.componentId)
                                        }
                                    >
                                        Split component
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}
                {orphanedOverrides.length > 0 ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">
                            Unresolved component curation
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            These stable component IDs are not in the validated
                            current graph. Their workspace curation is retained
                            and will reapply if they resolve in a future run.
                        </p>
                        <ul className="mt-3 space-y-1 text-sm">
                            {orphanedOverrides.map(override => (
                                <li key={override.componentId}>
                                    {override.displayName ??
                                        override.componentId}
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}
                {rejectedEdgeActions.length > 0 &&
                api.workspaceIntelligenceCurationActionAppend ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">
                            Rejected relationships
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Rejected stable relationships are hidden from
                            compatible graph neighborhoods until restored.
                        </p>
                        <ul className="mt-3 divide-y rounded-md border">
                            {rejectedEdgeActions.map(action => (
                                <li
                                    key={action.targetId}
                                    className="flex flex-wrap items-center justify-between gap-2 p-3"
                                >
                                    <span className="text-sm break-all">
                                        {displayCurationTarget(action.targetId)}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            clearRejectedEdgeCuration(
                                                action.targetId,
                                            )
                                        }
                                    >
                                        Restore relationship
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null}
                {curationActions.length > 0 ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">
                            Curation history
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            Workspace-local presentation actions; immutable run
                            artifacts are unchanged.
                        </p>
                        <ul className="mt-3 space-y-1 text-sm">
                            {curationActions
                                .toReversed()
                                .slice(0, 20)
                                .map(action => (
                                    <li key={action.id} className="break-all">
                                        {action.actor} · {action.kind} ·{' '}
                                        {displayCurationTarget(action.targetId)}
                                        {typeof action.metadata === 'object' &&
                                        action.metadata !== null &&
                                        'note' in action.metadata &&
                                        typeof action.metadata.note === 'string'
                                            ? ` · ${action.metadata.note}`
                                            : ''}
                                    </li>
                                ))}
                        </ul>
                    </section>
                ) : null}
                {neighborhood ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">
                            Selected node connections
                        </h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            {neighborhood.nodes.length} nodes ·{' '}
                            {neighborhood.edges.length} edges
                        </p>
                        <WorkspaceIntelligenceGraph
                            neighborhood={neighborhood}
                            positions={presentationQuery.data?.nodePositions}
                            onPositionsChange={positions => {
                                const nextPositions = new Map(
                                    (
                                        presentationQuery.data?.nodePositions ??
                                        []
                                    ).map(position => [
                                        position.nodeId,
                                        position,
                                    ]),
                                );
                                for (const position of positions)
                                    nextPositions.set(
                                        position.nodeId,
                                        position,
                                    );
                                void updatePresentation({
                                    nodePositions: [...nextPositions.values()],
                                });
                            }}
                        />
                        <ul className="mt-3 space-y-1 text-sm">
                            {neighborhood.edges.map(edge => {
                                const targetId = curationEdgeTarget(edge);
                                return (
                                    <li
                                        key={targetId}
                                        className="rounded-md border p-2"
                                    >
                                        <span>
                                            {edge.from} · {edge.kind} →{' '}
                                            {edge.to}
                                        </span>
                                        {isCuratableEdge(edge) &&
                                        api.workspaceIntelligenceCurationActionAppend ? (
                                            <Button
                                                className="ml-2"
                                                size="sm"
                                                variant="outline"
                                                onClick={() => {
                                                    setEditingEdgeTarget(
                                                        targetId,
                                                    );
                                                    setEdgeNote('');
                                                }}
                                            >
                                                Curate relationship
                                            </Button>
                                        ) : null}
                                        {editingEdgeTarget === targetId ? (
                                            <div className="mt-2 grid gap-2">
                                                <Input
                                                    aria-label="Relationship curation note"
                                                    value={edgeNote}
                                                    onChange={event =>
                                                        setEdgeNote(
                                                            event.target.value,
                                                        )
                                                    }
                                                    placeholder="Curation note"
                                                />
                                                <div className="flex gap-2">
                                                    <Button
                                                        size="sm"
                                                        onClick={() =>
                                                            appendEdgeCuration(
                                                                edge,
                                                                'edge.annotate',
                                                            )
                                                        }
                                                    >
                                                        Save relationship note
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            appendEdgeCuration(
                                                                edge,
                                                                'edge.reject',
                                                            )
                                                        }
                                                    >
                                                        Reject relationship
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="outline"
                                                        onClick={() =>
                                                            setEditingEdgeTarget(
                                                                undefined,
                                                            )
                                                        }
                                                    >
                                                        Cancel relationship
                                                        curation
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                ) : null}
                {diff ? (
                    <section className="rounded-lg border p-4">
                        <h2 className="text-sm font-semibold">Run diff</h2>
                        <p className="text-muted-foreground mt-1 text-sm">
                            {diff.addedNodeIds.length} nodes added ·{' '}
                            {diff.removedNodeIds.length} nodes removed
                        </p>
                        <p className="text-muted-foreground mt-1 text-sm">
                            {diff.changedNodeIds?.length ?? 0} nodes changed ·{' '}
                            {diff.addedEdgeIds?.length ?? 0} edges added ·{' '}
                            {diff.removedEdgeIds?.length ?? 0} edges removed ·{' '}
                            {diff.changedEdgeIds?.length ?? 0} edges changed
                        </p>
                        <p className="text-muted-foreground mt-1 text-sm">
                            {diff.addedComponentIds?.length ?? 0} components
                            added · {diff.addedContractIds?.length ?? 0}{' '}
                            contracts added ·{' '}
                            {diff.addedChannelIds?.length ?? 0} channels added ·{' '}
                            {diff.addedFindingIds?.length ?? 0} findings added
                            {diff.isCoverageChanged
                                ? ' · coverage changed'
                                : ''}
                        </p>
                    </section>
                ) : null}
            </div>
        </div>
    );
}
