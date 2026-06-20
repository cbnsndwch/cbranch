// React data hooks (docs/spec/05; docs/spec/15 §2; DECISIONS D9).
//
// React Query is the SOLE feeder for synced repository data, keyed `[repoId, domain, …]`.
// Unary reads are `useQuery`; the streaming history feed is a custom hook that opens the
// `LogStream` subscription and accumulates the window. Immutable reads (commit detail/diff,
// blob at a rev) are content-addressed and effectively never go stale. All host access
// goes through the injected {@link useApi} facade so components stay mockable (NF-TEST-7).

import {
  type CommitCreated,
  type CommitDetail,
  type CommitInput,
  type CommitMessage,
  type CommitSummary,
  type DiffFile,
  type DiffSpec,
  type FileContentResult,
  type LogQuery,
  type Oid,
  type PatchSelection,
  type RecentRepo,
  type RepoHandle,
  type RepoId,
  type RepoState,
  type WorkingTreeStatus,
} from "@cbranch/rpc-contract";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "./ApiProvider";
import { queryKeys } from "./query-keys";

export const useRecentList = (): UseQueryResult<ReadonlyArray<RecentRepo>> => {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.recentList(), queryFn: () => api.recentList() });
};

export const useRepoState = (repoId: RepoId | null): UseQueryResult<RepoState> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId ? queryKeys.repoState(repoId) : ["inactive"],
    queryFn: () => api.repoState(repoId as RepoId),
    enabled: repoId !== null,
  });
};

export const useCommitDetail = (repoId: RepoId | null, oid: Oid | null): UseQueryResult<CommitDetail> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId && oid ? queryKeys.commitDetail(repoId, oid) : ["inactive"],
    queryFn: () => api.commitDetail(repoId as RepoId, oid as Oid),
    enabled: repoId !== null && oid !== null,
  });
};

export const useCommitDiff = (spec: DiffSpec | null): UseQueryResult<ReadonlyArray<DiffFile>> => {
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
    queryKey: repoId && rev && path ? queryKeys.fileContentAtRev(repoId, rev, path) : ["inactive"],
    queryFn: () => api.fileContentAtRev(repoId as RepoId, path as string, rev as string),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.recentList() });
    },
  });
};

export type LogStreamStatus = "idle" | "loading" | "streaming" | "done" | "error";

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
  // Restart only when a meaningful query field changes, not on every render's new object.
  const queryKey = query === null ? null : JSON.stringify(query);

  useEffect(() => {
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
      setRows(buffer.slice());
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    };

    const unsubscribe = api.logStream(query, {
      onItem: (row) => {
        buffer.push(row);
        setStatus("streaming");
        schedule();
      },
      onComplete: () => {
        flush();
        setStatus("done");
      },
      onError: (e) => {
        setError(e);
        setStatus("error");
      },
    });
    return unsubscribe;
    // `queryKey` captures the meaningful query fields; `query` is intentionally read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, queryKey]);

  return { rows, status, error };
};

// ── P2 query hooks ────────────────────────────────────────────────────────────

export const useStatus = (repoId: RepoId | null): UseQueryResult<WorkingTreeStatus> => {
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
    queryKey: repoId && path ? queryKeys.workingDiff(repoId, path, staged) : ["inactive"],
    queryFn: () => api.workingFileDiff(repoId as RepoId, path as string, staged),
    enabled: repoId !== null && path !== null,
  });
};

export const useLastMessage = (repoId: RepoId | null): UseQueryResult<CommitMessage> => {
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
  return useMutation<void, unknown, { paths: ReadonlyArray<string>; all?: boolean }>({
    mutationFn: ({ paths, all }) => api.stageFiles(repoId, paths, all),
    onMutate: async ({ paths, all }) => {
      await qc.cancelQueries({ queryKey: queryKeys.status(repoId) });
      const prev = qc.getQueryData<WorkingTreeStatus>(queryKeys.status(repoId));
      if (prev && !all) {
        const pathSet = new Set(paths);
        qc.setQueryData(queryKeys.status(repoId), {
          ...prev,
          entries: prev.entries.map((e) => (pathSet.has(e.path) ? { ...e, staged: e.unstaged } : e)),
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
  return useMutation<void, unknown, { paths: ReadonlyArray<string>; all?: boolean }>({
    mutationFn: ({ paths, all }) => api.unstageFiles(repoId, paths, all),
    onMutate: async ({ paths, all }) => {
      await qc.cancelQueries({ queryKey: queryKeys.status(repoId) });
      const prev = qc.getQueryData<WorkingTreeStatus>(queryKeys.status(repoId));
      if (prev && !all) {
        const pathSet = new Set(paths);
        qc.setQueryData(queryKeys.status(repoId), {
          ...prev,
          entries: prev.entries.map((e) => (pathSet.has(e.path) ? { ...e, staged: "unmodified" } : e)),
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
  return useMutation<void, unknown, { mode: "soft" | "mixed" | "hard"; target: string }>({
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
  return useMutation<CommitCreated, unknown, CommitInput>({
    mutationFn: (input) => api.commitCreate(input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [repoId, "status"] });
      void qc.invalidateQueries({ queryKey: [repoId, "commits"] });
      void qc.invalidateQueries({ queryKey: [repoId, "refs"] });
      void qc.invalidateQueries({ queryKey: [repoId, "inProgress"] });
    },
  });
};
