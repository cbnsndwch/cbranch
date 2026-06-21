// React data hooks (docs/spec/05; docs/spec/15 §2; DECISIONS D9).
//
// React Query is the SOLE feeder for synced repository data, keyed `[repoId, domain, …]`.
// Unary reads are `useQuery`; the streaming history feed is a custom hook that opens the
// `LogStream` subscription and accumulates the window. Immutable reads (commit detail/diff,
// blob at a rev) are content-addressed and effectively never go stale. All host access
// goes through the injected {@link useApi} facade so components stay mockable (NF-TEST-7).

import {
  type BlameResult,
  type BranchInfo,
  type BranchListing,
  type BranchSwitchStrategy,
  type CommitCreated,
  type CommitDetail,
  type CommitInput,
  type CommitMessage,
  CommitSummary,
  type ConflictListing,
  type ConflictResolution,
  type ConflictSides,
  type DiffFile,
  type DiffSpec,
  type FileContentResult,
  type LogQuery,
  type MergeMode,
  type MergeResult,
  type Oid,
  type PatchSelection,
  type RecentRepo,
  type RemoteInfo,
  type RepoHandle,
  type RepoId,
  type RepoState,
  type SequencerResult,
  type StashEntry,
  type TagInfo,
  type TagType,
  type WorkingTreeStatus,
  type WorktreeInfo,
} from "@cbranch/rpc-contract";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { useUiStore } from "../state/store";
import { useApi } from "./ApiProvider";
import { queryKeys } from "./query-keys";

export const useRecentList = (): UseQueryResult<ReadonlyArray<RecentRepo>> => {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.recentList(),
    queryFn: () => api.recentList(),
  });
};

export const useRepoState = (
  repoId: RepoId | null,
): UseQueryResult<RepoState> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.repoState(repoId) : ["inactive"],
    queryFn: () => api.repoState(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useCommitDetail = (
  repoId: RepoId | null,
  oid: Oid | null,
): UseQueryResult<CommitDetail> => {
  const api = useApi();
  return useQuery({
    queryKey:
      repoId && oid ? queryKeys.commitDetail(repoId, oid) : ["inactive"],
    queryFn: () => api.commitDetail(repoId as RepoId, oid as Oid),
    enabled: repoId !== null && oid !== null,
  });
};

export const useCommitDiff = (
  spec: DiffSpec | null,
): UseQueryResult<ReadonlyArray<DiffFile>> => {
  const api = useApi();
  return useQuery({
    queryKey: spec ? queryKeys.commitDiff(spec) : ["inactive"],
    queryFn: () => api.commitDiff(spec as DiffSpec),
    enabled: spec !== null,
  });
};

export const useFileContentAtRev = (
  repoId: RepoId | null,
  rev: string | null,
  path: string | null,
): UseQueryResult<FileContentResult> => {
  const api = useApi();
  return useQuery({
    queryKey:
      repoId && rev && path
        ? queryKeys.fileContentAtRev(repoId, rev, path)
        : ["inactive"],
    queryFn: () =>
      api.fileContentAtRev(repoId as RepoId, path as string, rev as string),
    enabled: repoId !== null && rev !== null && path !== null,
  });
};

/**
 * Per-line blame for a file at a revision (P4 UI-D; REQ-BL-001/006, REQ-UX-011). Immutable
 * and content-addressed by a concrete oid (the caller passes a resolved rev, never "HEAD",
 * so the result caches forever — spec 15 §8). `force` re-requests past the large-file cap
 * (REQ-EDGE-010); since it changes the response, it keys a distinct cache entry rather than
 * mutating the canonical one.
 */
export const useBlame = (
  repoId: RepoId | null,
  rev: string | null,
  path: string | null,
  force = false,
): UseQueryResult<BlameResult> => {
  const api = useApi();
  return useQuery({
    queryKey:
      repoId && rev && path
        ? force
          ? [...queryKeys.blame(repoId, rev, path), "force"]
          : queryKeys.blame(repoId, rev, path)
        : ["inactive"],
    queryFn: () =>
      api.blame(repoId as RepoId, path as string, {
        rev: rev as string,
        force,
      }),
    enabled: repoId !== null && rev !== null && path !== null,
  });
};

/** Open a repository; on success the caller activates it + refreshes the recent list. */
export const useOpenRepo = () => {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation<RepoHandle, unknown, string>({
    mutationFn: (path: string) => api.repoOpen(path),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.recentList(),
      });
    },
  });
};

export type LogStreamStatus =
  | "idle"
  | "loading"
  | "streaming"
  | "done"
  | "error";

export interface LogStreamResult {
  readonly rows: ReadonlyArray<CommitSummary>;
  readonly status: LogStreamStatus;
  readonly error: unknown;
}

/**
 * Subscribe to the streaming history feed for `query`, accumulating the window
 * (P1-HIST-3). Rows are buffered and flushed per microtask so a fast stream causes a
 * bounded number of renders. Changing the query (repo switch or any filter, P1-FILT-8)
 * cancels the superseded subscription and restarts from the top of the new result set.
 */
export const useLogStream = (query: LogQuery | null): LogStreamResult => {
  const api = useApi();
  const [rows, setRows] = useState<ReadonlyArray<CommitSummary>>([]);
  const [status, setStatus] = useState<LogStreamStatus>("idle");
  const [error, setError] = useState<unknown>(null);
  const optimisticCommits = useUiStore((s) => s.optimisticCommits);
  const confirmOptimisticCommits = useUiStore(
    (s) => s.confirmOptimisticCommits,
  );
  // A monotonic id for the live subscription run. `api.logStream`'s unsubscribe interrupts
  // the Effect fiber asynchronously (fire-and-forget), so a superseded run's fiber can emit
  // one more item, and a microtask flush queued before the restart can still fire — both
  // would clobber the new run's rows. Every callback checks it is still the current run.
  const runIdRef = useRef(0);
  // Restart only when a meaningful query field changes, not on every render's new object.
  const queryKey = query === null ? null : JSON.stringify(query);

  // A repo/filter change re-scopes the log, so optimistic rows from the old scope no
  // longer belong; drop them. A fresh commit keeps `queryKey` stable (only `refreshToken`
  // below changes), so the optimistic row survives the post-commit restart until the
  // re-snapshotted history confirms it.
  useEffect(() => {
    useUiStore.getState().clearOptimisticCommits();
  }, [queryKey]);

  // This is a stream, not a TanStack query, so `commits`-domain invalidations (from the
  // commit/merge/pull mutations AND the WS invalidation bus) don't reach it on their own.
  // Bridge them in: a sentinel query under the log key (`queryKeys.log` lives in the
  // `commits` domain) refetches whenever that domain is invalidated, bumping
  // `dataUpdatedAt`; restarting the subscription on that value re-snapshots the history.
  const refreshToken = useQuery({
    queryKey: query ? queryKeys.log(query) : ["inactive", "log"],
    queryFn: () => null,
    enabled: query !== null,
    // Seeded + never-stale, so it does NOT fetch on mount (which would double-subscribe
    // the stream); only an explicit `commits`-domain invalidation refetches it.
    initialData: null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    gcTime: 0,
  }).dataUpdatedAt;

  useEffect(() => {
    // Supersede any prior run up front (even on the null transition) so a just-interrupted
    // fiber's late item or a flush queued before this run can no longer touch state.
    const myRun = ++runIdRef.current;
    const isCurrent = () => runIdRef.current === myRun;
    if (query === null) {
      setRows([]);
      setStatus("idle");
      setError(null);
      return;
    }
    setRows([]);
    setStatus("loading");
    setError(null);

    const buffer: CommitSummary[] = [];
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      if (isCurrent()) setRows(buffer.slice());
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    };

    const unsubscribe = api.logStream(query, {
      onItem: (row) => {
        if (!isCurrent()) return;
        buffer.push(row);
        setStatus("streaming");
        schedule();
      },
      onComplete: () => {
        if (!isCurrent()) return;
        flush();
        setStatus("done");
      },
      onError: (e) => {
        if (!isCurrent()) return;
        setError(e);
        setStatus("error");
      },
    });
    return unsubscribe;
    // `queryKey` captures the meaningful query fields; `query` is intentionally read inside.
    // `refreshToken` restarts the stream when the `commits` domain is invalidated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, queryKey, refreshToken]);

  // Drop optimistic rows the streamed history now contains (the real commit has arrived).
  useEffect(() => {
    if (optimisticCommits.length === 0) return;
    const confirmed = optimisticCommits
      .filter((c) => rows.some((r) => r.oid === c.oid))
      .map((c) => c.oid);
    if (confirmed.length > 0) confirmOptimisticCommits(confirmed);
  }, [rows, optimisticCommits, confirmOptimisticCommits]);

  // Prepend not-yet-streamed optimistic commits so a fresh commit appears at the top
  // immediately. A synthesized row has no author (the client doesn't know the configured
  // identity), so borrow it from the current top row — the same person, in practice — for
  // the moment before the real row replaces it.
  const merged = useMemo<ReadonlyArray<CommitSummary>>(() => {
    const streamed = new Set(rows.map((r) => r.oid));
    const top = rows[0];
    const pending = optimisticCommits
      .filter((c) => !streamed.has(c.oid))
      .map((c) =>
        c.authorName === "" && top
          ? new CommitSummary({
              oid: c.oid,
              parents: c.parents,
              authorName: top.authorName,
              authorEmail: top.authorEmail,
              authorDate: c.authorDate,
              committerDate: c.committerDate,
              subject: c.subject,
              refs: c.refs,
            })
          : c,
      );
    const combined = pending.length === 0 ? rows : [...pending, ...rows];
    // A commit must appear at most once: the list renders with `key={row.oid}`, and a
    // duplicate oid would break React's reconciliation. The producers above provably can't
    // emit one (git log dedups its walk; `pending` is oid-unique and disjoint from `rows`
    // since `streamed` is derived from the same `rows` we spread), so this only guards an
    // upstream re-delivery — a single subscription replaying an oid across a transport
    // reconnect. Keep the original array reference when already unique to avoid re-renders.
    const seen = new Set<string>();
    const unique: CommitSummary[] = [];
    for (const r of combined) {
      if (seen.has(r.oid)) continue;
      seen.add(r.oid);
      unique.push(r);
    }
    return unique.length === combined.length ? combined : unique;
  }, [rows, optimisticCommits]);

  return { rows: merged, status, error };
};

// ── P2 query hooks ────────────────────────────────────────────────────────────

export const useStatus = (
  repoId: RepoId | null,
): UseQueryResult<WorkingTreeStatus> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.status(repoId) : ["inactive"],
    queryFn: () => api.statusGet(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useWorkingDiff = (
  repoId: RepoId | null,
  path: string | null,
  staged: boolean,
): UseQueryResult<DiffFile> => {
  const api = useApi();
  return useQuery({
    queryKey:
      repoId && path
        ? queryKeys.workingDiff(repoId, path, staged)
        : ["inactive"],
    queryFn: () =>
      api.workingFileDiff(repoId as RepoId, path as string, staged),
    enabled: repoId !== null && path !== null,
  });
};

export const useLastMessage = (
  repoId: RepoId | null,
): UseQueryResult<CommitMessage> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.lastMessage(repoId) : ["inactive"],
    queryFn: () => api.commitLastMessage(repoId as RepoId),
    enabled: repoId !== null,
  });
};

// ── P2 mutation hooks ─────────────────────────────────────────────────────────

export const useStageFiles = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { paths: ReadonlyArray<string>; all?: boolean }
  >({
    mutationFn: ({ paths, all }) => api.stageFiles(repoId, paths, all),
    onMutate: async ({ paths, all }) => {
      await qc.cancelQueries({ queryKey: queryKeys.status(repoId) });
      const prev = qc.getQueryData<WorkingTreeStatus>(queryKeys.status(repoId));
      if (prev && !all) {
        const pathSet = new Set(paths);
        qc.setQueryData(queryKeys.status(repoId), {
          ...prev,
          entries: prev.entries.map((e) =>
            pathSet.has(e.path) ? { ...e, staged: e.unstaged } : e,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      const c = ctx as { prev?: WorkingTreeStatus } | undefined;
      if (c?.prev) qc.setQueryData(queryKeys.status(repoId), c.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useUnstageFiles = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { paths: ReadonlyArray<string>; all?: boolean }
  >({
    mutationFn: ({ paths, all }) => api.unstageFiles(repoId, paths, all),
    onMutate: async ({ paths, all }) => {
      await qc.cancelQueries({ queryKey: queryKeys.status(repoId) });
      const prev = qc.getQueryData<WorkingTreeStatus>(queryKeys.status(repoId));
      if (prev && !all) {
        const pathSet = new Set(paths);
        qc.setQueryData(queryKeys.status(repoId), {
          ...prev,
          entries: prev.entries.map((e) =>
            pathSet.has(e.path) ? { ...e, staged: "unmodified" } : e,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      const c = ctx as { prev?: WorkingTreeStatus } | undefined;
      if (c?.prev) qc.setQueryData(queryKeys.status(repoId), c.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useDiscardFiles = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { paths: ReadonlyArray<string> }>({
    mutationFn: ({ paths }) => api.discardFiles(repoId, paths),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useDeleteUntracked = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { paths: ReadonlyArray<string> }>({
    mutationFn: ({ paths }) => api.deleteUntracked(repoId, paths),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useResetTo = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { mode: "soft" | "mixed" | "hard"; target: string }
  >({
    mutationFn: ({ mode, target }) => api.resetTo(repoId, mode, target),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
      void qc.invalidateQueries({ queryKey: [repoId, "commits"] });
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
    },
  });
};

export const useStageHunks = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, PatchSelection>({
    mutationFn: (selection) => api.stageHunks(selection),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useUnstageHunks = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, PatchSelection>({
    mutationFn: (selection) => api.unstageHunks(selection),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useDiscardHunks = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, PatchSelection>({
    mutationFn: (selection) => api.discardHunks(selection),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useCommitCreate = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  const addOptimisticCommit = useUiStore((s) => s.addOptimisticCommit);
  const clearOptimisticCommits = useUiStore((s) => s.clearOptimisticCommits);
  return useMutation<CommitCreated, unknown, CommitInput>({
    mutationFn: (input) => api.commitCreate(input),
    // Optimistically clear the just-committed (staged) changes so the dialog's changes
    // list empties immediately instead of after the status refetch round-trip. A commit
    // moves the staged portion into the new commit: reset every entry's `staged` to
    // unmodified, then drop entries that become fully clean (keeping ones that still
    // have unstaged edits, are untracked, or are conflicted). Reconciled in onSettled;
    // rolled back in onError. Same shape as stage/unstage (the value is a transient
    // plain object, not a WorkingTreeStatus instance).
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: queryKeys.status(repoId) });
      const prev = qc.getQueryData<WorkingTreeStatus>(queryKeys.status(repoId));
      // Capture HEAD before the commit moves it — it becomes the new commit's parent,
      // letting the optimistic graph row connect to the right lane (read pre-invalidation).
      const prevHead = qc.getQueryData<RepoState>(
        queryKeys.repoState(repoId),
      )?.headOid;
      if (prev) {
        const entries = prev.entries
          .map((e) =>
            e.staged === "unmodified" ? e : { ...e, staged: "unmodified" },
          )
          .filter(
            (e) =>
              e.unstaged !== "unmodified" || e.isUntracked || e.isConflicted,
          );
        qc.setQueryData(queryKeys.status(repoId), { ...prev, entries });
      }
      return { prev, prevHead };
    },
    onError: (_err, _vars, ctx) => {
      const c = ctx as { prev?: WorkingTreeStatus } | undefined;
      if (c?.prev) qc.setQueryData(queryKeys.status(repoId), c.prev);
    },
    onSuccess: (created, variables, ctx) => {
      // Amend rewrites HEAD in place rather than adding a row, so there is nothing to
      // prepend — the stream restart updates the existing top row. Only a real new commit
      // gets an optimistic row, shown until the re-snapshotted history confirms it.
      //
      // An amend also rewrites the oid (HEAD → HEAD'), so any optimistic row still pending
      // from a just-made commit can never be confirmed (the stream now shows HEAD', not the
      // old oid) and would linger as a phantom row. Clear it; the post-amend stream restart
      // re-snapshots the real history, so nothing real is lost.
      if (variables.amend) {
        clearOptimisticCommits();
        return;
      }
      const prevHead = (ctx as { prevHead?: Oid } | undefined)?.prevHead;
      const now = new Date().toISOString();
      addOptimisticCommit(
        new CommitSummary({
          oid: created.oid,
          parents: prevHead ? [prevHead] : [],
          authorName: variables.authorOverride?.name ?? "",
          authorEmail: variables.authorOverride?.email ?? "",
          authorDate: now,
          committerDate: now,
          subject: created.subject,
          refs: [],
        }),
      );
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
      void qc.invalidateQueries({ queryKey: [repoId, "commits"] });
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
      // Refresh the reuse/amend message seed (HEAD's message just changed).
      void qc.invalidateQueries({
        queryKey: [repoId, "commit", "lastMessage"],
      });
    },
  });
};

// ── P3 query hooks ────────────────────────────────────────────────────────────

export const useBranchList = (
  repoId: RepoId | null,
): UseQueryResult<BranchListing> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.branches(repoId) : ["inactive"],
    queryFn: () => api.branchList(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useRemoteList = (
  repoId: RepoId | null,
): UseQueryResult<ReadonlyArray<RemoteInfo>> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.remotes(repoId) : ["inactive"],
    queryFn: () => api.remoteList(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useWorktreeList = (
  repoId: RepoId | null,
): UseQueryResult<ReadonlyArray<WorktreeInfo>> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.worktrees(repoId) : ["inactive"],
    queryFn: () => api.worktreeList(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useStashList = (
  repoId: RepoId | null,
): UseQueryResult<ReadonlyArray<StashEntry>> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.stash(repoId) : ["inactive"],
    queryFn: () => api.stashList(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useStashShow = (
  repoId: RepoId | null,
  ref: string | null,
): UseQueryResult<ReadonlyArray<DiffFile>> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId && ref ? queryKeys.stashShow(repoId, ref) : ["inactive"],
    queryFn: () => api.stashShow(repoId as RepoId, ref as string),
    enabled: repoId !== null && ref !== null,
  });
};

export const useTagList = (
  repoId: RepoId | null,
): UseQueryResult<ReadonlyArray<TagInfo>> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.tags(repoId) : ["inactive"],
    queryFn: () => api.tagList(repoId as RepoId),
    enabled: repoId !== null,
  });
};

// ── P3 branch mutation hooks ──────────────────────────────────────────────────

export const useBranchCreate = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    BranchInfo,
    unknown,
    {
      name: string;
      startPoint?: string;
      setUpstream?: boolean;
      switchAfter?: boolean;
    }
  >({
    mutationFn: ({ name, startPoint, setUpstream, switchAfter }) =>
      api.branchCreate(repoId, name, startPoint, setUpstream, switchAfter),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useBranchSwitch = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    {
      target: string;
      strategy?: BranchSwitchStrategy;
      stashAndReapply?: boolean;
    }
  >({
    mutationFn: ({ target, strategy, stashAndReapply }) =>
      api.branchSwitch(repoId, target, strategy, stashAndReapply),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
    },
  });
};

export const useBranchCheckoutDetached = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { ref: string }>({
    mutationFn: ({ ref }) => api.branchCheckoutDetached(repoId, ref),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
    },
  });
};

export const useBranchRename = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { oldName: string; newName: string }>({
    mutationFn: ({ oldName, newName }) =>
      api.branchRename(repoId, oldName, newName),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

export const useBranchDelete = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { name: string; force: boolean }>({
    mutationFn: ({ name, force }) => api.branchDelete(repoId, name, force),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

export const useBranchSetUpstream = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { name: string; upstream?: string }>({
    mutationFn: ({ name, upstream }) =>
      api.branchSetUpstream(repoId, name, upstream),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

export const useMergeCreate = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    MergeResult,
    unknown,
    { ref: string; strategy: MergeMode; message?: string }
  >({
    mutationFn: ({ ref, strategy, message }) =>
      api.mergeCreate(repoId, ref, strategy, message),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
      void qc.invalidateQueries({ queryKey: [repoId, "commits"] });
    },
  });
};

export const useMergeAbort = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: () => api.mergeAbort(repoId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

/** Delete a branch (or tag) on the remote via a delete-push (UI-002). */
export const usePushDeleteRemoteRef = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { remote: string; ref: string; refType: "branch" | "tag" }
  >({
    mutationFn: ({ remote, ref, refType }) =>
      api.pushDeleteRemoteRef(repoId, remote, ref, refType),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

// ── P3 remote mutation hooks ──────────────────────────────────────────────────

export const useRemoteAdd = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { name: string; url: string }>({
    mutationFn: ({ name, url }) => api.remoteAdd(repoId, name, url),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "config"] });
    },
  });
};

export const useRemoteSetUrl = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { name: string; url: string; push?: boolean }
  >({
    mutationFn: ({ name, url, push }) =>
      api.remoteSetUrl(repoId, name, url, push),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "config"] });
    },
  });
};

export const useRemoteRename = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { oldName: string; newName: string }>({
    mutationFn: ({ oldName, newName }) =>
      api.remoteRename(repoId, oldName, newName),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "config"] });
    },
  });
};

export const useRemoteRemove = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { name: string }>({
    mutationFn: ({ name }) => api.remoteRemove(repoId, name),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "config"] });
    },
  });
};

// ── P3 worktree mutation hooks ────────────────────────────────────────────────

export const useWorktreeAdd = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    WorktreeInfo,
    unknown,
    {
      path: string;
      branch?: string;
      newBranch?: string;
      startPoint?: string;
      force?: boolean;
    }
  >({
    mutationFn: ({ path, branch, newBranch, startPoint, force }) =>
      api.worktreeAdd(repoId, path, { branch, newBranch, startPoint, force }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "worktrees"] });
    },
  });
};

export const useWorktreeRemove = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { path: string; force?: boolean }>({
    mutationFn: ({ path, force }) => api.worktreeRemove(repoId, path, force),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "worktrees"] });
    },
  });
};

export const useWorktreePrune = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: () => api.worktreePrune(repoId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "worktrees"] });
    },
  });
};

export const useWorktreeSwitch = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { path: string }>({
    mutationFn: ({ path }) => api.worktreeSwitch(repoId, path),
    // The active working tree changed for this repoId — every view (branches,
    // status, log, refs…) must refetch against the new worktree.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId] });
    },
  });
};

// ── P3 stash mutation hooks ───────────────────────────────────────────────────

export const useStashPush = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    StashEntry,
    unknown,
    {
      message?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
      stagedOnly?: boolean;
    }
  >({
    mutationFn: (opts) => api.stashPush(repoId, opts),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "stash"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useStashApply = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { ref: string }>({
    mutationFn: ({ ref }) => api.stashApply(repoId, ref),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "stash"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useStashPop = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { ref: string }>({
    mutationFn: ({ ref }) => api.stashPop(repoId, ref),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "stash"] });
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useStashDrop = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { ref: string }>({
    mutationFn: ({ ref }) => api.stashDrop(repoId, ref),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "stash"] });
    },
  });
};

export const useStashClear = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: () => api.stashClear(repoId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "stash"] });
    },
  });
};

// ── P3 tag mutation hooks ─────────────────────────────────────────────────────

export const useTagCreate = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    TagInfo,
    unknown,
    {
      name: string;
      target?: string;
      tagType: TagType;
      message?: string;
      force?: boolean;
    }
  >({
    mutationFn: ({ name, target, tagType, message, force }) =>
      api.tagCreate(repoId, name, { target, tagType, message, force }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "tags"] });
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

export const useTagDelete = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { name: string }>({
    mutationFn: ({ name }) => api.tagDelete(repoId, name),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "tags"] });
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

export const useTagPush = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { remote: string; name?: string; all?: boolean }
  >({
    mutationFn: ({ remote, name, all }) =>
      api.tagPush(repoId, remote, { name, all }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

export const useTagDeleteRemote = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { remote: string; name: string }>({
    mutationFn: ({ remote, name }) => api.tagDeleteRemote(repoId, remote, name),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
    },
  });
};

// ── P4 conflict + sequencer hooks ─────────────────────────────────────────────

export const useConflictList = (
  repoId: RepoId | null,
): UseQueryResult<ConflictListing> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.conflicts(repoId) : ["inactive"],
    queryFn: () => api.conflictList(repoId as RepoId),
    enabled: repoId !== null,
  });
};

/**
 * One conflicted path's three sides + the working-tree merged seed (REQ-MERGE-011).
 * Domain `status`: the stages vanish from the index on resolve, so a conflict mutation
 * invalidates `[repoId,"status"]` and this refetches.
 */
export const useConflictSides = (
  repoId: RepoId,
  path: string,
): UseQueryResult<ConflictSides> => {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.conflictSides(repoId, path),
    queryFn: () => api.conflictSides(repoId, path),
  });
};

export const useConflictResolve = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { paths: ReadonlyArray<string>; resolution: ConflictResolution }
  >({
    mutationFn: ({ paths, resolution }) =>
      api.conflictResolve(repoId, paths, resolution),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useConflictMarkResolved = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { paths: ReadonlyArray<string> }>({
    mutationFn: ({ paths }) => api.conflictMarkResolved(repoId, paths),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useConflictMarkUnresolved = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, { paths: ReadonlyArray<string> }>({
    mutationFn: ({ paths }) => api.conflictMarkUnresolved(repoId, paths),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

export const useConflictSaveMerged = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    void,
    unknown,
    { path: string; content: string; encoding: "utf8" | "base64" }
  >({
    mutationFn: ({ path, content, encoding }) =>
      api.conflictSaveMerged(repoId, path, content, encoding),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
    },
  });
};

/** A continue/abort/skip moves HEAD + the sequencer state — invalidate broadly. */
const invalidateOperation = (
  qc: ReturnType<typeof useQueryClient>,
  repoId: RepoId,
) => {
  void qc.invalidateQueries({ queryKey: [repoId, "status"] });
  void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
  void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
  void qc.invalidateQueries({ queryKey: [repoId, "commits"] });
};

export const useOpContinue = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    SequencerResult,
    unknown,
    { message?: string; allowEmpty?: boolean }
  >({
    mutationFn: (opts) => api.opContinue(repoId, opts),
    onSettled: () => invalidateOperation(qc, repoId),
  });
};

export const useOpAbort = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, unknown, void>({
    mutationFn: () => api.opAbort(repoId),
    onSettled: () => invalidateOperation(qc, repoId),
  });
};

export const useOpSkip = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<SequencerResult, unknown, void>({
    mutationFn: () => api.opSkip(repoId),
    onSettled: () => invalidateOperation(qc, repoId),
  });
};

/** Cherry-pick one or more commits (oldest→newest); the result is an outcome (D17). */
export const useCherryPick = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    SequencerResult,
    unknown,
    {
      commits: ReadonlyArray<Oid>;
      recordOrigin?: boolean;
      mainline?: number;
      noCommit?: boolean;
    }
  >({
    mutationFn: ({ commits, recordOrigin, mainline, noCommit }) =>
      api.cherryPick(repoId, commits, { recordOrigin, mainline, noCommit }),
    onSettled: () => invalidateOperation(qc, repoId),
  });
};

/** Revert one or more commits; a single-commit revert may carry a custom message. */
export const useRevert = (repoId: RepoId) => {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    SequencerResult,
    unknown,
    {
      commits: ReadonlyArray<Oid>;
      mainline?: number;
      noCommit?: boolean;
      message?: string;
    }
  >({
    mutationFn: ({ commits, mainline, noCommit, message }) =>
      api.revert(repoId, commits, { mainline, noCommit, message }),
    onSettled: () => invalidateOperation(qc, repoId),
  });
};
