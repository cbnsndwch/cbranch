import type { Config } from "@react-router/dev/config";

// React Router 8 in FRAMEWORK mode, configured as a pure client-side SPA:
//   • ssr: false        → no server rendering; the build emits a static client bundle
//                         plus a single `index.html` shell that hydrates in the browser.
//   • prerender: false  → prerender NOTHING. No routes are crawled/rendered at build time;
//                         every path is served by the SPA fallback and rendered client-side.
//   • appDirectory: src → keep the existing `src/` layout instead of the default `app/`.
//
// Output lands in `build/client/` (framework-mode default; previously `dist/`). The host
// service serves it via `CBRANCH_CLIENT_DIR=packages/ui/build/client` (see RUNNING.md).
export default {
  ssr: false,
  prerender: false,
  appDirectory: "src",
} satisfies Config;
