import { useParams } from 'react-router';

import { App } from '../App';
import { useEngagementWorkspace } from '../rpc/hooks';

/** Keep workspace-scoped routes from falling back to an unrelated stored workspace. */
export function WorkspaceRouteApp() {
    const { workspaceSlug, repoId } = useParams<{
        workspaceSlug?: string;
        repoId?: string;
    }>();
    const workspace = useEngagementWorkspace();

    if (!workspaceSlug) return <App />;
    if (workspace.isLoading) return null;
    const engagement = workspace.data?.engagements.find(
        item => item.slug === workspaceSlug,
    );
    if (!engagement)
        throw new Response('Workspace not found', {
            status: 404,
            statusText: 'Not Found',
        });
    if (
        repoId &&
        !engagement.repositories.some(
            repository => repository.repoId === repoId,
        )
    )
        throw new Response('Repository is not in this workspace', {
            status: 404,
            statusText: 'Not Found',
        });

    return <App />;
}

/** Workspace overview: cross-repository status without activating an individual repo. */
export default WorkspaceRouteApp;
