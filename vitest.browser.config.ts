import { fileURLToPath } from 'node:url';

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Browser-mode runner (Vitest + @vitest/browser on Playwright). This is the ONLY
// suite that renders components in a real Chromium: jsdom has no layout engine, so
// geometry-gated Base UI interactions (notably committing a `Select` value) can never
// fire there. Kept as a SEPARATE config — mirroring `vitest.coverage.config.ts` — so
// the fast node/jsdom suite (`vitest.config.ts`) is untouched and browser tests run
// only via `pnpm test:browser`.
//
// Browser specs are named `*.browser.test.tsx` (excluded from the node runner). No
// React/Tailwind Vite plugins: esbuild transforms TSX via tsconfig `jsx`, exactly as
// the jsdom suite already relies on, and real layout comes from the browser, not CSS.
export default defineConfig({
    resolve: {
        // Same `@/* → packages/ui/src` alias as the root runner (shadcn base-lyra).
        alias: {
            '@': fileURLToPath(new URL('./packages/ui/src', import.meta.url)),
        },
        // React Flow is prebundled for real-browser tests; force it to share the
        // renderer's React singleton rather than loading a second copy.
        dedupe: ['react', 'react-dom'],
    },
    test: {
        include: ['packages/ui/src/**/*.browser.test.tsx'],
        testTimeout: 15_000,
        // Serialize browser specs: parallel Chromium contexts race over shared
        // portals/resources and flake (a file passes alone but fails in the pack).
        fileParallelism: false,
        browser: {
            enabled: true,
            // Vitest 4 takes a provider FACTORY (not the string 'playwright').
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
        },
    },
});
