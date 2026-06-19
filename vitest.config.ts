import { defineConfig } from "vitest/config";

// Single root runner for the whole workspace. Node-environment logic tests live next to
// the source as `*.test.ts`; React component tests are `*.test.tsx` and opt into jsdom
// per-file via a `// @vitest-environment jsdom` docblock (mocked RPC, no live host —
// NF-TEST-7). End-to-end (Playwright) is wired in a later phase.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "apps/*/src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
