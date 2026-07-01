import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

// The interactive-rebase sequence-editor shim (S8; REQ-P5-IR-008) is a standalone
// `.mjs` asset that @cbranch/core resolves at runtime via `import.meta.url`. esbuild
// does NOT bundle it, so `build.mjs`/`dev.mjs` physically copy it next to the bundle.
// That packaging break escapes lint/typecheck/build/vitest (which all exercise the
// source-tree shim), so assert the packaged copy is present.
//
// Guarded on `dist/.bundled` — a marker ONLY the esbuild build step writes (NOT tsc), so
// the test asserts in the CI gate (build precedes test) but truly skips on a typecheck-
// only tree. (Keying on dist/main.js would fail spuriously: `tsc -b` emits that too.)
describe('packaged web-server bundle', () => {
    const marker = fileURLToPath(new URL('../dist/.bundled', import.meta.url));
    const shim = fileURLToPath(
        new URL('../dist/shims/rebase-seq-editor.mjs', import.meta.url),
    );

    test.runIf(existsSync(marker))(
        'ships the rebase sequence-editor shim next to dist/main.js',
        () => {
            expect(existsSync(shim)).toBe(true);
        },
    );
});
