import { defineConfig } from "vitest/config";

// Single root runner for the whole workspace. Trivial P0 tests live next to the
// source as `*.test.ts` and run in the Node environment (no DOM needed yet).
// Component tests (jsdom) and e2e (Playwright) are wired in later phases.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    environment: "node",
  },
});
