// "/" → redirect to the most-recently-opened repository, or fall back to the shell's
// "Open a repository" empty state (D13). `recentList` is most-recent-first.

import { Navigate } from 'react-router';

import { App } from '../App';
import { useRecentList } from '../rpc/hooks';

export default function Landing() {
    const recent = useRecentList();
    if (recent.isLoading) return null;
    const last = recent.data?.[0];
    if (last) return <Navigate to={`/repos/${last.repoId}`} replace />;
    return <App />;
}
