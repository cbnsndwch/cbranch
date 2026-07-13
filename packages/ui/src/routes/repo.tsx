// Repository browse view, reused for bare and workspace-scoped paths (see routes.ts).
// `App` reads the matched params via the store bridge (SyncRouteToStore), while the route
// guard prevents a workspace URL from borrowing another workspace's repository state.

import { WorkspaceRouteApp } from './engagement';

export default function Repo() {
    return <WorkspaceRouteApp />;
}
