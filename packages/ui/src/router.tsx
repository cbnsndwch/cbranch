// Standalone web-app router (D13). `createBrowserRouter` drives the URL surface; the VS Code
// WebView entry point will instead use `MemoryRouter` (deferred to the extension milestone),
// resolving the same route components — only the history implementation differs.

import { createBrowserRouter, Navigate, Outlet } from "react-router";

import { App } from "./App";
import { useRecentList } from "./rpc/hooks";
import { SyncRouteToStore } from "./state/SyncRouteToStore";

// A full-window "coming soon" page for navigation surfaces whose URL namespace is staked
// now but whose UI lands in a later milestone (branches, tags, worktrees, stash, blame).
function PlaceholderPage({ title }: { readonly title: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground text-xs">
        Coming in a later milestone.
      </p>
    </div>
  );
}

// "/" → redirect to the most-recently-opened repository, or fall back to the shell's
// "Open a repository" empty state (D13). `recentList` is most-recent-first.
function Landing() {
  const recent = useRecentList();
  if (recent.isLoading) return null;
  const last = recent.data?.[0];
  if (last) return <Navigate to={`/repos/${last.repoId}`} replace />;
  return <App />;
}

// Layout route: mirror the matched repo/commit params into the store, then render the route.
function RootLayout() {
  return (
    <>
      <SyncRouteToStore />
      <Outlet />
    </>
  );
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: "/", element: <Landing /> },
      { path: "/repos/:repoId", element: <App /> },
      { path: "/repos/:repoId/commits/:oid", element: <App /> },
      // Future surfaces — URL namespace reserved now, UI to follow (D13).
      {
        path: "/repos/:repoId/branches/:name",
        element: <PlaceholderPage title="Branch history" />,
      },
      {
        path: "/repos/:repoId/tags/:name",
        element: <PlaceholderPage title="Tag history" />,
      },
      {
        path: "/repos/:repoId/worktrees/:id",
        element: <PlaceholderPage title="Worktree view" />,
      },
      {
        path: "/repos/:repoId/stash/:index",
        element: <PlaceholderPage title="Stash detail" />,
      },
      {
        path: "/repos/:repoId/blame/:rev/*",
        element: <PlaceholderPage title="File blame" />,
      },
    ],
  },
]);
