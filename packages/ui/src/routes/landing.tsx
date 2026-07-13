// "/" → redirect to the most-recently-opened repository, or fall back to the shell's
// "Open a repository" empty state (D13). `recentList` is most-recent-first.

import { Navigate } from 'react-router';

import { App } from '../App';
import { useEngagementWorkspace, useRecentList } from '../rpc/hooks';

export default function Landing() {
    const recent = useRecentList();
    const workspace = useEngagementWorkspace();
    if (recent.isLoading || workspace.isLoading) return null;
    const activeEngagement =
        workspace.data?.engagements.find(
            engagement => engagement.id === workspace.data?.activeEngagementId,
        ) ?? workspace.data?.engagements[0];
    if (activeEngagement) {
        const activeRepoId = activeEngagement.activeRepoId;
        return (
            <Navigate
                to={
                    activeRepoId
                        ? `/workspaces/${activeEngagement.id}/repos/${activeRepoId}`
                        : `/workspaces/${activeEngagement.id}`
                }
                replace
            />
        );
    }
    const last = recent.data?.[0];
    if (last) return <Navigate to={`/repos/${last.repoId}`} replace />;
    return <App />;
}
