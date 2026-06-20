// Framework-mode root route (React Router 8, SPA). This module replaces the old
// `index.html` + `main.tsx` pair:
//   • `Layout` is the HTML document shell RR renders the app into. Because `ssr: false`,
//     it is rendered once at build time into the static `index.html` and then hydrated.
//   • the default export is the root component: it wires the app-wide providers (the RPC
//     runtime + React Query) around the routed `<Outlet />`, and bridges URL → store.
//
// The single RPC runtime / React Query client are module-level singletons (one live host
// connection for the app's lifetime). The runtime is built lazily and never connects until
// an effect runs, so constructing it during the Node `index.html` render is harmless; the
// only browser-only access (`window.location`) is guarded.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import type { Route } from "./+types/root";
import { makeApi } from "./rpc/api";
import { ApiProvider } from "./rpc/ApiProvider";
import { defaultRpcUrl, makeAppRuntime } from "./rpc/client";
import { SyncRouteToStore } from "./state/SyncRouteToStore";

import appStyles from "./styles.css?url";
import diffStyles from "react-diff-view/style/index.css?url";

// Stylesheets are linked (not side-effect imported) so RR can inject them into the
// document `<head>` via `<Links />` and code-split them per route in the future.
export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: diffStyles },
  { rel: "stylesheet", href: appStyles },
];

// The RPC URL is derived from the page origin; fall back to a placeholder during the
// Node `index.html` render (no `window`). The placeholder is never dialled — the runtime
// only connects in the browser, after hydration, when the first effect runs.
const rpcUrl =
  typeof window === "undefined"
    ? "ws://localhost/rpc"
    : defaultRpcUrl(window.location);

// One app runtime owns the live RPC connection; one React Query client owns synced data.
const runtime = makeAppRuntime(rpcUrl);
const api = makeApi(runtime);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: true },
  },
});

export function Layout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>cbranch</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={api}>
        <SyncRouteToStore />
        <Outlet />
      </ApiProvider>
    </QueryClientProvider>
  );
}
