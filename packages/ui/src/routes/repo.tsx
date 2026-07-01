// Repository browse view, reused for both `/repos/:repoId` and
// `/repos/:repoId/commits/:oid` (see routes.ts). `App` reads the matched params via the
// store bridge (SyncRouteToStore), so the same component serves both paths.

import { App } from '../App';

export default function Repo() {
    return <App />;
}
