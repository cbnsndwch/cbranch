// URL-driven navigation (D13). `activeRepoId` and `selectedOid` are promoted to URL truth:
// the write side calls `navigate(...)` rather than mutating the Zustand store directly, and
// `<SyncRouteToStore>` mirrors the params back into the store so deep components that already
// subscribe to it keep working without a simultaneous refactor.

import {
    type EngagementSlug,
    type Oid,
    type RepoId,
} from '@cbranch/rpc-contract';
import { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router';

export interface Navigation {
    /** Open an engagement's cross-repository overview. */
    readonly openEngagement: (slug: EngagementSlug) => void;
    /** Open/switch the active repository → `/repos/:repoId`. */
    readonly openRepo: (id: RepoId, workspaceSlug?: EngagementSlug) => void;
    /** Select a commit in the active repository → `/repos/:repoId/commits/:oid`. */
    readonly selectOid: (oid: Oid) => void;
}

export function useNavigation(): Navigation {
    const navigate = useNavigate();
    const { workspaceSlug, repoId } = useParams<{
        workspaceSlug?: string;
        repoId?: string;
    }>();

    const openEngagement = useCallback(
        (slug: EngagementSlug) => navigate(`/w/${slug}`),
        [navigate],
    );

    const openRepo = useCallback(
        (id: RepoId, explicitWorkspaceSlug?: EngagementSlug) => {
            const scope = explicitWorkspaceSlug ?? workspaceSlug;
            navigate(scope ? `/w/${scope}/r/${id}` : `/repos/${id}`);
        },
        [navigate, workspaceSlug],
    );
    const selectOid = useCallback(
        (oid: Oid) => {
            // Commit selection is only meaningful within an open repository.
            if (!repoId) return;
            navigate(
                workspaceSlug
                    ? `/w/${workspaceSlug}/r/${repoId}/commits/${oid}`
                    : `/repos/${repoId}/commits/${oid}`,
            );
        },
        [navigate, repoId, workspaceSlug],
    );

    return { openEngagement, openRepo, selectOid };
}
