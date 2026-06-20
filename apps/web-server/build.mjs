// Bundle the host service into a single Node-ESM-runnable file (DECISIONS D12; NF-PKG-1).
//
// The repo builds libraries with tsc under `module: Preserve` (extensionless relative
// imports, resolved by a bundler — REQ-STACK), so the workspace packages' emitted JS is
// NOT directly resolvable by Node's ESM loader. As the single deployable unit, the
// web-server is therefore bundled with esbuild: the workspace packages (@cbranch/core,
// @cbranch/rpc-contract) are inlined, while `effect` and `@effect/platform-node` stay
// external and resolve from node_modules at runtime (they ship Node-ready ESM).
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external: [
    "effect",
    "effect/*",
    "@effect/platform-node",
    "@effect/platform-node/*",
  ],
  logLevel: "warning",
});
