// URL-driven navigation (D13). `activeRepoId` and `selectedOid` are promoted to URL truth:
// the write side calls `navigate(...)` rather than mutating the Zustand store directly, and
// `<SyncRouteToStore>` mirrors the params back into the store so deep components that already
// subscribe to it keep working without a simultaneous refactor.

import {
    type EngagementId,
    type Oid,
    type RepoId,
} from '@cbranch/rpc-contract';
import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';

export interface Navigation {
    /** Open an engagement's cross-repository overview. */
    readonly openEngagement: (id: EngagementId) => void;
    /** Open/switch the active repository → `/repos/:repoId`. */
    readonly openRepo: (id: RepoId, engagementId?: EngagementId) => void;
    /** Select a commit in the active repository → `/repos/:repoId/commits/:oid`. */
    readonly selectOid: (oid: Oid) => void;
}

export function useNavigation(): Navigation {
    const navigate = useNavigate();
    const { engagementId, repoId } = useParams<{
        engagementId?: string;
        repoId?: string;
    }>();

    const openEngagement = useCallback(
        (id: EngagementId) => navigate(`/engagements/${id}`),
        [navigate],
    );

    const openRepo = useCallback(
        (id: RepoId, explicitEngagementId?: EngagementId) => {
            const scope = explicitEngagementId ?? engagementId;
            navigate(
                scope ? `/engagements/${scope}/repos/${id}` : `/repos/${id}`,
            );
        },
        [engagementId, navigate],
    );
    const selectOid = useCallback(
        (oid: Oid) => {
            // Commit selection is only meaningful within an open repository.
            if (!repoId) return;
            navigate(
                engagementId
                    ? `/engagements/${engagementId}/repos/${repoId}/commits/${oid}`
                    : `/repos/${repoId}/commits/${oid}`,
            );
        },
        [engagementId, navigate, repoId],
    );

    return { openEngagement, openRepo, selectOid };
}
