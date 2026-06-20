import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { router } from "./router";
import { makeApi } from "./rpc/api";
import { ApiProvider } from "./rpc/ApiProvider";
import { defaultRpcUrl, makeAppRuntime } from "./rpc/client";
import { applyStoredTheme } from "./theme/theme";

import "react-diff-view/style/index.css";
import "./styles.css";

// Apply the persisted theme before first paint (NF-THEME-6, no flash).
applyStoredTheme();

// One app runtime owns the live RPC connection; one React Query client owns synced data.
const runtime = makeAppRuntime(defaultRpcUrl(window.location));
const api = makeApi(runtime);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: false, refetchOnWindowFocus: true },
  },
});

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ApiProvider api={api}>
          <RouterProvider router={router} />
        </ApiProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
