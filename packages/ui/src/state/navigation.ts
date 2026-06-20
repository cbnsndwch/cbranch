// URL-driven navigation (D13). `activeRepoId` and `selectedOid` are promoted to URL truth:
// the write side calls `navigate(...)` rather than mutating the Zustand store directly, and
// `<SyncRouteToStore>` mirrors the params back into the store so deep components that already
// subscribe to it keep working without a simultaneous refactor.

import { type Oid, type RepoId } from "@cbranch/rpc-contract";
import { useCallback } from "react";
import { useNavigate, useParams } from "react-router";

export interface Navigation {
  /** Open/switch the active repository → `/repos/:repoId`. */
  readonly openRepo: (id: RepoId) => void;
  /** Select a commit in the active repository → `/repos/:repoId/commits/:oid`. */
  readonly selectOid: (oid: Oid) => void;
}

export function useNavigation(): Navigation {
  const navigate = useNavigate();
  const { repoId } = useParams<{ repoId: string }>();

  const openRepo = useCallback(
    (id: RepoId) => navigate(`/repos/${id}`),
    [navigate],
  );
  const selectOid = useCallback(
    (oid: Oid) => {
      // Commit selection is only meaningful within an open repository.
      if (repoId) navigate(`/repos/${repoId}/commits/${oid}`);
    },
    [navigate, repoId],
  );

  return { openRepo, selectOid };
}
