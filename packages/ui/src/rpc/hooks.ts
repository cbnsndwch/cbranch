// React data hooks (docs/spec/05; docs/spec/15 §2; DECISIONS D9).
//
// React Query is the SOLE feeder for synced repository data, keyed `[repoId, domain, …]`.
// Unary reads are `useQuery`; the streaming history feed is a custom hook that opens the
// `LogStream` subscription and accumulates the window. Immutable reads (commit detail/diff,
// blob at a rev) are content-addressed and effectively never go stale. All host access
// goes through the injected {@link useApi} facade so components stay mockable (NF-TEST-7).

import {
  type CommitDetail,
  type CommitSummary,
  type DiffFile,
  DiffSpec,
  type FileContentResult,
  LogQuery,
  type Oid,
  type RecentRepo,
  type RepoHandle,
  type RepoId,
  type RepoState,
} from "@cbranch/rpc-contract";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "./ApiProvider";
import { queryKeys } from "./query-keys";

/** Default commit-vs-first-parent diff request for the selected commit (P1-HIST-5). */
export const defaultDiffSpec = (repoId: RepoId, target: string): DiffSpec =>
  new DiffSpec({
    repoId,
    target,
    cached: false,
    whitespace: "show",
    context: 3,
    renames: true,
    combined: false,
  });

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

export const useCommitDiff = (repoId: RepoId | null, oid: Oid | null): UseQueryResult<ReadonlyArray<DiffFile>> => {
  const api = useApi();
  return useQuery({
    queryKey: repoId && oid ? queryKeys.commitDiff(repoId, oid) : ["inactive"],
    queryFn: () => api.commitDiff(defaultDiffSpec(repoId as RepoId, oid as Oid)),
    enabled: repoId !== null && oid !== null,
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
