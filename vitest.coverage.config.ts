import { defineConfig } from "vitest/config";

// Coverage gate for NF-TEST-11: 80% line + branch coverage on the two logic packages.
// Per-package thresholds live in packages/{core,rpc-contract}/vitest.config.ts so each
// package's floor is independently configurable; this root config enforces the combined
// gate in CI via `pnpm coverage`.
export default defineConfig({
  test: {
    include: ["packages/core/src/**/*.test.ts", "packages/rpc-contract/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["packages/core/src/**/*.ts", "packages/rpc-contract/src/**/*.ts"],
      exclude: [
        // test files
        "packages/*/src/**/*.test.ts",
        // barrel re-export files — v8 under-reports ESM re-exports; logic lives in the
        // modules being re-exported and is measured there
        "packages/*/src/index.ts",
      ],
      reporter: ["text"],
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
