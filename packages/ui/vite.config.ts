import { fileURLToPath } from "node:url";

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { reactRouterDevTools } from "react-router-devtools";
import { defineConfig } from "vite";

// Vite 8 (Rolldown is the default bundler) driving React Router 8 in framework mode.
// `reactRouter()` owns the React/JSX pipeline here — `@vitejs/plugin-react` is NOT used
// (it would double-transform). SPA-only behaviour is set in `react-router.config.ts`.
//
// `reactRouterDevTools()` MUST come before `reactRouter()`. In dev it augments the JSX
// transform so every rendered element carries its source location — inspect any tag in
// the browser and you see the originating file and line — and mounts the in-app dev panel.
export default defineConfig({
  plugins: [reactRouterDevTools(), reactRouter(), tailwindcss()],
  // `@/*` → src is the shadcn `base-lyra` import alias (components.json); keep it in sync
  // with tsconfig `paths` and the root vitest config so vendored/generated UI resolves.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // In dev the UI runs on Vite's port (:5173) while the backend occupies :7420.
    // Proxy /rpc (WebSocket) and /sidechannel (HTTP) to the backend so the client's
    // `defaultRpcUrl(window.location)` resolves correctly without any source change.
    // The backend's Origin allowlist checks hostnames only (port-stripped), so
    // `Origin: http://localhost:5173` passes as `localhost` — always in the allowlist.
    proxy: {
      "/rpc": {
        target: "ws://localhost:7420",
        ws: true,
        changeOrigin: true,
      },
      "/sidechannel": {
        target: "http://localhost:7420",
        changeOrigin: true,
      },
    },
  },
  build: {
    // REQ-STACK-011: emit source maps + tree-shake (tree-shaking is on by default
    // for production builds).
    sourcemap: true,
    rollupOptions: {
      output: {
        // Manual code splitting via Rolldown's `output.codeSplitting` with the
        // `groups[]` form (REQ-STACK-011) — NOT the deprecated `advancedChunks`
        // and NOT Rollup's `manualChunks`. Verified against rolldown 1.0.3
        // (bundled by vite 8.0.16): `codeSplitting` is current; `groups` takes
        // `CodeSplittingGroup[]` ({ name, test, priority, ... }).
        //
        // The heavy on-demand surfaces (Shiki grammars, the CodeMirror editor)
        // get their own chunks so they stay out of the initial bundle and load via
        // dynamic import(). Those libs are not installed until P1, so these groups
        // are STUBS whose `test` regexes start matching once the deps land.
        codeSplitting: {
          groups: [
            {
              name: "shiki",
              test: /[\\/]node_modules[\\/](?:shiki|@shikijs)[\\/]/,
              priority: 30,
            },
            {
              name: "codemirror",
              test: /[\\/]node_modules[\\/](?:@?codemirror|@shikijs[\\/]codemirror)[\\/]/,
              priority: 30,
            },
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
});
