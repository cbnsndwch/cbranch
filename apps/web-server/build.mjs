// Bundle the host service into a single Node-ESM-runnable file (DECISIONS D12; NF-PKG-1).
//
// The repo builds libraries with tsc under `module: Preserve` (extensionless relative
// imports, resolved by a bundler — REQ-STACK), so the workspace packages' emitted JS is
// NOT directly resolvable by Node's ESM loader. As the single deployable unit, the
// web-server is therefore bundled with esbuild: the workspace packages (@cbranch/core,
// @cbranch/rpc-contract) are inlined, while `effect` and `@effect/platform-node` stay
// external and resolve from node_modules at runtime (they ship Node-ready ESM).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

await build({
    entryPoints: ['src/main.ts'],
    outfile: 'dist/main.js',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: true,
    external: [
        'effect',
        'effect/*',
        '@effect/platform-node',
        '@effect/platform-node/*',
    ],
    logLevel: 'warning',
});

// esbuild inlines JS imports but NOT a standalone `.mjs` asset that @cbranch/core
// resolves at runtime via `new URL("./shims/…", import.meta.url)`. The interactive-
// rebase sequence-editor shim (S8; REQ-P5-IR-008) must be physically copied next to
// the bundle so the bundled `import.meta.url` (→ dist/main.js) resolves `./shims/…`.
// Keep this in lockstep with `dev.mjs` and `defaultShimPath()` in packages/core.
copyRebaseShim();

function copyRebaseShim() {
    const src = fileURLToPath(
        new URL(
            '../../packages/core/src/git/shims/rebase-seq-editor.mjs',
            import.meta.url,
        ),
    );
    const dest = fileURLToPath(
        new URL('./dist/shims/rebase-seq-editor.mjs', import.meta.url),
    );
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    // A build-only marker: ONLY this esbuild step writes it (tsc never does), so the
    // packaged-shim test can distinguish a real bundle from a typecheck-only `dist/`.
    writeFileSync(
        fileURLToPath(new URL('./dist/.bundled', import.meta.url)),
        '',
    );
}
