import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite 8 (Rolldown is the default bundler). Tailwind v4 via @tailwindcss/vite only
// (no PostCSS, no tailwind.config.js). React 19 via @vitejs/plugin-react.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
