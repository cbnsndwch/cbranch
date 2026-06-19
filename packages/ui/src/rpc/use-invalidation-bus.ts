// WebSocket invalidation bus wiring (docs/spec/15 §1/§2/§5; NF-ERR-6).
//
// One `repo.subscribe` stream per open repo. The host pushes which DOMAINS changed; the
// client invalidates the matching `[repoId, domain]` queries and React Query refetches
// (never row-level deltas — spec 15 §1). On a dropped/ended stream the client
// re-subscribes after a short backoff AND invalidates the whole `[repoId]` subtree — a
// full resnapshot via refetch (spec 15 §5 / NF-ERR-6), since state is re-derivable.

import { type RepoId } from "@cbranch/rpc-contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useApi } from "./ApiProvider";
import { domainKey, repoScopeKey } from "./query-keys";

const RECONNECT_DELAY_MS = 1500;

export const useInvalidationBus = (repoId: RepoId | null): void => {
  const api = useApi();
  const queryClient = useQueryClient();
  // Bumping `generation` re-runs the effect → re-subscribes after a drop (reconnect).
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (repoId === null) return;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReconnect = () => {
      reconnectTimer = setTimeout(() => setGeneration((g) => g + 1), RECONNECT_DELAY_MS);
    };

    const unsubscribe = api.subscribe(repoId, {
      onItem: (event) => {
        for (const domain of event.domains) {
          void queryClient.invalidateQueries({ queryKey: domainKey(event.repoId, domain) });
        }
      },
      onError: () => {
        // Reconnect resnapshot (NF-ERR-6): refetch everything mounted for the repo.
        void queryClient.invalidateQueries({ queryKey: repoScopeKey(repoId) });
        scheduleReconnect();
      },
      onComplete: () => {
        scheduleReconnect();
      },
    });

    return () => {
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      unsubscribe();
    };
  }, [api, queryClient, repoId, generation]);
};
