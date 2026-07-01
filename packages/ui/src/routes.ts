// Route table (React Router 8 framework mode). The shape mirrors the old
// `createBrowserRouter` array from `router.tsx`: `root.tsx` is the implicit layout route
// (providers + URL→store bridge), and these are its children. The repo browse view is
// served by a single module reused for the bare-repo and commit-deeplink paths (distinct
// `id`s); the future surfaces keep their URL namespace reserved via placeholder modules.

import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
    index('routes/landing.tsx'),
    route('repos/:repoId', 'routes/repo.tsx'),
    route('repos/:repoId/commits/:oid', 'routes/repo.tsx', {
        id: 'repo-commit',
    }),
    // Future surfaces — URL namespace reserved now, UI to follow (D13).
    route('repos/:repoId/branches/:name', 'routes/branch.tsx'),
    route('repos/:repoId/tags/:name', 'routes/tag.tsx'),
    route('repos/:repoId/worktrees/:id', 'routes/worktree.tsx'),
    route('repos/:repoId/stash/:index', 'routes/stash.tsx'),
    route('repos/:repoId/blame/:rev/*', 'routes/blame.tsx'),
] satisfies RouteConfig;
